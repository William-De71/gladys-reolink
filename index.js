// -----------------------------------------------------------------------------
// Entry point of the Reolink external integration.
//
// Role of this file: wire the SDK to the discovery, the capture, the event
// watcher and the actuators.
//
// Everything here happens on the LOCAL network — there is no Reolink cloud
// account involved, which is why the manifest declares only the `local`
// transport. A camera is reached directly, over its documented HTTP API.
//
// The image reaches Gladys three ways, and all three are needed:
//   - `onGetImage`, when the dashboard live view or the chat asks for a fresh
//     frame;
//   - `onPoll` and the refresh loop, which PUSH an image, because the dashboard
//     widget displays the last published one rather than requesting a new one;
//   - a detection, so the image is already there when the user opens the
//     notification.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { normalizeConfig, isConfigured } from './src/config.js';
import {
  buildDiscoveredDevices,
  deviceHasCapability,
  getParam,
  cameraIds,
  parsePlatformId,
} from './src/devices.js';
import { captureImage } from './src/reolink/snapshot.js';
import { EventWatcher } from './src/reolink/events.js';
import { SessionPool } from './src/reolink/sessions.js';
import { BatteryGuard } from './src/reolink/batteryGuard.js';
import { ReolinkAuthError } from './src/reolink/api.js';
import {
  setFloodlight,
  setSiren,
  setIrLights,
  goToPreset,
  listPresets,
} from './src/reolink/commands.js';
import { CAPABILITIES, FEATURE_SUFFIXES, DEVICE_PARAMS } from './src/reolink/constants.js';

const gladys = new GladysIntegration();
// Guards the battery of wire-free cameras: capturing is what drains them, so it
// backs off well before the cell reaches a level it may not recover from.
const batteryGuard = new BatteryGuard();
// ONE session per camera, shared by the capture, the actuators and the event
// watcher. A camera only accepts a handful, and a poll round touches it three
// times — see sessions.js.
const sessions = new SessionPool();

let config = normalizeConfig();

/** When each device was last captured, to honour its own refresh interval. */
const lastCaptureAt = new Map();

/**
 * Tell whether a device is one of the battery/solar cameras.
 *
 * Read from the declared capability rather than from a battery reading: the
 * capability is known before the camera has ever answered, and it is precisely
 * the camera that never answers which must not be captured on a loop.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True when the battery rules apply.
 * @example
 * isBatteryDevice(device);
 */
function isBatteryDevice(device) {
  return (
    batteryGuard.isBatteryCamera(device.external_id) ||
    deviceHasCapability(device, CAPABILITIES.BATTERY)
  );
}

/**
 * How long to wait between two automatic captures of a device.
 *
 * Battery cameras get their own interval on purpose: the two used to share one
 * setting, so sparing a solar camera meant letting every wired camera's image go
 * stale as well. They are unrelated costs and now unrelated settings.
 * @param {object} device - The Gladys device.
 * @returns {number} The interval, in seconds.
 * @example
 * refreshIntervalFor(device);
 */
function refreshIntervalFor(device) {
  return isBatteryDevice(device)
    ? config.battery_image_refresh_interval
    : config.image_refresh_interval;
}

/**
 * Tell whether the automatic refresh of a device is due.
 *
 * The scheduler ticks far more often than a battery camera should be captured —
 * `onPoll` alone fires every minute, and it must keep firing to read the
 * battery, the actuators and the detections. This is what keeps that frequent
 * tick from turning into a frequent capture.
 * @param {object} device - The Gladys device.
 * @returns {boolean} True when enough time has passed.
 * @example
 * if (isRefreshDue(device)) { ... }
 */
function isRefreshDue(device) {
  const last = lastCaptureAt.get(device.external_id);
  if (last === undefined) {
    return true;
  }
  return Date.now() - last >= refreshIntervalFor(device) * 1000;
}

/**
 * Capture a fresh image of a device and return it in the Gladys format.
 * @param {object} device - The Gladys device.
 * @returns {Promise<string>} The `image/jpg;base64,...` string.
 * @example
 * const image = await captureDeviceImage(device);
 */
