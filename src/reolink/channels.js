// -----------------------------------------------------------------------------
// Enumerating the cameras behind ONE address.
//
// A Reolink camera used on its own is one camera on channel 0. A Home Hub — and
// an NVR, which behaves identically here — puts SEVERAL cameras behind a single
// address, port and session, each one on its own channel. `GetChannelstatus` is
// what lists them:
//
//   [{ "cmd": "GetChannelstatus", "action": 0, "param": {} }]
//   -> { "count": 4, "status": [
//          { "channel": 0, "online": 1, "name": "Garden",
//            "typeInfo": "Argus 3 Ultra", "uid": "95270005ZBCDEFGH", "sleep": 0 },
//          ...
//        ] }
//
// Three of those fields are OPTIONAL and firmware-dependent — `name`, `typeInfo`
// and `uid` are each missing on some models — so everything here degrades to a
// usable answer rather than trusting the shape.
//
// A hub that omits `typeInfo` is asked again with `GetChnTypeInfo`, one entry
// per channel in a single batch. That matters beyond cosmetics: the model is
// what tells a doorbell from an ordinary camera behind a hub, and without it the
// doorbell button is never published.
//
// Two fields deserve their own note:
//
//   `online`  a hub remembers a camera that is unpaired or out of range and
//             keeps announcing its channel with `online: 0`. Publishing those
//             would create Gladys devices that can never answer.
//
//   `sleep`   a battery camera behind a hub sleeps between events, and the hub
//             answers FOR it while it does. Talking to a sleeping camera wakes
//             its radio, which is the single most expensive thing that can be
//             done to a battery model — so this is read on every poll and gates
//             what may be asked (see batteryGuard.js).
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { errorCodeOf } from './api.js';
import {
  DEFAULT_CHANNEL,
  MULTI_CHANNEL_DEVICE_TYPES,
  DOORBELL_MODEL_MARKER,
  DOORBELL_BOARD_PREFIX,
  CHANNEL_TYPE_COMMAND,
  MAX_CHANNELS,
} from './constants.js';

/**
 * Tell whether a model and a board name describe a doorbell.
 *
 * Two independent markers, because neither is always there: `typeInfo` carries
 * the commercial name ("Reolink Video Doorbell"), which is translated on some
 * markets, and `boardInfo` names the hardware, which starts with `DB_` on every
 * doorbell board. Either one is enough.
 * @param {string|null} model - The `typeInfo` string.
 * @param {string|null} board - The `boardInfo` string.
 * @returns {boolean} True when this channel hosts a doorbell.
 * @example
 * isDoorbellModel('Reolink Video Doorbell', null); // true
 * isDoorbellModel(null, 'DB_560MIXDB32M35DBB14MP'); // true
 */
export function isDoorbellModel(model, board) {
  if (typeof model === 'string' && model.includes(DOORBELL_MODEL_MARKER)) {
    return true;
  }
  return typeof board === 'string' && board.startsWith(DOORBELL_BOARD_PREFIX);
}

/**
 * Tell whether a `GetDevInfo` block describes a device hosting several cameras.
 *
 * The firmware announces its nature in `exactType`, older ones in `type`; both
 * are checked because a Home Hub answering only the legacy field would
 * otherwise be taken for a single camera and publish channel 0 alone.
 * @param {object|null} devInfo - The `DevInfo` block.
 * @returns {boolean} True for a Home Hub or an NVR.
 * @example
 * isMultiChannelHost({ exactType: 'HOMEHUB' }); // true
 */
export function isMultiChannelHost(devInfo) {
  if (!devInfo) {
    return false;
  }
  const announced = [devInfo.exactType, devInfo.type]
    .filter((value) => typeof value === 'string')
    .map((value) => value.toUpperCase());
  return announced.some((value) => MULTI_CHANNEL_DEVICE_TYPES.includes(value));
}

/**
 * Tell whether a `GetDevInfo` block describes a Home Hub specifically.
 *
 * Only used to phrase log lines: a user reads "Home Hub" on the box in their
 * hallway, and calling it an NVR in a log they are trying to follow helps
 * nobody.
 * @param {object|null} devInfo - The `DevInfo` block.
 * @returns {boolean} True for a Home Hub.
 * @example
 * isHomeHub({ exactType: 'HOMEHUB' }); // true
 */
export function isHomeHub(devInfo) {
  if (!devInfo) {
    return false;
  }
  return [devInfo.exactType, devInfo.type].some(
    (value) => typeof value === 'string' && value.toUpperCase() === 'HOMEHUB',
  );
}

