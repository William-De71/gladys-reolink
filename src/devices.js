// -----------------------------------------------------------------------------
// Device orchestration: turning cameras into Gladys devices.
//
// One camera becomes one device whose features depend on what it can actually
// do (see reolink/capabilities.js) — a wired RLC-810A, a battery Argus and a
// video doorbell all speak the same API but have very different hardware:
//
//   camera/image           the snapshot shown by the dashboard widget (always);
//   motion-sensor/binary   motion detection (always);
//   button/push            the doorbell press (doorbell models);
//   battery/integer        the battery level (battery models);
//   presence-sensor/binary person / vehicle / animal AI detections;
//   light/binary           the spotlight;
//   siren/binary           the siren;
//   switch/binary          the infrared LEDs.
//
// A device keeps everything needed to reach it in its params (address, port,
// scheme, capabilities), so a poll or an `onGetImage` never needs a discovery
// round again.
// -----------------------------------------------------------------------------

import {
  logger,
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { ReolinkApi, ReolinkAuthError } from './reolink/api.js';
import { resolveCapabilities } from './reolink/capabilities.js';
import { buildRtspUrl, readCodecs } from './reolink/rtsp.js';
import { discoverCameras } from './reolink/discovery.js';
import { resolveAccount } from './config.js';
import {
  EXTERNAL_ID_TYPE,
  DEVICE_PARAMS,
  FEATURE_SUFFIXES,
  CAPABILITIES,
  POLL_FREQUENCY_MS,
  DEFAULT_CHANNEL,
} from './reolink/constants.js';

/**
 * Build the external ids of one camera through the SDK. Gladys namespaces every
 * external id as `ext:<selector>:<type>:<platformId>` and rejects anything else,
 * so these ids must never be assembled by hand.
 *
 * The UID plays the `platformId` part: it is the only identifier that survives a
 * rename or a DHCP lease change. A camera that announces no UID falls back to
 * its MAC, which is just as stable; the address is the last resort and the only
 * one that can drift.
 * @param {object} gladys - The SDK instance.
 * @param {string} platformId - The camera identity.
 * @returns {object} The device id and the feature id factory.
 * @example
 * const ids = cameraIds(gladys, '95270005ZBCDEFGH');
 * ids.device; // 'ext:ext-dev-reolink:camera:95270005ZBCDEFGH'
 */
export function cameraIds(gladys, platformId) {
  return gladys.externalIds(EXTERNAL_ID_TYPE, platformId);
}

/**
 * Pick the most stable identity a camera offers.
 *
 * The order matters: a UID never changes, a MAC changes only if the hardware
 * does, and an address changes whenever the DHCP lease does. Falling back to the
 * address means a camera that later reveals its UID would be seen as a NEW
 * device — unavoidable, but rare enough to prefer over refusing the camera.
 * @param {object} camera - What is known about the camera.
 * @returns {string} The platform id.
 * @example
 * platformIdOf({ uid: null, mac: 'AA:BB:CC:DD:EE:FF' }); // 'AABBCCDDEEFF'
 */
export function platformIdOf(camera) {
  if (camera.uid) {
    return String(camera.uid).toUpperCase();
  }
  if (camera.mac) {
    // Colons are stripped: Gladys external ids use `:` as their own separator,
    // so a MAC kept raw would split the id into the wrong number of parts.
    return String(camera.mac).toUpperCase().replace(/:/g, '');
  }
  return String(camera.ip || '').replace(/[.:]/g, '-');
}

/**
 * Extract the platform id from a device or feature external id.
 * @param {string} externalId - The external id.
 * @returns {string|null} The platform id, or null when unparseable.
 * @example
 * parsePlatformId('ext:ext-dev-reolink:camera:UID1:image'); // 'UID1'
 */
export function parsePlatformId(externalId) {
  // `ext:<selector>:<type>:<platformId>[:<feature>]` — the platform id is the
  // fourth segment, whether the id points at the device or at one of its features.
  const parts = String(externalId || '').split(':');
  if (parts[0] !== 'ext' || parts[2] !== EXTERNAL_ID_TYPE || !parts[3]) {
    return null;
  }
  return parts[3];
}

/**
 * Read a device param by name.
 * @param {object} device - The Gladys device.
 * @param {string} name - The param name.
 * @returns {string|null} The value, or null when absent.
 * @example
 * getParam(device, 'REOLINK_IP');
 */
export function getParam(device, name) {
  const param = (device.params || []).find((entry) => entry.name === name);
  return param ? String(param.value) : null;
}

/**
 * The AI detections, mapped to the feature they produce.
 *
 * They are `presence-sensor` rather than `motion-sensor`: Gladys already gets a
 * motion feature from `GetMdState`, and a second one saying the same thing in a
 * different way would be confusing in the scene editor. "A person was seen" is
 * what a user actually builds a scene on.
 */
const AI_FEATURES = [
  { capability: CAPABILITIES.AI_PEOPLE, suffix: FEATURE_SUFFIXES.AI_PEOPLE, label: 'Person' },
  { capability: CAPABILITIES.AI_VEHICLE, suffix: FEATURE_SUFFIXES.AI_VEHICLE, label: 'Vehicle' },
  { capability: CAPABILITIES.AI_ANIMAL, suffix: FEATURE_SUFFIXES.AI_ANIMAL, label: 'Animal' },
];

/**
 * Build the features of a camera, from what it can do.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object[]} The features.
 * @example
 * buildFeatures(gladys, camera);
 */
export function buildFeatures(gladys, camera) {
  const ids = cameraIds(gladys, camera.platformId);
  const has = (capability) => (camera.capabilities || []).includes(capability);

  const features = [
    {
      name: camera.name,
      external_id: ids.feature(FEATURE_SUFFIXES.IMAGE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.IMAGE,
      read_only: false,
      keep_history: false,
      has_feedback: false,
      min: 0,
      max: 0,
    },
    {
      name: `${camera.name} - Motion`,
      external_id: ids.feature(FEATURE_SUFFIXES.MOTION),
      category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 1,
    },
  ];

  if (has(CAPABILITIES.DOORBELL)) {
    features.push({
      name: `${camera.name} - Doorbell`,
      external_id: ids.feature(FEATURE_SUFFIXES.DOORBELL),
      category: DEVICE_FEATURE_CATEGORIES.BUTTON,
      type: DEVICE_FEATURE_TYPES.BUTTON.PUSH,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 1,
    });
  }

  if (has(CAPABILITIES.BATTERY)) {
    features.push({
      name: `${camera.name} - Battery`,
      external_id: ids.feature(FEATURE_SUFFIXES.BATTERY),
      category: DEVICE_FEATURE_CATEGORIES.BATTERY,
      type: DEVICE_FEATURE_TYPES.BATTERY.INTEGER,
      unit: DEVICE_FEATURE_UNITS.PERCENT,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 100,
    });
  }

  AI_FEATURES.filter((entry) => has(entry.capability)).forEach((entry) => {
    features.push({
      name: `${camera.name} - ${entry.label}`,
      external_id: ids.feature(entry.suffix),
      category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
      type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
      read_only: true,
      keep_history: true,
      has_feedback: false,
      min: 0,
      max: 1,
    });
  });

  if (has(CAPABILITIES.FLOODLIGHT)) {
    features.push({
      name: `${camera.name} - Spotlight`,
      external_id: ids.feature(FEATURE_SUFFIXES.FLOODLIGHT),
      category: DEVICE_FEATURE_CATEGORIES.LIGHT,
      type: DEVICE_FEATURE_TYPES.LIGHT.BINARY,
      read_only: false,
      keep_history: true,
      // The camera is the source of truth for its own light: it may switch it
      // off on its own schedule, and the poll re-reads the real state.
      has_feedback: true,
      min: 0,
      max: 1,
    });
  }

  if (has(CAPABILITIES.SIREN)) {
    features.push({
      name: `${camera.name} - Siren`,
      external_id: ids.feature(FEATURE_SUFFIXES.SIREN),
      category: DEVICE_FEATURE_CATEGORIES.SIREN,
      type: DEVICE_FEATURE_TYPES.SIREN.BINARY,
      read_only: false,
      keep_history: true,
      // Unlike the spotlight, the siren has no readable state: the firmware
      // exposes no "is it sounding right now". Gladys keeps what it commanded.
      has_feedback: false,
      min: 0,
      max: 1,
    });
  }

  if (has(CAPABILITIES.IR_LIGHTS)) {
    features.push({
      name: `${camera.name} - Infrared`,
      external_id: ids.feature(FEATURE_SUFFIXES.IR_LIGHTS),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.BINARY,
      read_only: false,
      keep_history: false,
      has_feedback: true,
      min: 0,
      max: 1,
    });
  }

  if (has(CAPABILITIES.PTZ_PRESETS)) {
    features.push({
      name: `${camera.name} - Preset`,
      external_id: ids.feature(FEATURE_SUFFIXES.PTZ_PRESET),
      category: DEVICE_FEATURE_CATEGORIES.SWITCH,
      type: DEVICE_FEATURE_TYPES.SWITCH.DIMMER,
      read_only: false,
      keep_history: false,
      // Writing the preset number moves the camera; there is nothing to read
      // back, since the camera reports no "current preset".
      has_feedback: false,
      min: 0,
      // Reolink numbers its presets from 1; 64 is the largest the firmware
      // accepts, and an unused number is simply refused by the camera.
      max: 64,
    });
  }

  return features;
}

/**
 * Build the Gladys device of one camera.
 * @param {object} gladys - The SDK instance, which namespaces the ids.
 * @param {object} camera - The resolved camera.
 * @returns {object} The device, ready to be published.
 * @example
 * buildDevice(gladys, camera);
 */
export function buildDevice(gladys, camera) {
  return {
    name: camera.name,
    external_id: cameraIds(gladys, camera.platformId).device,
    model: camera.model || null,
    // The dashboard widget shows the last PUBLISHED image, never a fresh one, so
    // the poll is what keeps it up to date (see `onPoll`). Without this, the
    // widget would stay empty until something else published an image.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY_MS,
    features: buildFeatures(gladys, camera),
    params: [
      { name: DEVICE_PARAMS.IP, value: camera.ip || '' },
      { name: DEVICE_PARAMS.PORT, value: String(camera.port || '') },
      { name: DEVICE_PARAMS.HTTPS, value: camera.https ? '1' : '0' },
      { name: DEVICE_PARAMS.UID, value: camera.uid || '' },
      { name: DEVICE_PARAMS.MODEL, value: camera.model || '' },
      { name: DEVICE_PARAMS.CAPABILITIES, value: (camera.capabilities || []).join(',') },
      // The live view of the dashboard widget calls the rtsp-camera service,
      // which streams ANY device carrying a CAMERA_URL param — whatever service
      // owns it. Publishing the RTSP URL here is therefore what unlocks the live
      // video for an external integration.
      { name: DEVICE_PARAMS.CAMERA_URL, value: camera.streamUrl || '' },
      { name: DEVICE_PARAMS.CAMERA_ROTATION, value: '0' },
    ],
  };
}

/**
 * Ask one address who it is and what it can do.
 *
 * This is the only place that talks to a camera during discovery, and it is
 * deliberately tolerant: an address that does not answer, or answers something
 * that is not a Reolink API, yields null rather than failing the whole scan —
 * the network may well hold devices that are not cameras.
 * @param {object} candidate - `{ ip, port, uid, mac, name }`.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object|null>} The resolved camera, or null.
 * @example
 * const camera = await resolveCamera({ ip: '192.168.1.42' }, config);
 */
export async function resolveCamera(candidate, config) {
  const account = resolveAccount(config, candidate.ip);
  const api = new ReolinkApi({
    ip: candidate.ip,
    port: candidate.port || undefined,
    username: account.username,
    password: account.password,
    timeoutMs: config.capture_timeout * 1000,
  });

  try {
    // One batch rather than three round trips: identity, abilities and AI
    // support are all needed before a single feature can be decided.
    const [devInfo, ability, aiState] = await Promise.all([
      api.getDevInfo(),
      api.getAbility(),
      api.send('GetAiState', { channel: DEFAULT_CHANNEL }),
    ]);

    if (!devInfo) {
      logger.debug(`${candidate.ip} answered, but not like a Reolink camera`);
      return null;
    }

    const capabilities = resolveCapabilities({ ability, aiState, devInfo });
    const codecs = await readCodecs(api);

    const camera = {
      // The name the user gave the camera in the Reolink app beats the one the
      // discovery reply carried: it is what they will look for in Gladys.
      name: devInfo.name || candidate.name || `Reolink ${candidate.ip}`,
      model: devInfo.model || '',
      ip: candidate.ip,
      port: api.port,
      https: api.https,
      channel: DEFAULT_CHANNEL,
      // `GetDevInfo` carries no UID, so the discovery one is kept; the serial is
      // the fallback for a camera entered by hand, which never went through a
      // discovery reply.
      uid: candidate.uid || devInfo.serial || null,
      mac: candidate.mac || null,
      capabilities,
      codecs,
    };
    camera.platformId = platformIdOf(camera);
    camera.streamUrl = buildRtspUrl(camera, account, config.stream_quality);

    logger.info(
      `"${camera.name}" (${camera.model} at ${camera.ip}) offers: ${capabilities.join(', ') || 'image and motion only'}`,
    );
    return camera;
  } catch (e) {
    if (e instanceof ReolinkAuthError) {
      // Worth a warning rather than a debug line: the camera IS there and the
      // user has a fix to apply, which a silent skip would never reveal.
      logger.warn(
        `${candidate.ip} refused the credentials. Check the username and password, or add a specific account for this camera.`,
      );
    } else {
      logger.debug(`${candidate.ip} could not be identified: ${e.message}`);
    }
    return null;
  } finally {
    await api.logout().catch(() => {});
  }
}

/**
 * Find every camera and build the devices to publish.
 *
 * The two sources are merged rather than chosen between: the scan finds what is
 * reachable by broadcast, and the manual list covers what it cannot reach (a
 * camera on another VLAN, a router filtering broadcast). A manually entered
 * address always wins, since the user typed it precisely because the automatic
 * path did not suit.
 * @param {object} gladys - The SDK instance.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The devices.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, config);
 */
export async function buildDiscoveredDevices(gladys, config) {
  const discovered = await discoverCameras(gladys);

  /** @type {Map<string, object>} */
  const candidates = new Map();
  discovered.forEach((camera) => candidates.set(camera.ip, camera));
  // Added last so a manual entry overwrites the discovered one for that address:
  // it may carry a port the scan could not know about.
  config.camera_addresses.forEach((entry) => {
    candidates.set(entry.ip, { ...candidates.get(entry.ip), ip: entry.ip, port: entry.port });
  });

  // Identifying is I/O bound and independent per camera, so resolve them
  // together rather than paying the timeout of each unreachable address in turn.
  const cameras = await Promise.all(
    [...candidates.values()].map((candidate) => resolveCamera(candidate, config)),
  );

  return cameras.filter((camera) => camera !== null).map((camera) => buildDevice(gladys, camera));
}

/**
 * Rebuild an API client from a device Gladys created, so a capture or a command
 * needs no discovery round.
 * @param {object} device - The Gladys device.
 * @param {object} config - The normalized configuration.
 * @returns {object|null} `{ api, camera }`, or null when the device has no address.
 * @example
 * const { api, camera } = clientFromDevice(device, config);
 */
export function clientFromDevice(device, config) {
  const ip = getParam(device, DEVICE_PARAMS.IP);
  if (!ip) {
    return null;
  }

  const port = Number(getParam(device, DEVICE_PARAMS.PORT)) || undefined;
  const https = getParam(device, DEVICE_PARAMS.HTTPS) === '1';
  const account = resolveAccount(config, ip);

  const camera = {
    name: device.name || 'Reolink camera',
    ip,
    port,
    https,
    channel: DEFAULT_CHANNEL,
    model: getParam(device, DEVICE_PARAMS.MODEL) || '',
    uid: getParam(device, DEVICE_PARAMS.UID) || '',
    capabilities: (getParam(device, DEVICE_PARAMS.CAPABILITIES) || '')
      .split(',')
      .filter((entry) => entry.length > 0),
  };

  const api = new ReolinkApi({
    ip,
    port,
    // The stored scheme is only a hint: a camera switched to HTTPS since it was
    // added would make every request fail, so an unknown port re-probes.
    https: port ? https : undefined,
    username: account.username,
    password: account.password,
    timeoutMs: config.capture_timeout * 1000,
  });

  return { api, camera };
}

/**
 * Tell whether a device declares one capability.
 * @param {object} device - The Gladys device.
 * @param {string} capability - One of `CAPABILITIES`.
 * @returns {boolean} True when the camera announced it at discovery time.
 * @example
 * deviceHasCapability(device, CAPABILITIES.BATTERY);
 */
export function deviceHasCapability(device, capability) {
  const capabilities = getParam(device, DEVICE_PARAMS.CAPABILITIES) || '';
  return capabilities.split(',').includes(capability);
}
