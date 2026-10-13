// -----------------------------------------------------------------------------
// Motion, AI detections, doorbell and battery.
//
// Reolink cameras report their CURRENT state rather than an event log: a poll
// answers "is motion firing right now", not "what happened since last time".
// That shapes everything here:
//
//   - a detection that starts and ends between two polls is invisible. The poll
//     interval is therefore the real detection latency, and it is configurable
//     for that reason;
//   - a state read as 1 has to be brought back to 0 by us when the camera stops
//     reporting it. Publishing only the rising edge would leave the sensor stuck
//     "detecting" forever in Gladys;
//   - only CHANGES are published. Re-publishing 1 on every round while a car
//     stays parked in frame would fill the history with noise and re-trigger
//     scenes at each poll.
//
// Everything is read in ONE batch per camera. On a battery model each request
// wakes the radio, so three separate reads would cost three wakeups per round.
//
// A wired camera reached directly can do better: over ONVIF it PUSHES its
// detections the moment they start and end (see onvif.js). While that stream is
// healthy the polled read stands down for the camera; the moment it fails, the
// poll takes over again on its own, so a camera is never left unwatched.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { cameraIds, parsePlatformId, deviceHasCapability, getParam } from '../devices.js';
import { aiStateOf, aiTypesOf } from './capabilities.js';
import { readSleepStates } from './channels.js';
import { ReolinkOnvif } from './onvif.js';
import { resolveAccount } from '../config.js';
import {
  FEATURE_SUFFIXES,
  CAPABILITIES,
  DETECTION_RESET_MS,
  ONVIF_DETECTION_RESET_MS,
  DEFAULT_CHANNEL,
  DEVICE_PARAMS,
  CHARGE_STATUS,
} from './constants.js';

/**
 * The detections, and the feature each one publishes. The `key` is both the
 * field `readStates` fills and the kind an ONVIF event is classified as, so the
 * two paths publish through the very same table.
 *
 * Motion has no capability gate: every Reolink camera answers `GetMdState`.
 */
const DETECTIONS = [
  { capability: null, suffix: FEATURE_SUFFIXES.MOTION, key: 'motion' },
  { capability: CAPABILITIES.AI_PEOPLE, suffix: FEATURE_SUFFIXES.AI_PEOPLE, key: 'people' },
  { capability: CAPABILITIES.AI_VEHICLE, suffix: FEATURE_SUFFIXES.AI_VEHICLE, key: 'vehicle' },
  { capability: CAPABILITIES.AI_ANIMAL, suffix: FEATURE_SUFFIXES.AI_ANIMAL, key: 'animal' },
  { capability: CAPABILITIES.DOORBELL, suffix: FEATURE_SUFFIXES.DOORBELL, key: 'doorbell' },
];

/**
 * Tell whether a device may take its detections from ONVIF.
 * @param {object} device - The Gladys device.
 * @param {object|null} config - The normalized configuration.
 * @returns {boolean} True when the device has an ONVIF server worth using.
 * @example
 * onvifEligible(device, config);
 */
export function onvifEligible(device, config) {
  if (!config || config.onvif_events === false) {
    return false;
  }
  const port = Number(getParam(device, DEVICE_PARAMS.ONVIF_PORT));
  return (
    Number.isInteger(port) &&
    port > 0 &&
    Boolean(getParam(device, DEVICE_PARAMS.IP)) &&
    !deviceHasCapability(device, CAPABILITIES.BATTERY)
  );
}

/**
 * Read the doorbell press out of a `GetAlarm`-style answer.
 *
 * The `visitor` item only exists on doorbell models, and only once the firmware
 * has recorded at least one press — an absent item is "no press", not an error.
 * @param {object|null} alarmValue - The `GetAlarm` value.
 * @returns {boolean} True when a press is currently reported.
 * @example
 * parseVisitorState({ visitor: { support: 1, alarm_state: 1 } }); // true
 */
