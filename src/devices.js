// -----------------------------------------------------------------------------
// Device orchestration: turning cameras into Gladys devices.
//
// One camera becomes one device whose features depend on what it can actually
// do (see reolink/capabilities.js) — a wired RLC-810A, a battery Argus and a
// video doorbell all speak the same API but have very different hardware:
//
//   camera/image           the snapshot shown by the dashboard widget (always);
//   motion-sensor/binary   motion detection (always), and the person / vehicle
//                          / animal AI detections on the models that run them;
//   doorbell/ring          the doorbell press (doorbell models);
//   battery/integer        the battery level (battery models);
//   light/binary           the spotlight;
//   siren/binary           the siren;
//   switch/binary          the infrared LEDs;
//   camera/move            the PTZ arrows (motorized models);
//   camera/preset          the saved PTZ positions (motorized models).
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
import { buildRtspUrl, readCodecs, readNetPorts } from './reolink/rtsp.js';
import { listPresets } from './reolink/commands.js';
import { discoverCameras } from './reolink/discovery.js';
import { listChannels, isMultiChannelHost } from './reolink/channels.js';
import { resolveAccount } from './config.js';
import {
  EXTERNAL_ID_TYPE,
  DEVICE_PARAMS,
  FEATURE_SUFFIXES,
  CAPABILITIES,
  POLL_FREQUENCY_MS,
  DEFAULT_CHANNEL,
  CAMERA_MOVE,
} from './reolink/constants.js';

/**
 * Default labels of the canonical movements. The dashboard renders arrows, so
 * these only surface in the scene editor; English on purpose — Gladys
 * translates its own canonical labels.
 */
const MOVEMENT_LABELS = {
  [CAMERA_MOVE.PAN_LEFT]: 'Pan left',
  [CAMERA_MOVE.PAN_RIGHT]: 'Pan right',
  [CAMERA_MOVE.TILT_UP]: 'Tilt up',
  [CAMERA_MOVE.TILT_DOWN]: 'Tilt down',
  [CAMERA_MOVE.ZOOM_IN]: 'Zoom in',
  [CAMERA_MOVE.ZOOM_OUT]: 'Zoom out',
};

/**
 * The movements a camera can make, from its capabilities.
 * @param {string[]} capabilities - The camera capabilities.
 * @returns {number[]} `CAMERA_MOVE` values, STOP excluded (always supported).
 * @example
 * supportedMovements(['ptz_pan_tilt']); // [1, 2, 3, 4]
 */
export function supportedMovements(capabilities = []) {
  const movements = [];
  if (capabilities.includes(CAPABILITIES.PTZ_PAN_TILT)) {
    movements.push(
      CAMERA_MOVE.PAN_LEFT,
      CAMERA_MOVE.PAN_RIGHT,
      CAMERA_MOVE.TILT_UP,
      CAMERA_MOVE.TILT_DOWN,
    );
  }
  if (capabilities.includes(CAPABILITIES.PTZ_ZOOM)) {
    movements.push(CAMERA_MOVE.ZOOM_IN, CAMERA_MOVE.ZOOM_OUT);
  }
  return movements;
}

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
 * Tell whether an announced identity actually identifies ONE camera.
 *
 * Some firmwares answer `GetDevInfo` with a placeholder serial — empty, all
 * zeroes, or a single character repeated — which is the same on every camera of
 * the model. Taking it as the identity gives two cameras one external id, and
 * Gladys upserts devices on that id: the second camera then overwrites the first
 * instead of being created. A useless identity must fall through to the MAC.
 * @param {unknown} value - The announced uid or serial.
 * @returns {boolean} True when the value can identify one camera.
 * @example
 * isUsableIdentity('00000000000000'); // false
 */
