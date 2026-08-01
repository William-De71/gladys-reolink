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
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { cameraIds, parsePlatformId, deviceHasCapability } from '../devices.js';
import { aiStateOf, aiTypesOf } from './capabilities.js';
import {
  FEATURE_SUFFIXES,
  CAPABILITIES,
  DETECTION_RESET_MS,
  DEFAULT_CHANNEL,
} from './constants.js';

/**
 * The detections read on every round, and the feature each one publishes.
 *
 * Motion has no capability gate: every Reolink camera answers `GetMdState`.
 */
const DETECTIONS = [
  { capability: null, suffix: FEATURE_SUFFIXES.MOTION, key: 'motion' },
  { capability: CAPABILITIES.AI_PEOPLE, suffix: FEATURE_SUFFIXES.AI_PEOPLE, key: 'people' },
  { capability: CAPABILITIES.AI_VEHICLE, suffix: FEATURE_SUFFIXES.AI_VEHICLE, key: 'vehicle' },
  { capability: CAPABILITIES.AI_ANIMAL, suffix: FEATURE_SUFFIXES.AI_ANIMAL, key: 'animal' },
];

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
   */
  constructor({ gladys, batteryGuard, onDetection, sessions }) {
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
    // The sessions are NOT closed here: the pool is shared with the capture and
    // the actuators, which keep working after the watcher stops. Whoever owns
    // the pool closes it on shutdown.
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

    const states = await this.readStates(device, client);
    if (!states) {
      return;
    }

    const ids = cameraIds(this.gladys, platformId);

    if (states.battery) {
      await this.publishBattery(device, ids, states.battery);
    }

    for (const detection of DETECTIONS) {
      if (detection.capability && !deviceHasCapability(device, detection.capability)) {
        continue;
      }
      await this.publishDetection(device, ids.feature(detection.suffix), states[detection.key], {
        kind: detection.key,
      });
    }

    if (deviceHasCapability(device, CAPABILITIES.DOORBELL)) {
      await this.publishDetection(device, ids.feature(FEATURE_SUFFIXES.DOORBELL), states.doorbell, {
        kind: 'doorbell',
        // A push button has no "released" state to report: Gladys treats every
        // published 1 as one press, so the reset would count as a second one.
        resets: false,
      });
    }
  }

  /**
   * Read everything a camera has to say, in one batch.
   * @param {object} device - The Gladys device.
   * @param {object} client - `{ api, camera }`.
   * @returns {Promise<object|null>} The states, or null when unreadable.
   * @example
   * const states = await watcher.readStates(device, client);
   */
  async readStates(device, client) {
    const commands = [
      { cmd: 'GetMdState', action: 0, param: { channel: DEFAULT_CHANNEL } },
      { cmd: 'GetAiState', action: 0, param: { channel: DEFAULT_CHANNEL } },
    ];
    if (deviceHasCapability(device, CAPABILITIES.BATTERY)) {
      commands.push({ cmd: 'GetBatteryInfo', action: 0, param: { channel: DEFAULT_CHANNEL } });
    }
    if (deviceHasCapability(device, CAPABILITIES.DOORBELL)) {
      commands.push({ cmd: 'GetAlarm', action: 0, param: { channel: DEFAULT_CHANNEL } });
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

    const featureId = ids.feature(FEATURE_SUFFIXES.BATTERY);
    // A battery moves slowly: publishing an unchanged percentage every round
    // would add a point per poll to the history for no information.
    if (this.published.get(featureId) === level) {
      return;
    }
    this.published.set(featureId, level);
    await this.gladys
      .publishState(featureId, level)
      .catch((e) => logger.debug(`Publishing the battery level failed: ${e.message}`));
  }

  /**
   * Publish a detection, but only when it changed.
   * @param {object} device - The Gladys device.
   * @param {string} featureId - The feature external id.
   * @param {boolean} detected - Whether the detection is currently firing.
   * @param {object} options - How to treat it.
   * @param {string} options.kind - What it is, for the logs and the callback.
   * @param {boolean} [options.resets] - Whether it must come back down.
   * @returns {Promise<void>} Resolves once published.
   * @example
   * await watcher.publishDetection(device, featureId, true, { kind: 'motion' });
   */
  async publishDetection(device, featureId, detected, { kind, resets = true }) {
    const previous = this.published.get(featureId);
    const value = detected ? 1 : 0;

    if (previous === value) {
      if (detected && resets) {
        // Still firing: push the reset back rather than let it fire mid-detection.
        this.scheduleReset(featureId);
      }
      return;
    }

    // The very first round establishes the baseline. Publishing a 0 there is
    // harmless, but publishing a 1 would fire the scenes of a detection that
    // started before Gladys was even watching.
    const isFirstRound = previous === undefined;
    if (isFirstRound && detected) {
      this.published.set(featureId, value);
      if (resets) {
        this.scheduleReset(featureId);
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
      this.scheduleReset(featureId);
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
   * @example
   * watcher.scheduleReset(featureId);
   */
  scheduleReset(featureId) {
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
    }, DETECTION_RESET_MS);
    this.resets.set(featureId, timer);
  }
}