/**
 * Read one entry of the `status` array into what this integration needs.
 *
 * Everything but `channel` is optional: a firmware that omits `name` leaves the
 * naming to `GetDevInfo` later, and one that omits `uid` falls back to an
 * identity derived from the host (see `devices.js`).
 * @param {object} entry - One `status` entry.
 * @returns {object|null} The channel, or null when it carries no usable number.
 * @example
 * parseChannelEntry({ channel: 1, online: 1, name: 'Gate' });
 */
export function parseChannelEntry(entry) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const channel = Number(entry.channel);
  if (!Number.isInteger(channel) || channel < 0 || channel >= MAX_CHANNELS) {
    return null;
  }

  // Some firmwares put the channel NUMBER in `name` when the user never renamed
  // the camera. "0" or "1" as a camera name in Gladys is worse than no name at
  // all, which at least falls back to something descriptive.
  const rawName = typeof entry.name === 'string' ? entry.name.trim() : '';
  const name = rawName.length > 0 && !/^\d+$/.test(rawName) ? rawName : null;

  const model = typeof entry.typeInfo === 'string' && entry.typeInfo.trim() ? entry.typeInfo : null;
  const board =
    typeof entry.boardInfo === 'string' && entry.boardInfo.trim() ? entry.boardInfo.trim() : null;
  const uid = typeof entry.uid === 'string' && entry.uid.trim() ? entry.uid.trim() : null;

  return {
    channel,
    // A firmware that omits `online` is announcing a channel it considers
    // usable, so the absence reads as online rather than as offline.
    online: entry.online === undefined ? true : Number(entry.online) === 1,
    name,
    model,
    uid,
    // Absent on wired models, and on hubs whose firmware predates the field.
    // `null` means "unknown", which is NOT the same as "awake" — the battery
    // guard treats the two differently.
    sleeping: entry.sleep === undefined ? null : Number(entry.sleep) === 1,
    isDoorbell: isDoorbellModel(model, board),
  };
}

/**
 * Read the `GetChannelstatus` answer into the list of cameras behind a host.
 * @param {object|null} value - The `value` of the answer.
 * @returns {object[]} One entry per announced channel, offline ones included.
 * @example
 * parseChannelStatus({ count: 2, status: [{ channel: 0, online: 1 }] });
 */
export function parseChannelStatus(value) {
  const status = value?.status;
  if (!Array.isArray(status)) {
    return [];
  }
  return (
    status
      .map(parseChannelEntry)
      .filter((entry) => entry !== null)
      // One hub answering twice for a channel (a retry, a firmware quirk) must
      // yield one camera, not two devices fighting over the same id.
      .filter(
        (entry, index, all) => all.findIndex((other) => other.channel === entry.channel) === index,
      )
  );
}

/**
 * Read one `GetChnTypeInfo` answer into a model and a board name.
 *
 * Firmwares disagree on the shape: some nest the fields under `ChnTypeInfo`,
 * others put them straight in `value`. Both are accepted rather than betting on
 * one.
 * @param {object|null} value - The `value` of one answer.
 * @returns {{ model: string|null, board: string|null }} What the channel announced.
 * @example
 * parseChannelType({ typeInfo: 'E1 Zoom', boardInfo: 'IPC_566SD664M5MP' });
 */
export function parseChannelType(value) {
  const block =
    value?.ChnTypeInfo && typeof value.ChnTypeInfo === 'object' ? value.ChnTypeInfo : value;
  const readString = (field) =>
    typeof block?.[field] === 'string' && block[field].trim() ? block[field].trim() : null;
  return {
    // `type` is what Home Assistant reads; this firmware answers `typeInfo`.
    model: readString('typeInfo') || readString('type'),
    board: readString('boardInfo'),
  };
}

/**
 * Fill in the model of the channels that did not announce one.
 *
 * `GetChannelstatus` carries `typeInfo` on some firmwares only, and without it a
 * doorbell is indistinguishable from an ordinary camera — so its capability
 * would never be published. One batched request covers every channel, and the
 * hub answers for its cameras, so nothing on battery is woken.
 * @param {object} api - The API client.
 * @param {object[]} channels - The channels, mutated in place.
 * @returns {Promise<void>} Resolves once the models are filled in.
 * @example
 * await fillChannelModels(api, channels);
 */