async function captureDeviceImage(device) {
  if (!batteryGuard.allowsOnDemand(device.external_id)) {
    throw new Error(`REOLINK_BATTERY_TOO_LOW:${batteryGuard.levelOf(device.external_id)}%`);
  }
  const client = sessions.for(device, config);
  if (!client) {
    throw new Error('REOLINK_CAMERA_ADDRESS_UNKNOWN');
  }
  // Stamped before the capture: what costs the battery is waking the camera up,
  // so a capture that then fails still has to count against the interval.
  // Stamping on success only would let a flaky camera be retried every tick.
  lastCaptureAt.set(device.external_id, Date.now());
  try {
    return await captureImage(client.api, client.camera, config);
  } catch (e) {
    // Only a TRANSPORT failure suggests the session is the problem. An image
    // that came back too large is a perfectly healthy session answering a
    // question we did not like, and dropping it would cost a needless login on
    // every refresh round.
    if (isTransportFailure(e)) {
      sessions.drop(device);
    }
    throw e;
  }
}

/**
 * Tell whether a failure suggests the session, rather than the request, is what
 * went wrong.
 * @param {Error} error - The failure.
 * @returns {boolean} True when the session is worth reopening.
 * @example
 * isTransportFailure(new Error('REOLINK_TIMEOUT'));
 */
function isTransportFailure(error) {
  const message = String(error?.message || '');
  // The application-level refusals this integration raises on its own: they say
  // nothing about the connection.
  if (/^REOLINK_(IMAGE_TOO_LARGE|BATTERY_TOO_LOW|CAMERA_ADDRESS_UNKNOWN)/.test(message)) {
    return false;
  }
  return true;
}

/**
 * Capture and publish the image of every camera passed in.
 *
 * Sequential on purpose: several captures at once would compete for bandwidth,
 * and a camera answers faster when it is alone — which matters most on the
 * battery models that have to wake up first.
 * @param {object[]} devices - The devices to refresh.
 * @param {object} [options] - How to run the round.
 * @param {boolean} [options.force] - Ignore the per-device interval, for a
 * refresh the user explicitly asked for.
 * @returns {Promise<{ published: number, failures: string[] }>} What happened.
 * @example
 * const { published } = await refreshImages(await gladys.getDevices());
 */
async function refreshImages(devices, { force = false } = {}) {
  const cameras = (devices || []).filter((device) =>
    (device.features || []).some((feature) => feature.category === 'camera'),
  );
  let published = 0;
  /** @type {string[]} */
  const failures = [];

  for (const device of cameras) {
    // The scheduled refresh is the expensive part, so it is the first thing a
    // draining battery gives up — an explicit request still goes through.
    if (!force && !batteryGuard.allowsScheduled(device.external_id)) {
      continue;
    }
    // Each camera keeps its own pace: a battery model is captured far less often
    // than a wired one, and the loop ticks at the fastest of the two.
    if (!force && !isRefreshDue(device)) {
      continue;
    }
    try {
      const image = await captureDeviceImage(device);
      await gladys.publishCameraImage(device.external_id, image);
      published += 1;
    } catch (e) {
      logger.warn(`Refreshing the image of "${device.name}" failed: ${e.message}`);
      failures.push(device.name);
    }
  }
  return { published, failures };
}

/** Handle of the image refresh loop, so a config change can restart it. */
let refreshTimer = null;

/**
 * Start (or restart) the loop that keeps the dashboard images up to date.
 *
 * Why the integration drives this itself rather than relying on `onPoll`: Gladys
 * only wires a device into its poll scheduler when the device is CREATED. A
 * camera added before this integration declared `should_poll` therefore never
 * gets polled, and no re-publish can change that — the image would freeze on the
 * one captured at startup, which is exactly what happens without this loop.
 * @example
 * startImageRefresh();
 */