export function parseVisitorState(alarmValue) {
  const visitor = alarmValue?.visitor;
  if (!visitor) {
    return false;
  }
  return Number(visitor.support) === 1 && Number(visitor.alarm_state) === 1;
}

/**
 * Read the motion state out of a `GetMdState` answer.
 * @param {object|null} value - The `GetMdState` value.
 * @returns {boolean} True when motion is currently reported.
 * @example
 * parseMotionState({ state: 1 }); // true
 */
export function parseMotionState(value) {
  return Number(value?.state) === 1;
}

/**
 * Watches the cameras and publishes what changed.
 * @example
 * const watcher = new EventWatcher({ gladys, batteryGuard });
 * watcher.start(config);
 */
export class EventWatcher {
  /**
   * @param {object} options - The dependencies.
   * @param {object} options.gladys - The SDK instance.
   * @param {object} [options.batteryGuard] - Shared with the capture side.
   * @param {(device: object, kind: string) => Promise<void>} [options.onDetection] -
   * Called when a detection starts, to push a fresh image.
   * @param {object} options.sessions - The shared session pool. A camera only
   * accepts a handful of sessions, so the watcher borrows the same client the
   * capture and the actuators use rather than opening its own.
   * @param {(options: object) => object} [options.createOnvifClient] - Builds
   * the ONVIF client of one camera; replaced in the tests.
   */
  constructor({
    gladys,
    batteryGuard,
    onDetection,
    sessions,
    createOnvifClient = (options) => new ReolinkOnvif(options),
  }) {
    this.createOnvifClient = createOnvifClient;
    this.gladys = gladys;
    this.batteryGuard = batteryGuard;
    this.onDetection = onDetection;
    this.sessions = sessions;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** Last published state per feature external id, to only publish changes. */
    this.published = new Map();
    /** Pending resets, per feature external id. */
    this.resets = new Map();
    this.config = null;
    this.running = false;
    /**
     * One ONVIF client per device external id, with the fingerprint of what it
     * was opened with, so a changed address or password reopens it.
     * @type {Map<string, { client: object, key: string }>}
     */
    this.onvif = new Map();
  }

  /**
   * Start (or restart) the polling loop.
   * @param {object} config - The normalized configuration.
   * @example
   * watcher.start(config);
   */
  start(config) {
    this.stop();
    this.config = config;
    // `unref` would let the process exit mid-tick; the shutdown handler stops it.
    this.timer = setInterval(() => {
      this.tick().catch((e) => logger.debug(`Reolink event check failed: ${e.message}`));
    }, config.event_poll_interval * 1000);
    // Right away rather than at the first tick: a wired camera then reports
    // its detections instantly from the start, not one interval later.
    this.syncOnvif(this.gladys.devices || []);
    logger.info(`Watching the Reolink events every ${config.event_poll_interval}s`);
  }

  /**
   * Stop the polling loop, cancel the pending resets and close the sessions.
   * @example
   * watcher.stop();
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.resets.forEach((timer) => clearTimeout(timer));
    this.resets.clear();
    this.onvif.forEach(({ client }) => client.stop());
    this.onvif.clear();
    // The sessions are NOT closed here: the pool is shared with the capture and
    // the actuators, which keep working after the watcher stops. Whoever owns
    // the pool closes it on shutdown.
  }

  /**
   * Forget what was published for one camera, so its next check publishes its
   * battery and detections again instead of judging them unchanged.
   *
   * Needed when the user (re)creates the device: Gladys drops the states sent
   * before a feature exists, so what this watcher remembers as published never
   * reached it.
   * @param {string} deviceExternalId - The device external id.
   * @example
   * watcher.forgetDevice(device.external_id);
   */
  forgetDevice(deviceExternalId) {
    const prefix = `${deviceExternalId}:`;
    [...this.published.keys()]
      .filter((featureId) => featureId.startsWith(prefix))
      .forEach((featureId) => {
        this.published.delete(featureId);
        clearTimeout(this.resets.get(featureId));
        this.resets.delete(featureId);
      });
  }