export function isUsableIdentity(value) {
  const identity = String(value || '').trim();
  if (identity.length < 4) {
    return false;
  }
  // A single character repeated (`000…`, `FFF…`) is a placeholder, never a UID.
  return !/^(.)\1*$/.test(identity);
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
  if (isUsableIdentity(camera.uid)) {
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
 * Published as `motion-sensor` / `binary`, named after what they detect. The
 * `presence-sensor` category would read better, but Gladys only renders it for
 * the `push` type: a `presence-sensor` + `binary` feature shows up with no
 * label, no icon and a "seen 9 hours ago" instead of a yes/no. A motion sensor
 * called "Person" is displayed, historised and offered as a scene trigger
 * properly today — which is what a user builds "a person is at the gate" on.
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
      // The dedicated category (Gladys 4.84.2+): the dashboard shows "Ringing"
      // then the time of the last ring, and the scene editor offers "when the
      // doorbell rings". The value is a 1 -> 0 pulse, like a motion.
      category: DEVICE_FEATURE_CATEGORIES.DOORBELL,
      type: DEVICE_FEATURE_TYPES.DOORBELL.RING,
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
      category: DEVICE_FEATURE_CATEGORIES.MOTION_SENSOR,
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

  // PTZ arrows: only the movements the head actually has, so a zoom-only bullet
  // camera shows a zoom and no arrows (the capability lives in the options).
  const movements = supportedMovements(camera.capabilities);
  if (movements.length > 0) {
    features.push({
      name: `${camera.name} - Move`,
      external_id: ids.feature(FEATURE_SUFFIXES.PTZ_MOVE),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.MOVE,
      read_only: false,
      // A movement is a command, not a measurement.
      keep_history: false,
      has_feedback: false,
      min: CAMERA_MOVE.STOP,
      max: CAMERA_MOVE.ZOOM_OUT,
      supported_options: movements.map((value, index) => ({
        value,
        label: MOVEMENT_LABELS[value],
        sort_order: index,
      })),
    });
  }

  // Saved positions, as a labeled list. The option VALUE is the Reolink preset
  // number itself, exactly what the former numeric feature took: the external
  // id is unchanged too, so a scene that sent `2` still moves to preset 2.
  const presets = camera.presets || [];
  if (has(CAPABILITIES.PTZ_PRESETS) && presets.length > 0) {
    features.push({
      name: `${camera.name} - Preset`,
      external_id: ids.feature(FEATURE_SUFFIXES.PTZ_PRESET),
      category: DEVICE_FEATURE_CATEGORIES.CAMERA,
      type: DEVICE_FEATURE_TYPES.CAMERA.PRESET,
      read_only: false,
      keep_history: false,
      // Writing the preset number moves the camera; there is nothing to read
      // back, since the camera reports no "current preset".
      has_feedback: false,
      min: Math.min(...presets.map((preset) => preset.id)),
      max: Math.max(...presets.map((preset) => preset.id)),
      supported_options: presets.map((preset, index) => ({
        value: preset.id,
        label: preset.name,
        sort_order: index,
      })),
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
      // Behind a Home Hub or an NVR, this is what tells the cameras apart: they
      // share the address, the port and the session, and differ only here.
      { name: DEVICE_PARAMS.CHANNEL, value: String(camera.channel ?? DEFAULT_CHANNEL) },
      { name: DEVICE_PARAMS.HOST_UID, value: camera.hostUid || '' },
      // The live view of the dashboard widget calls the rtsp-camera service,
      // which streams ANY device carrying a CAMERA_URL param — whatever service
      // owns it. Publishing the RTSP URL here is therefore what unlocks the live
      // video for an external integration.
      { name: DEVICE_PARAMS.CAMERA_URL, value: camera.streamUrl || '' },
      { name: DEVICE_PARAMS.CAMERA_ROTATION, value: '0' },
      // Where to subscribe to the camera's own events, '0' when there is no
      // ONVIF server to subscribe to (see reolink/onvif.js).
      { name: DEVICE_PARAMS.ONVIF_PORT, value: String(camera.onvifPort || 0) },
      { name: DEVICE_PARAMS.RTSP_DISABLED, value: camera.rtspEnabled === false ? '1' : '0' },
    ],
  };
}

/**
 * Build the platform id of one camera behind a multi-channel host.
 *
 * The channel number alone would be a terrible identity: it is a POSITION, and
 * a camera re-paired to a hub commonly lands on a different one — every Gladys
 * device would then point at the wrong camera, silently.
 *
 * So the camera's own UID is used whenever the hub announces one. When it does
 * not, the identity falls back to the HOST plus the channel: stable as long as
 * nothing is re-paired, which is the best a firmware that hides the UID allows.
 * @param {object} entry - The channel, from `listChannels`.
 * @param {object} host - The host, as `{ uid, mac, ip }`.
 * @returns {string} The platform id.
 * @example
 * channelPlatformId({ channel: 1, uid: null }, { uid: 'HUBUID0123456789' });
 */
export function channelPlatformId(entry, host) {
  if (isUsableIdentity(entry.uid)) {
    return String(entry.uid).toUpperCase();
  }
  return `${platformIdOf(host)}-ch${entry.channel}`;
}

/**
 * Resolve ONE camera sitting on one channel of a host.
 *
 * Every command here names its channel: behind a hub the same address answers
 * for every camera, and a missing channel silently returns the state of the
 * first one — which is how five cameras end up all reporting the motion of one.
 * @param {object} context - The host context.
 * @param {object} context.api - The API client of the host.
 * @param {object} context.candidate - What discovery knew about the address.
 * @param {object} context.devInfo - The `DevInfo` of the host.
 * @param {object} context.account - The credentials for this address.
 * @param {boolean} context.multiChannel - Whether the host fronts several cameras.
 * @param {object} [context.netPorts] - The RTSP/ONVIF servers of the host.
 * @param {object} config - The normalized configuration.
 * @param {object} entry - The channel, from `listChannels`.
 * @returns {Promise<object|null>} The resolved camera, or null.
 * @example
 * await resolveChannel(context, config, { channel: 1 });
 */
export async function resolveChannel(
  { api, candidate, devInfo, account, multiChannel, netPorts },
  config,
  entry,
) {
  const { channel } = entry;

  // `GetAbility` is answered by the HOST, not by the camera on this channel, so
  // its per-channel `abilityChn[channel]` block is what actually describes this
  // camera. `resolveCapabilities` already looks there.
  const [ability, aiState] = await Promise.all([
    api.getAbility(),
    api.send('GetAiState', { channel }),
  ]);

  const capabilities = resolveCapabilities({ ability, aiState, devInfo, channel });

  // Behind a hub the doorbell cannot be read from abilities: the hub declares
  // its own, and it has no button. The per-channel model string is the only
  // marker left.
  if (entry.isDoorbell && !capabilities.includes(CAPABILITIES.DOORBELL)) {
    capabilities.push(CAPABILITIES.DOORBELL);
  }

  const codecs = await readCodecs(api, channel);

  // The presets become the options of a labeled list, so they are read now. A
  // camera that cannot list them keeps its arrows; only the list is missing.
  const presets = capabilities.includes(CAPABILITIES.PTZ_PRESETS)
    ? await listPresets(api, channel).catch((e) => {
        logger.debug(`Reading the presets of channel ${channel} failed: ${e.message}`);
        return [];
      })
    : [];

  const ports = netPorts || {};
  // ONVIF events only for a wired camera reached directly: battery models have
  // no ONVIF server, and behind a hub the events do not say reliably which
  // camera they come from.
  const onvifUsable =
    !multiChannel &&
    ports.onvifEnabled !== false &&
    Boolean(ports.onvifPort) &&
    !capabilities.includes(CAPABILITIES.BATTERY);

  const host = {
    uid: [candidate.uid, devInfo.serial].find(isUsableIdentity) || null,
    mac: candidate.mac || null,
    ip: candidate.ip,
  };

  const camera = {
    // Behind a hub, the name of the CHANNEL is the one the user set in the
    // Reolink app for that camera; `devInfo.name` is the hub's own name, which
    // would label all five cameras identically.
    name:
      entry.name ||
      (multiChannel
        ? `${devInfo.name || 'Reolink'} - channel ${channel + 1}`
        : devInfo.name || candidate.name || `Reolink ${candidate.ip}`),
    model: entry.model || devInfo.model || '',
    ip: candidate.ip,
    port: api.port,
    https: api.https,
    channel,
    // The hub answers for a sleeping camera, so this is known here and worth
    // carrying: it decides whether the camera may be talked to at all.
    sleeping: entry.sleeping,
    uid: multiChannel ? entry.uid : host.uid,
    hostUid: multiChannel ? host.uid : null,
    mac: multiChannel ? null : host.mac,
    capabilities,
    codecs,
    presets,
    rtspPort: ports.rtspPort || null,
    rtspEnabled: ports.rtspEnabled !== false,
    onvifPort: onvifUsable ? ports.onvifPort : 0,
  };

  camera.platformId = multiChannel ? channelPlatformId(entry, host) : platformIdOf(camera);
  camera.streamUrl = buildRtspUrl(camera, account, config.stream_quality);

  logger.info(
    `"${camera.name}" (${camera.model} at ${camera.ip}${multiChannel ? `, channel ${channel}` : ''}) offers: ${capabilities.join(', ') || 'image and motion only'}`,
  );
  if (!camera.rtspEnabled) {
    logger.warn(
      `"${camera.name}": the RTSP server is disabled, so the live view will not start. Enable it in the Reolink app (Settings → Network → Advanced → Server settings).`,
    );
  }
  return camera;
}

/**
 * Ask one address who it is and what it can do.
 *
 * This is the only place that talks to a camera during discovery, and it is
 * deliberately tolerant: an address that does not answer, or answers something
 * that is not a Reolink API, yields an empty list rather than failing the whole
 * scan — the network may well hold devices that are not cameras.
 *
 * One address may yield SEVERAL cameras: a Home Hub or an NVR fronts one camera
 * per channel, all sharing this address, port and session.
 * @param {object} candidate - `{ ip, port, uid, mac, name }`.
 * @param {object} config - The normalized configuration.
 * @returns {Promise<object[]>} The resolved cameras, possibly empty.
 * @example
 * const cameras = await resolveCameras({ ip: '192.168.1.42' }, config);
 */
export async function resolveCameras(candidate, config) {
  const account = resolveAccount(config, candidate.ip);
  const api = new ReolinkApi({
    ip: candidate.ip,
    port: candidate.port || undefined,
    username: account.username,
    password: account.password,
    timeoutMs: config.capture_timeout * 1000,
  });

  try {
    const devInfo = await api.getDevInfo();
    if (!devInfo) {
      logger.debug(`${candidate.ip} answered, but not like a Reolink camera`);
      return [];
    }

    const multiChannel = isMultiChannelHost(devInfo);
    const channels = await listChannels(api, devInfo);
    // Once per ADDRESS: the servers belong to the host, a hub serves the RTSP
    // streams of all its cameras on one port.
    const netPorts = await readNetPorts(api).catch(() => null);
    const context = { api, candidate, devInfo, account, multiChannel, netPorts };

    // Sequential on purpose, unlike the per-address parallelism above: these
    // all share ONE session on ONE device, and firing a dozen batches at a hub
    // is how its firmware starts refusing commands mid-scan.
    const cameras = [];
    for (const entry of channels) {
      try {
        cameras.push(await resolveChannel(context, config, entry));
      } catch (e) {
        // One unreadable camera must not cost the others: a hub commonly holds
        // one camera that is out of range while the rest answer fine.
        logger.warn(
          `The camera on channel ${entry.channel} of ${candidate.ip} could not be identified: ${e.message}`,
        );
      }
    }
    return cameras;
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
    return [];
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

  // Identifying is I/O bound and independent per ADDRESS, so resolve them
  // together rather than paying the timeout of each unreachable one in turn.
  // One address may yield several cameras when a Home Hub or an NVR fronts them.
  const perAddress = await Promise.all(
    [...candidates.values()].map((candidate) => resolveCameras(candidate, config)),
  );

  const resolved = dedupePlatformIds(perAddress.flat().filter((camera) => camera !== null));
  return resolved.map((camera) => buildDevice(gladys, camera));
}

/**
 * Make sure two distinct cameras never carry the same platform id.
 *
 * Gladys upserts a device on its `external_id`, so two cameras sharing one id do
 * not produce two devices: the second overwrites the first, and the user sees
 * both in the Discovery screen but only one in Devices. That is a silent loss —
 * the very failure this function turns into a warning plus a distinct id.
 *
 * The first camera keeps the contested id, so an installation that already works
 * does not see its device recreated under a new id; the others fall back to what
 * still tells them apart, the MAC then the address.
 * @param {object[]} cameras - The resolved cameras, each carrying a platformId.
 * @returns {object[]} The same cameras, with unique platform ids.
 * @example
 * dedupePlatformIds([camA, camB]);
 */
export function dedupePlatformIds(cameras) {
  /** @type {Map<string, object>} */
  const taken = new Map();

  cameras.forEach((camera) => {
    const first = taken.get(camera.platformId);
    if (!first) {
      taken.set(camera.platformId, camera);
      return;
    }

    // The MAC is per-hardware, the address is at least per-host: either one tells
    // these two cameras apart when the announced identity did not.
    const contested = camera.platformId;
    const address = String(camera.ip || '').replace(/[.:]/g, '-');
    let fallback = platformIdOf({ uid: null, mac: camera.mac, ip: camera.ip });

    // The MAC may be shared too — the same camera answering on two addresses, or
    // a MAC read from the wrong interface. The address then has to join the id,
    // and a counter closes the last gap, because the whole point here is that no
    // camera is ever dropped for want of a distinct id.
    if (fallback !== address && taken.has(fallback)) {
      fallback = `${fallback}-${address}`;
    }
    let unique = fallback;
    for (let suffix = 2; taken.has(unique); suffix += 1) {
      unique = `${fallback}-${suffix}`;
    }

    logger.warn(
      `"${camera.name}" (${camera.ip}) announced the same identity "${contested}" as "${first.name}" (${first.ip}). Using "${unique}" instead, so both cameras exist in Gladys. Check the UID of these cameras in the Reolink app if either one behaves oddly.`,
    );
    camera.platformId = unique;
    taken.set(camera.platformId, camera);
  });

  return cameras;
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

  // A device created before hub support carries no channel param; channel 0 is
  // exactly right for it, since it could only ever have been a direct camera.
  const storedChannel = Number(getParam(device, DEVICE_PARAMS.CHANNEL));
  const channel =
    Number.isInteger(storedChannel) && storedChannel >= 0 ? storedChannel : DEFAULT_CHANNEL;

  const camera = {
    name: device.name || 'Reolink camera',
    ip,
    port,
    https,
    channel,
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