function startImageRefresh() {
  stopImageRefresh();
  // The loop ticks at the SHORTEST of the two intervals; each camera is then
  // filtered on its own by `isRefreshDue`. Ticking at the longest one would cap
  // every wired camera at the battery pace, which is what this split undoes.
  const intervalSeconds = Math.max(
    5,
    Math.min(config.image_refresh_interval, config.battery_image_refresh_interval),
  );
  refreshTimer = setInterval(async () => {
    try {
      // Re-read the devices every round: a camera may have been added or removed.
      const devices = await gladys.getDevices();
      await refreshImages(devices);
    } catch (e) {
      logger.debug(`The image refresh round failed: ${e.message}`);
    }
  }, intervalSeconds * 1000);
  logger.info(
    `Refreshing the camera images every ${config.image_refresh_interval}s (battery cameras: every ${config.battery_image_refresh_interval}s)`,
  );
}

/**
 * Stop the image refresh loop.
 * @example
 * stopImageRefresh();
 */
function stopImageRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// --- Event watching: motion, AI detections, doorbell, battery ----------------
// A detection also pushes a fresh image, so the dashboard widget shows what
// triggered it without waiting for the user to open it.
const watcher = new EventWatcher({
  gladys,
  batteryGuard,
  sessions,
  onDetection: async (device) => {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
  },
});

/**
 * Refresh the configuration, find the cameras and publish them.
 * @returns {Promise<object[]>} The published devices.
 * @example
 * const devices = await publishDevices();
 */
async function publishDevices() {
  config = normalizeConfig(await gladys.getConfig());

  if (!isConfigured(config)) {
    await gladys
      .setConnectionStatus(false, {
        en: 'Fill in the username and password of your cameras to find them.',
        fr: "Renseignez l'identifiant et le mot de passe de vos caméras pour les trouver.",
      })
      .catch(() => {});
    return [];
  }

  const devices = await buildDiscoveredDevices(gladys, config);
  await gladys.publishDiscoveredDevices(devices);

  // Declare the battery models to the guard right away. It must know a camera
  // runs on battery BEFORE that camera has ever reported a level: a battery
  // camera that never answers is the one most in need of being spared, and
  // waiting for a reading is waiting for something that may never come.
  devices.filter(isBatteryDevice).forEach((device) => {
    batteryGuard.trackBatteryCamera(device.external_id);
  });

  if (devices.length > 0) {
    await gladys.setConnectionStatus(true).catch(() => {});
  } else {
    await gladys
      .setConnectionStatus(false, {
        en: 'No camera found. Check that your cameras are powered on and reachable from Gladys, or enter their addresses manually.',
        fr: 'Aucune caméra trouvée. Vérifiez que vos caméras sont allumées et joignables depuis Gladys, ou saisissez leurs adresses manuellement.',
      })
      .catch(() => {});
  }
  return devices;
}

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> looking for the Reolink cameras');
  await publishDevices();
});

// --- Image: Gladys needs a fresh frame ---------------------------------------
gladys.onGetImage(async (device) => {
  logger.debug(`onGetImage <- ${device.external_id}`);
  try {
    return await captureDeviceImage(device);
  } catch (e) {
    // The widget only shows a generic error, so the reason has to reach the logs
    // or the failure is undiagnosable.
    logger.warn(`Capturing the image of "${device.name}" failed: ${e.message}`);
    throw e;
  }
});

// --- Actuators: the user flips a switch on the dashboard ---------------------
gladys.onSetValue(async (device, feature, value) => {
  const client = sessions.for(device, config);
  if (!client) {
    throw new Error('REOLINK_CAMERA_ADDRESS_UNKNOWN');
  }

  const on = Number(value) === 1;
  // The feature id ends with the suffix that says what it drives.
  const suffix = String(feature.external_id || '')
    .split(':')
    .pop();

  try {
    switch (suffix) {
      case FEATURE_SUFFIXES.FLOODLIGHT:
        await setFloodlight(client.api, on, { channel: client.camera.channel });
        break;
      case FEATURE_SUFFIXES.SIREN:
        await setSiren(client.api, on, { channel: client.camera.channel });
        break;
      case FEATURE_SUFFIXES.IR_LIGHTS:
        await setIrLights(client.api, on, { channel: client.camera.channel });
        break;
      case FEATURE_SUFFIXES.PTZ_PRESET: {
        // The value IS the preset number here, not a boolean. 0 means "no
        // preset", which the camera would refuse, so it is treated as a no-op.
        const presetId = Number(value);
        if (!Number.isInteger(presetId) || presetId <= 0) {
          logger.debug(`Ignoring the preset ${value} of "${device.name}": not a preset number`);
          return;
        }
        await goToPreset(client.api, presetId, { channel: client.camera.channel });
        break;
      }
      default:
        logger.debug(`Nothing to do for the feature ${feature.external_id}`);
        return;
    }
    logger.info(`"${device.name}": ${suffix} set to ${value}`);
  } catch (e) {
    // A command that failed may have failed on the session; the next one gets a
    // fresh login rather than repeating the same rejection.
    sessions.drop(device);
    throw e;
  }
});