  /**
   * The API client of one device, opened once and reused.
   * @param {object} device - The Gladys device.
   * @returns {object|null} `{ api, camera }`, or null when unreachable.
   * @example
   * const client = watcher.clientOf(device);
   */
  clientOf(device) {
    return this.sessions.for(device, this.config);
  }

  /**
   * Run one check. Overlapping ticks are skipped: a slow camera must not pile up
   * concurrent runs that would each publish the same detection.
   * @returns {Promise<void>} Resolves once the tick is done.
   * @example
   * await watcher.tick();
   */
  async tick() {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      const devices = this.gladys.devices || [];
      // Each round reconciles the ONVIF streams with the devices: one added
      // since gets its stream, one deleted has its subscription released.
      this.syncOnvif(devices);
      // Before anything else: which cameras behind a hub are asleep. One command
      // per hub answers for all of them, and it is what keeps the rest of this
      // round from waking a battery camera to ask it questions its hub could
      // have answered.
      await this.refreshSleepStates(devices);
      // Cameras are checked together: one slow camera would otherwise delay
      // every other one, and the round would outlast its own interval.
      await Promise.all(
        devices.map((device) =>
          this.checkDevice(device).catch((e) =>
            logger.debug(`Event check failed for "${device.name}": ${e.message}`),
          ),
        ),
      );
    } finally {
      this.running = false;
    }
  }

  /**
   * Open, keep or close the ONVIF stream of every device.
   * @param {object[]} devices - The Gladys devices.
   * @example
   * watcher.syncOnvif(gladys.devices);
   */
  syncOnvif(devices) {
    const wanted = new Set();
    devices.forEach((device) => {
      if (!parsePlatformId(device.external_id) || !onvifEligible(device, this.config)) {
        return;
      }
      const ip = getParam(device, DEVICE_PARAMS.IP);
      const port = Number(getParam(device, DEVICE_PARAMS.ONVIF_PORT));
      const account = resolveAccount(this.config, ip);
      const key = JSON.stringify([ip, port, account.username, account.password]);
      wanted.add(device.external_id);

      const held = this.onvif.get(device.external_id);
      if (held && held.key === key) {
        return;
      }
      held?.client.stop();
      const client = this.createOnvifClient({
        ip,
        port,
        username: account.username,
        password: account.password,
        name: device.name,
      });
      this.onvif.set(device.external_id, { client, key });
      client.start((event) =>
        this.handleOnvifEvent(device.external_id, event).catch((e) =>
          logger.debug(`Handling an ONVIF event of "${device.name}" failed: ${e.message}`),
        ),
      );
    });

    [...this.onvif.entries()]
      .filter(([externalId]) => !wanted.has(externalId))
      .forEach(([externalId, { client }]) => {
        client.stop();
        this.onvif.delete(externalId);
      });
  }

  /**
   * Tell whether a device currently gets its detections pushed over ONVIF.
   * @param {string} externalId - The device external id.
   * @returns {boolean} True while its stream is healthy.
   * @example
   * watcher.isOnvifLive(device.external_id);
   */
  isOnvifLive(externalId) {
    return Boolean(this.onvif.get(externalId)?.client.isLive());
  }

  /**
   * Publish one detection pushed by a camera.
   * @param {string} externalId - The device external id.
   * @param {{ kind: string, active: boolean, initial: boolean }} event - The event.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.handleOnvifEvent(device.external_id, { kind: 'motion', active: true });
   */
  async handleOnvifEvent(externalId, event) {
    // Looked up at event time: the device may have been renamed or re-published
    // since the stream was opened.
    const device = (this.gladys.devices || []).find((entry) => entry.external_id === externalId);
    const platformId = device && parsePlatformId(device.external_id);
    const detection = DETECTIONS.find((entry) => entry.key === event.kind);
    if (!platformId || !detection) {
      return;
    }
    if (detection.capability && !deviceHasCapability(device, detection.capability)) {
      return;
    }
    const ids = cameraIds(this.gladys, platformId);
    await this.publishDetection(device, ids.feature(detection.suffix), event.active, {
      kind: event.kind,
      // An ONVIF message IS a change, unlike a polled state: a detection that
      // starts before the first poll must still fire. Only the snapshot a
      // camera sends right after subscribing describes a past state.
      edge: !event.initial,
      resetMs: ONVIF_DETECTION_RESET_MS,
    });
  }

  /**
   * Ask each hub which of its cameras are asleep, and tell the guard.
   *
   * Grouped by address: a hub answers for ALL its cameras in one command, so
   * five devices cost one request. Devices reached directly are skipped
   * entirely — they have no hub to answer for them, and asking would wake the
   * very camera this is meant to leave alone.
   * @param {object[]} devices - The Gladys devices.
   * @returns {Promise<void>} Resolves once the guard is up to date.
   * @example
   * await watcher.refreshSleepStates(gladys.devices);
   */
  async refreshSleepStates(devices) {
    if (!this.batteryGuard) {
      return;
    }

    /** @type {Map<string, object[]>} Devices sharing one address. */
    const hosts = new Map();
    devices.forEach((device) => {
      if (!parsePlatformId(device.external_id)) {
        return;
      }
      const ip = getParam(device, DEVICE_PARAMS.IP);
      // A device on channel 0 alone at its address is a direct camera: there is
      // no hub there to answer for it.
      if (!ip) {
        return;
      }
      const group = hosts.get(ip);
      if (group) {
        group.push(device);
      } else {
        hosts.set(ip, [device]);
      }
    });

    await Promise.all(
      [...hosts.values()]
        .filter(
          (group) => group.length > 1 || Number(getParam(group[0], DEVICE_PARAMS.CHANNEL)) > 0,
        )
        .map(async (group) => {
          const client = this.clientOf(group[0]);
          if (!client) {
            return;
          }
          const states = await readSleepStates(client.api);
          group.forEach((device) => {
            const channel = Number(getParam(device, DEVICE_PARAMS.CHANNEL)) || 0;
            const asleep = states.get(channel);
            if (asleep !== undefined) {
              this.batteryGuard.setSleeping(device.external_id, asleep);
            }
          });
        }),
    );
  }

  /**
   * Check one camera and publish what changed.
   * @param {object} device - The Gladys device.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.checkDevice(device);
   */
  async checkDevice(device) {
    const platformId = parsePlatformId(device.external_id);
    const client = this.clientOf(device);
    if (!platformId || !client) {
      return;
    }

    // A sleeping camera is left alone: its hub already told us it has nothing
    // new to say, and every command here would wake its radio for nothing.
    if (this.batteryGuard?.isSleeping(device.external_id)) {
      return;
    }

    // Pushed over ONVIF: nothing left to poll on a camera without a battery,
    // and the detections must not be published twice from two clocks.
    const pushed = this.isOnvifLive(device.external_id);
    if (pushed && !deviceHasCapability(device, CAPABILITIES.BATTERY)) {
      return;
    }

    const states = await this.readStates(device, client, { detections: !pushed });
    if (!states) {
      return;
    }

    const ids = cameraIds(this.gladys, platformId);

    if (states.battery) {
      await this.publishBattery(device, ids, states.battery);
    }
    if (pushed) {
      return;
    }

    for (const detection of DETECTIONS) {
      if (detection.capability && !deviceHasCapability(device, detection.capability)) {
        continue;
      }
      // The doorbell is a 1 -> 0 pulse like the others (`doorbell/ring`): its
      // reset is what lets the dashboard go from "Ringing" back to the time of
      // the last ring.
      await this.publishDetection(device, ids.feature(detection.suffix), states[detection.key], {
        kind: detection.key,
      });
    }
  }

  /**
   * Read everything a camera has to say, in one batch.
   * @param {object} device - The Gladys device.
   * @param {object} client - `{ api, camera }`.
   * @param {object} [options] - What to read.
   * @param {boolean} [options.detections] - False to read the battery only.
   * @returns {Promise<object|null>} The states, or null when unreadable.
   * @example
   * const states = await watcher.readStates(device, client);
   */
  async readStates(device, client, { detections = true } = {}) {
    // The channel of THIS camera, never a constant: behind a hub the same
    // address answers for every camera, and a wrong channel silently returns the
    // state of another one — five cameras all reporting the motion of the first.
    const channel = client.camera.channel ?? DEFAULT_CHANNEL;

    const commands = [];
    if (detections) {
      commands.push(
        { cmd: 'GetMdState', action: 0, param: { channel } },
        { cmd: 'GetAiState', action: 0, param: { channel } },
      );
    }
    if (deviceHasCapability(device, CAPABILITIES.BATTERY)) {
      commands.push({ cmd: 'GetBatteryInfo', action: 0, param: { channel } });
    }
    if (detections && deviceHasCapability(device, CAPABILITIES.DOORBELL)) {
      commands.push({ cmd: 'GetAlarm', action: 0, param: { channel } });
    }
    if (commands.length === 0) {
      return null;
    }

    let answers;
    try {
      answers = await client.api.sendBatch(commands);
    } catch (e) {
      logger.debug(`Reading the state of "${device.name}" failed: ${e.message}`);
      // The session may be the problem, so the client is dropped: the next round
      // builds a fresh one rather than reusing a token the camera forgot.
      this.sessions.drop(device);
      return null;
    }

    /**
     * Find the answer of one command in the batch.
     * @param {string} cmd - The command name.
     * @returns {object|null} Its `value`, or null when it failed.
     */
    const valueOf = (cmd) => {
      const answer = answers.find((entry) => entry?.cmd === cmd);
      return Number(answer?.code) === 0 ? (answer?.value ?? null) : null;
    };

    const aiState = valueOf('GetAiState');
    const battery = valueOf('GetBatteryInfo')?.Battery ?? null;

    return {
      motion: parseMotionState(valueOf('GetMdState')),
      // The firmware names the animal detection either `dog_cat` or `animal`,
      // never both, so whichever it answers with counts.
      people: aiTypesOf(CAPABILITIES.AI_PEOPLE).some((type) => aiStateOf(aiState, type)),
      vehicle: aiTypesOf(CAPABILITIES.AI_VEHICLE).some((type) => aiStateOf(aiState, type)),
      animal: aiTypesOf(CAPABILITIES.AI_ANIMAL).some((type) => aiStateOf(aiState, type)),
      doorbell: parseVisitorState(valueOf('GetAlarm')),
      battery,
    };
  }

  /**
   * Publish the battery level and feed the guard.
   * @param {object} device - The Gladys device.
   * @param {object} ids - The external id factory of this camera.
   * @param {object} battery - The `Battery` block.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.publishBattery(device, ids, battery);
   */
  async publishBattery(device, ids, battery) {
    const level = Number(battery.batteryPercent);
    if (!Number.isFinite(level)) {
      return;
    }

    if (this.batteryGuard) {
      // Feed the guard first: it decides whether captures may run at all, and
      // this reading is what lets it release a recovering camera.
      this.batteryGuard.update(
        device.external_id,
        { level, chargeStatus: battery.chargeStatus },
        device.name,
      );
    }

    // A battery moves slowly: publishing an unchanged percentage every round
    // would add a point per poll to the history for no information.
    await this.publishChanged(ids.feature(FEATURE_SUFFIXES.BATTERY), level, 'battery level');

    // Only `charging` counts here, unlike the guard: a camera that sits full on
    // its charger (`chargeComplete`) is no longer being recharged, which is what
    // Gladys means by this feature. Published only to a device that has the
    // feature: a camera created before it existed would get refused states.
    const chargingId = ids.feature(FEATURE_SUFFIXES.BATTERY_CHARGING);
    const status = battery.chargeStatus;
    const hasFeature = (device.features || []).some((entry) => entry.external_id === chargingId);
    if (hasFeature && status !== undefined && status !== null && Number.isFinite(Number(status))) {
      const charging = Number(status) === CHARGE_STATUS.CHARGING ? 1 : 0;
      await this.publishChanged(chargingId, charging, 'charging state');
    }
  }

  /**
   * Publish a value only when it differs from the last one published.
   * @param {string} featureId - The feature external id.
   * @param {number} value - The value.
   * @param {string} what - What it is, for the logs.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.publishChanged(featureId, 80, 'battery level');
   */
  async publishChanged(featureId, value, what) {
    if (this.published.get(featureId) === value) {
      return;
    }
    this.published.set(featureId, value);
    await this.gladys
      .publishState(featureId, value)
      .catch((e) => logger.debug(`Publishing the ${what} failed: ${e.message}`));
  }

  /**
   * Publish a detection, but only when it changed.
   * @param {object} device - The Gladys device.
   * @param {string} featureId - The feature external id.
   * @param {boolean} detected - Whether the detection is currently firing.
   * @param {object} options - How to treat it.
   * @param {string} options.kind - What it is, for the logs and the callback.
   * @param {boolean} [options.resets] - Whether it must come back down.
   * @param {boolean} [options.edge] - The value is a CHANGE reported by the
   * camera, not a state read: it is published even before any baseline.
   * @param {number} [options.resetMs] - How long before forcing it back down.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.publishDetection(device, featureId, true, { kind: 'motion' });
   */
  async publishDetection(
    device,
    featureId,
    detected,
    { kind, resets = true, edge = false, resetMs = DETECTION_RESET_MS },
  ) {
    const previous = this.published.get(featureId);
    const value = detected ? 1 : 0;

    if (previous === value) {
      if (detected && resets) {
        // Still firing: push the reset back rather than let it fire mid-detection.
        this.scheduleReset(featureId, resetMs);
      }
      return;
    }

    // The very first round establishes the baseline. Publishing a 0 there is
    // harmless, but publishing a 1 would fire the scenes of a detection that
    // started before Gladys was even watching.
    const isFirstRound = previous === undefined;
    if (isFirstRound && detected && !edge) {
      this.published.set(featureId, value);
      if (resets) {
        this.scheduleReset(featureId, resetMs);
      }
      return;
    }

    this.published.set(featureId, value);
    await this.gladys
      .publishState(featureId, value)
      .catch((e) => logger.debug(`Publishing the ${kind} state failed: ${e.message}`));

    if (!detected) {
      return;
    }

    logger.info(`${kind} detected on "${device.name}"`);
    if (resets) {
      this.scheduleReset(featureId, resetMs);
    }
    if (this.onDetection) {
      // Best effort: a failed capture must not lose the detection itself.
      await this.onDetection(device, kind).catch((e) =>
        logger.debug(`Capturing the image after a ${kind} detection failed: ${e.message}`),
      );
    }
  }

  /**
   * Bring a detection back to 0 when the camera stops reporting it.
   *
   * The camera reports the CURRENT state, so a detection that ends is normally
   * seen as a 0 on the next round. This timer covers the case where it is not:
   * a camera that goes unreachable, or a firmware that latches its flag, would
   * otherwise leave the sensor triggered indefinitely.
   * @param {string} featureId - The feature external id.
   * @param {number} [delayMs] - How long before the reset.
   * @example
   * watcher.scheduleReset(featureId);
   */
  scheduleReset(featureId, delayMs = DETECTION_RESET_MS) {
    const pending = this.resets.get(featureId);
    if (pending) {
      clearTimeout(pending);
    }
    const timer = setTimeout(async () => {
      this.resets.delete(featureId);
      if (this.published.get(featureId) !== 1) {
        return;
      }
      this.published.set(featureId, 0);
      await this.gladys
        .publishState(featureId, 0)
        .catch((e) => logger.debug(`Resetting the detection failed: ${e.message}`));
    }, delayMs);
    this.resets.set(featureId, timer);
  }
}