export async function fillChannelModels(api, channels) {
  const missing = channels.filter((entry) => entry.model === null);
  if (missing.length === 0) {
    return;
  }

  let answers;
  try {
    answers = await api.sendBatch(
      missing.map((entry) => ({
        cmd: CHANNEL_TYPE_COMMAND,
        action: 0,
        param: { channel: entry.channel },
      })),
    );
  } catch (e) {
    // Not fatal: the cameras still work, they just stay unlabelled.
    logger.debug(`Reading the channel types of ${api.ip} failed: ${e.message}`);
    return;
  }

  missing.forEach((entry, index) => {
    const result = answers?.[index];
    if (!result || errorCodeOf(result) !== 0) {
      return;
    }
    const { model, board } = parseChannelType(result.value);
    entry.model = model;
    if (isDoorbellModel(model, board)) {
      entry.isDoorbell = true;
    }
  });
}

/**
 * List the cameras reachable behind one address.
 *
 * A plain camera short-circuits to its single channel without a request: it has
 * no `GetChannelstatus` to answer, and asking would only add a failed command to
 * every scan.
 * @param {object} api - The API client, already able to log in.
 * @param {object|null} devInfo - The `DevInfo` block of that host.
 * @returns {Promise<object[]>} The channels to publish, offline ones dropped.
 * @example
 * const channels = await listChannels(api, devInfo);
 */
export async function listChannels(api, devInfo) {
  if (!isMultiChannelHost(devInfo)) {
    return [
      {
        channel: DEFAULT_CHANNEL,
        online: true,
        name: null,
        model: null,
        uid: null,
        sleeping: null,
        isDoorbell: false,
      },
    ];
  }

  const kind = isHomeHub(devInfo) ? 'Home Hub' : 'NVR';
  const value = await api.send('GetChannelstatus');
  let channels = parseChannelStatus(value);

  if (channels.length === 0) {
    // Older firmwares do not implement the command at all. `channelNum` still
    // says how many inputs exist, so every one of them is probed: a hub with no
    // enumerable channels would otherwise publish nothing, which looks exactly
    // like a broken integration to the user.
    const declared = Number(devInfo?.channelNum);
    if (!Number.isInteger(declared) || declared <= 0) {
      logger.warn(
        `The ${kind} at ${api.ip} announced no camera. Update its firmware if cameras are paired with it.`,
      );
      return [];
    }
    const count = Math.min(declared, MAX_CHANNELS);
    logger.warn(
      `The ${kind} at ${api.ip} does not support "GetChannelstatus" — its firmware is likely outdated. Falling back to probing its ${count} channel(s); offline ones cannot be told apart.`,
    );
    channels = Array.from({ length: count }, (unused, channel) => ({
      channel,
      online: true,
      name: null,
      model: null,
      uid: null,
      sleeping: null,
      isDoorbell: false,
    }));
  }

  const online = channels.filter((entry) => entry.online);
  // Only for the channels that will actually be published: an offline camera
  // has no model worth asking for.
  await fillChannelModels(api, online);

  const offline = channels.length - online.length;
  if (offline > 0) {
    // Worth saying: a camera the user expects to see in Gladys is missing, and
    // the reason is on the Reolink side, not here.
    logger.info(
      `The ${kind} at ${api.ip} reports ${offline} offline channel(s), which are skipped. Check they are powered and in range if a camera is missing.`,
    );
  }
  logger.info(`The ${kind} at ${api.ip} hosts ${online.length} reachable camera(s)`);
  return online;
}

/**
 * Re-read which cameras behind a host are asleep.
 *
 * Cheap by design: one command for the WHOLE hub, whatever the number of
 * cameras. That is the point — asking each battery camera whether it is awake
 * would wake it, which is exactly what the answer is meant to prevent.
 * @param {object} api - The API client.
 * @returns {Promise<Map<number, boolean>>} Sleep state per channel; missing when unknown.
 * @example
 * const sleeping = await readSleepStates(api);
 */
export async function readSleepStates(api) {
  /** @type {Map<number, boolean>} */
  const states = new Map();
  let value;
  try {
    value = await api.send('GetChannelstatus');
  } catch (e) {
    logger.debug(`Reading the sleep states of ${api.ip} failed: ${e.message}`);
    return states;
  }
  parseChannelStatus(value).forEach((entry) => {
    if (entry.sleeping !== null) {
      states.set(entry.channel, entry.sleeping);
    }
  });
  return states;
}