// --- Polling: Gladys asks to refresh a device --------------------------------
// The image itself is pulled by `onGetImage`, so a poll is the moment to push
// what the widget does not ask for: the image, the actuator states and the
// detections the event loop may have missed.
gladys.onPoll(async (device) => {
  if (!parsePlatformId(device.external_id) || !isConfigured(config)) {
    return;
  }

  // The battery is read FIRST, and the capture decision is taken after it.
  //
  // Reading the battery, the actuators and the detections is cheap and is never
  // gated, while capturing is what drains the cell. Capturing first meant every
  // decision below was taken against the PREVIOUS round's level — and, on a
  // camera that had just crossed a threshold, one more capture was let through.
  await publishActuatorStates(device).catch((e) =>
    logger.debug(`Reading the actuators of "${device.name}" failed: ${e.message}`),
  );

  await watcher
    .checkDevice(device)
    .catch((e) => logger.debug(`Poll of "${device.name}" failed: ${e.message}`));

  // The dashboard camera widget does NOT ask for a fresh image: it displays the
  // last one published, and shows an error when none is recent enough. So the
  // image has to be PUSHED — `onGetImage` alone only covers the live view and
  // the chat intent, which would leave the widget permanently empty.
  const hasCamera = (device.features || []).some((feature) => feature.category === 'camera');
  if (!hasCamera || !batteryGuard.allowsScheduled(device.external_id)) {
    return;
  }
  // This poll IS a scheduled refresh, so it answers to the refresh interval too.
  // Without this it captured on every tick, pinned at POLL_FREQUENCY_MS, and no
  // interval setting could slow it down.
  if (!isRefreshDue(device)) {
    return;
  }

  try {
    const image = await captureDeviceImage(device);
    await gladys.publishCameraImage(device.external_id, image);
    logger.debug(`Image of "${device.name}" refreshed`);
  } catch (e) {
    logger.warn(`Refreshing the image of "${device.name}" failed: ${e.message}`);
  }
});

/**
 * Re-read the actuators the camera can change on its own.
 *
 * The spotlight follows the camera's own night schedule and the infrared LEDs
 * switch with the light sensor, so Gladys would otherwise show whatever it last
 * commanded — which stops being true within hours.
 * @param {object} device - The Gladys device.
 * @returns {Promise<void>} Resolves once published.
 * @example
 * await publishActuatorStates(device);
 */
async function publishActuatorStates(device) {
  const readable =
    deviceHasCapability(device, CAPABILITIES.FLOODLIGHT) ||
    deviceHasCapability(device, CAPABILITIES.IR_LIGHTS);
  if (!readable) {
    return;
  }

  const client = sessions.for(device, config);
  const platformId = parsePlatformId(device.external_id);
  if (!client || !platformId) {
    return;
  }

  const ids = cameraIds(gladys, platformId);
  // Both states in one round trip: on a battery camera each request is a radio
  // wakeup, and this runs on every poll.
  const states = await readActuatorStates(client, device);

  for (const [suffix, state] of Object.entries(states)) {
    if (state === null) {
      continue;
    }
    await gladys.publishState(ids.feature(suffix), state ? 1 : 0).catch(() => {});
  }
}

/**
 * Read the actuator states of one camera in a single batch.
 * @param {object} client - `{ api, camera }`.
 * @param {object} device - The Gladys device, for its capabilities.
 * @returns {Promise<Record<string, boolean|null>>} The states, by feature suffix.
 * @example
 * const states = await readActuatorStates(client, device);
 */
async function readActuatorStates(client, device) {
  const wanted = [];
  if (deviceHasCapability(device, CAPABILITIES.FLOODLIGHT)) {
    wanted.push({ cmd: 'GetWhiteLed', suffix: FEATURE_SUFFIXES.FLOODLIGHT });
  }
  if (deviceHasCapability(device, CAPABILITIES.IR_LIGHTS)) {
    wanted.push({ cmd: 'GetIrLights', suffix: FEATURE_SUFFIXES.IR_LIGHTS });
  }

  const answers = await client.api.sendBatch(
    wanted.map((entry) => ({
      cmd: entry.cmd,
      action: 0,
      param: { channel: client.camera.channel },
    })),
  );

  /** @type {Record<string, boolean|null>} */
  const states = {};
  wanted.forEach((entry, index) => {
    const answer = answers[index];
    if (Number(answer?.code) !== 0) {
      // Unreadable: publishing `false` here would show the spotlight as off
      // while it is on.
      states[entry.suffix] = null;
      return;
    }
    states[entry.suffix] =
      entry.cmd === 'GetWhiteLed'
        ? Number(answer.value?.WhiteLed?.state) === 1
        : String(answer.value?.IrLights?.state ?? 'Off') !== 'Off';
  });
  return states;
}

// --- Manifest action: test the connection ------------------------------------
gladys.onAction('test_connection', async () => {
  try {
    config = normalizeConfig(await gladys.getConfig());
    if (!isConfigured(config)) {
      return {
        en: 'Fill in the username and password of your cameras first.',
        fr: "Renseignez d'abord l'identifiant et le mot de passe de vos caméras.",
      };
    }

    const devices = await buildDiscoveredDevices(gladys, config);
    if (devices.length === 0) {
      return {
        en: 'No camera answered. Check that your cameras are powered on and on the same network as Gladys, or enter their addresses under "Camera addresses".',
        fr: "Aucune caméra n'a répondu. Vérifiez que vos caméras sont allumées et sur le même réseau que Gladys, ou saisissez leurs adresses dans « Adresses des caméras ».",
      };
    }

    // Report what each camera can do: it is what decides the features created,
    // and a missing spotlight switch is otherwise a mystery.
    const summary = devices
      .map((device) => {
        const capabilities = getParam(device, DEVICE_PARAMS.CAPABILITIES);
        return capabilities ? `${device.name} (${capabilities})` : device.name;
      })
      .join(', ');

    return {
      en: `Connection OK: ${devices.length} camera(s) found — ${summary}.`,
      fr: `Connexion OK : ${devices.length} caméra(s) trouvée(s) — ${summary}.`,
    };
  } catch (e) {
    logger.error('The Reolink connection test failed', e);
    if (e instanceof ReolinkAuthError) {
      return {
        en: 'Connection refused: check the username and password of your cameras.',
        fr: "Connexion refusée : vérifiez l'identifiant et le mot de passe de vos caméras.",
      };
    }
    return {
      en: `Connection failed: ${e.message}`,
      fr: `Échec de la connexion : ${e.message}`,
    };
  }
});

// --- Manifest action: list the PTZ presets -----------------------------------
// The preset feature takes a NUMBER, and the camera is the only one that knows
// which numbers exist. Without this, the user has to guess.
gladys.onAction('list_presets', async () => {
  const devices = await gladys.getDevices();
  const ptzCameras = devices.filter((device) =>
    deviceHasCapability(device, CAPABILITIES.PTZ_PRESETS),
  );

  if (ptzCameras.length === 0) {
    return {
      en: 'No camera with PTZ presets was found. Only motorized cameras have them.',
      fr: 'Aucune caméra avec des positions PTZ trouvée. Seules les caméras motorisées en possèdent.',
    };
  }

  const lines = [];
  for (const device of ptzCameras) {
    const client = sessions.for(device, config);
    if (!client) {
      continue;
    }
    try {
      const presets = await listPresets(client.api, client.camera.channel);
      lines.push(
        presets.length > 0
          ? `${device.name}: ${presets.map((preset) => `${preset.id} = ${preset.name}`).join(', ')}`
          : `${device.name}: no preset saved yet`,
      );
    } catch (e) {
      sessions.drop(device);
      lines.push(`${device.name}: unreadable (${e.message})`);
    }
  }

  return {
    en: `Saved presets — ${lines.join(' | ')}`,
    fr: `Positions enregistrées — ${lines.join(' | ')}`,
  };
});

// --- Manifest action: refresh every image ------------------------------------
gladys.onAction('refresh_images', async () => {
  const devices = await gladys.getDevices();
  const cameras = devices.filter((device) =>
    (device.features || []).some((feature) => feature.category === 'camera'),
  );
  if (cameras.length === 0) {
    return {
      en: 'No camera created yet. Run a scan from the Discover screen first.',
      fr: "Aucune caméra créée pour l'instant. Lancez d'abord un scan depuis l'écran Découverte.",
    };
  }

  // Forced: the user pressed the button, so the per-device interval does not
  // apply. The battery floor still does — `captureDeviceImage` enforces it, so a
  // camera below the hard limit reports a failure instead of being captured.
  const { published, failures } = await refreshImages(cameras, { force: true });

  if (failures.length === 0) {
    return {
      en: `${published} image(s) refreshed.`,
      fr: `${published} image(s) rafraîchie(s).`,
    };
  }
  return {
    en: `${published} image(s) refreshed. Failed: ${failures.join(', ')}.`,
    fr: `${published} image(s) rafraîchie(s). Échec : ${failures.join(', ')}.`,
  };
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async () => {
  logger.info('onConfigUpdated -> reloading the configuration');
  await publishDevices().catch((e) => logger.error('Re-publish after config update failed', e));
  if (isConfigured(config)) {
    // Thresholds first: the watcher polls straight away, and a tick landing
    // before the new thresholds were applied would decide on the old ones.
    batteryGuard.configure(config);
    watcher.start(config);
    startImageRefresh();
  } else {
    watcher.stop();
    stopImageRefresh();
  }
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    // Load the devices the user created, so the event watcher knows what to poll.
    const devices = await gladys.getDevices();
    await publishDevices();
    if (isConfigured(config)) {
      // Thresholds before anything captures, and battery models declared before
      // the startup refresh: a camera the guard does not yet know about would be
      // captured on the spot, which on a flat cell is the one capture to avoid.
      batteryGuard.configure(config);
      devices.filter(isBatteryDevice).forEach((device) => {
        batteryGuard.trackBatteryCamera(device.external_id);
      });
      watcher.start(config);
      startImageRefresh();

      // Read the battery of every camera BEFORE the startup capture. At boot the
      // guard has no readings at all, so without this pass a battery camera is
      // judged on nothing — and the widget being populated one round sooner is
      // not worth a capture on a camera that may be nearly empty.
      await Promise.all(
        devices.map((device) =>
          watcher
            .checkDevice(device)
            .catch((e) =>
              logger.debug(`Initial battery read of "${device.name}" failed: ${e.message}`),
            ),
        ),
      );

      // Publish a first image right away, so the widget is populated at once
      // instead of waiting a full refresh round.
      await refreshImages(devices);
    }
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
    await gladys
      .setConnectionStatus(false, {
        en: 'Initialization failed, check the integration logs.',
        fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
      })
      .catch(() => {});
  }
});

// --- Graceful shutdown -------------------------------------------------------
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  watcher.stop();
  stopImageRefresh();
  // Hand the sessions back: the camera keeps them open on its side and only
  // accepts a handful, so a restart would otherwise find them all taken.
  sessions.reset();
});

// --- Last-resort guards ------------------------------------------------------
// A camera socket dying at the wrong moment must never take the integration
// down: the supervisor would restart it and every camera would lose its images
// until the next round. These handlers keep the process alive and leave a trace.
process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception, the integration keeps running: ${err.message}`, err);
});
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled rejection, the integration keeps running: ${reason}`);
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Reolink integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
