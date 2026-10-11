// -----------------------------------------------------------------------------
// The things a camera can be told to DO.
//
// Everything here is the write side of the API, reached from `onSetValue` when
// the user flips a switch on the dashboard or a scene actions the camera.
//
// One rule shapes this module: a command that the camera silently ignores is
// worse than one that fails loudly. Reolink answers `code: 0` liberally, so each
// helper checks the specific error code the firmware uses and turns it into a
// thrown error the caller can report.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { errorCodeOf } from './api.js';
import {
  DEFAULT_CHANNEL,
  CAMERA_MOVE,
  PTZ_OPERATIONS,
  PTZ_STEP_MS,
  PTZ_STEP_SPEED,
} from './constants.js';

/**
 * Send one setting command and make sure it was accepted.
 * @param {object} api - The camera API client.
 * @param {string} cmd - The command name.
 * @param {object} param - Its parameters.
 * @returns {Promise<void>} Resolves when the camera accepted it.
 * @example
 * await sendSetting(api, 'SetIrLights', { IrLights: { channel: 0, state: 'Auto' } });
 */
async function sendSetting(api, cmd, param) {
  const [result] = await api.sendBatch([{ cmd, action: 0, param }]);
  const code = errorCodeOf(result);
  if (code !== 0) {
    throw new Error(`REOLINK_${cmd}_REFUSED:${code}`);
  }
}

/** The schedule written when the spotlight is turned on: the whole day. */
const FULL_DAY_SCHEDULE = { StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 };

/**
 * Tell whether a lighting schedule is the full-day one this module writes.
 * @param {object|null|undefined} schedule - The `LightingSchedule` block.
 * @returns {boolean} True for 00:00 → 23:59.
 * @example
 * isFullDaySchedule({ StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 }); // true
 */
export function isFullDaySchedule(schedule) {
  return Object.entries(FULL_DAY_SCHEDULE).every(
    ([key, value]) => Number(schedule?.[key]) === value,
  );
}

/**
 * Turn the spotlight (white LED) on or off, without losing the user's own
 * lighting settings.
 *
 * `SetWhiteLed` carries a mode alongside the state, and the mode is what makes
 * the switch behave: mode 3 is "on according to the schedule", so turning the
 * light ON also means widening that schedule to the whole day — otherwise the
 * camera accepts the command and leaves the light off outside its night window.
 *
 * Those are the user's settings, made in the Reolink app. They are therefore
 * READ before being overwritten and handed back to the caller, which passes
 * them to the matching OFF so it restores exactly what was there. The previous
 * version reset them to a blank schedule on every OFF, which silently wiped the
 * lighting schedule configured in the app.
 *
 * When the OFF has nothing to restore (the integration restarted in between),
 * the full-day schedule this module wrote is recognised and handed back to the
 * camera's night mode; any other setting is left alone.
 * @param {object} api - The camera API client.
 * @param {boolean} on - The wanted state.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @param {number} [options.brightness] - Brightness, 0-100, when turning on.
 * @param {object|null} [options.previous] - What a previous ON returned.
 * @returns {Promise<object|null>} On ON, the settings to restore later.
 * @example
 * const previous = await setFloodlight(api, true);
 * await setFloodlight(api, false, { previous });
 */
export async function setFloodlight(
  api,
  on,
  { channel = DEFAULT_CHANNEL, brightness, previous = null } = {},
) {
  const current = (await api.send('GetWhiteLed', { channel }))?.WhiteLed ?? null;

  if (on) {
    // Already turned on by Gladys and not off since: what to restore is still
    // the original, not the full-day schedule written by that first ON.
    const saved =
      previous ??
      (current ? { mode: current.mode, LightingSchedule: current.LightingSchedule } : null);
    await sendSetting(api, 'SetWhiteLed', {
      WhiteLed: {
        channel,
        state: 1,
        mode: 3,
        bright: brightness ?? current?.bright ?? 100,
        LightingSchedule: FULL_DAY_SCHEDULE,
      },
    });
    return saved;
  }

  const whiteLed = { channel, state: 0 };
  if (previous && previous.mode !== undefined) {
    whiteLed.mode = previous.mode;
    if (previous.LightingSchedule) {
      whiteLed.LightingSchedule = previous.LightingSchedule;
    }
  } else if (Number(current?.mode) === 3 && isFullDaySchedule(current?.LightingSchedule)) {
    // Our own full-day schedule, left behind by an ON whose settings were lost
    // with a restart: the night mode is the camera's own default.
    whiteLed.mode = 1;
  }
  await sendSetting(api, 'SetWhiteLed', { WhiteLed: whiteLed });
  return null;
}

/**
 * Move the camera for one bounded step.
 *
 * `PtzCtrl` starts a CONTINUOUS movement that only ends on `Stop`, so the stop
 * is sent by this function after `PTZ_STEP_MS` — never left to a later message
 * that a scene or a lost dashboard release would not send. `STOP` itself stops
 * at once.
 * @param {object} api - The camera API client.
 * @param {number} movement - A `CAMERA_MOVE` value.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @param {number} [options.durationMs] - How long the step lasts.
 * @returns {Promise<void>} Resolves once the camera has stopped.
 * @example
 * await ptzStep(api, CAMERA_MOVE.PAN_LEFT);
 */
export async function ptzStep(
  api,
  movement,
  { channel = DEFAULT_CHANNEL, durationMs = PTZ_STEP_MS } = {},
) {
  const op = PTZ_OPERATIONS[movement];
  if (!op) {
    throw new Error(`REOLINK_PTZ_UNKNOWN_MOVE:${movement}`);
  }
  if (movement === CAMERA_MOVE.STOP) {
    await sendSetting(api, 'PtzCtrl', { channel, op: 'Stop' });
    return;
  }
  await sendSetting(api, 'PtzCtrl', { channel, op, speed: PTZ_STEP_SPEED });
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  // Retried once: a camera left moving is the one outcome to avoid.
  await sendSetting(api, 'PtzCtrl', { channel, op: 'Stop' }).catch(() =>
    sendSetting(api, 'PtzCtrl', { channel, op: 'Stop' }),
  );
}

/**
 * Sound the siren, or stop it.
 *
 * Two alarm modes exist and they are not interchangeable: `times` plays the
 * sound a fixed number of times and stops on its own, `manul` (the firmware's
 * spelling) latches until it is switched off. A siren that cannot be stopped
 * from Gladys would be a genuine nuisance, so the ON path latches and the OFF
 * path releases.
 * @param {object} api - The camera API client.
 * @param {boolean} on - True to start, false to stop.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @returns {Promise<void>} Resolves once applied.
 * @example
 * await setSiren(api, true);
 */
export async function setSiren(api, on, { channel = DEFAULT_CHANNEL } = {}) {
  await sendSetting(api, 'AudioAlarmPlay', {
    channel,
    alarm_mode: 'manul',
    manual_switch: on ? 1 : 0,
  });
}

/**
 * Set the infrared LEDs.
 *
 * The firmware takes a mode, not a boolean: `Auto` lets the camera switch them
 * on in the dark, `Off` keeps them off. There is no "always on" — the LEDs only
 * ever light when the sensor decides it is dark enough.
 * @param {object} api - The camera API client.
 * @param {boolean} on - True for `Auto`, false for `Off`.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @returns {Promise<void>} Resolves once applied.
 * @example
 * await setIrLights(api, true);
 */
export async function setIrLights(api, on, { channel = DEFAULT_CHANNEL } = {}) {
  await sendSetting(api, 'SetIrLights', {
    IrLights: { channel, state: on ? 'Auto' : 'Off' },
  });
}

/**
 * Move the camera to one of its saved PTZ presets.
 * @param {object} api - The camera API client.
 * @param {number} presetId - The preset id, as `GetPtzPreset` reports it.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @param {number} [options.speed] - Movement speed, 1-64.
 * @returns {Promise<void>} Resolves once the camera accepted the move.
 * @example
 * await goToPreset(api, 1);
 */
export async function goToPreset(api, presetId, { channel = DEFAULT_CHANNEL, speed = 32 } = {}) {
  await sendSetting(api, 'PtzCtrl', { channel, op: 'ToPos', id: presetId, speed });
}

/**
 * List the PTZ presets a camera has saved.
 *
 * Only the ENABLED ones are returned: the firmware always reports 64 slots,
 * the empty ones carrying `enable: 0` and a placeholder name.
 * @param {object} api - The camera API client.
 * @param {number} [channel] - The video channel.
 * @returns {Promise<object[]>} The presets, as `{ id, name }`.
 * @example
 * const presets = await listPresets(api);
 */
export async function listPresets(api, channel = DEFAULT_CHANNEL) {
  const value = await api.send('GetPtzPreset', { channel });
  const presets = value?.PtzPreset;
  if (!Array.isArray(presets)) {
    return [];
  }
  return (
    presets
      .filter((preset) => Number(preset?.enable) === 1)
      .map((preset) => ({
        id: Number(preset.id),
        // Never blank: the names become the labels of the Preset list, and Gladys
        // refuses an empty label — with the whole device along with it.
        name: String(preset.name ?? '').trim() || `Preset ${preset.id}`,
      }))
      .filter((preset) => Number.isInteger(preset.id))
      // One entry per number: Gladys refuses duplicate option values as well.
      .filter((preset, index, all) => all.findIndex((other) => other.id === preset.id) === index)
  );
}

/**
 * Read the current spotlight state.
 * @param {object} api - The camera API client.
 * @param {number} [channel] - The video channel.
 * @returns {Promise<boolean|null>} The state, or null when unreadable.
 * @example
 * await getFloodlightState(api);
 */
export async function getFloodlightState(api, channel = DEFAULT_CHANNEL) {
  const value = await api.send('GetWhiteLed', { channel });
  const state = value?.WhiteLed?.state;
  return state === undefined ? null : Number(state) === 1;
}

/**
 * Read the current infrared LED mode.
 * @param {object} api - The camera API client.
 * @param {number} [channel] - The video channel.
 * @returns {Promise<boolean|null>} True when not `Off`, or null when unreadable.
 * @example
 * await getIrLightsState(api);
 */
export async function getIrLightsState(api, channel = DEFAULT_CHANNEL) {
  const value = await api.send('GetIrLights', { channel });
  const state = value?.IrLights?.state;
  return state === undefined ? null : String(state) !== 'Off';
}

/**
 * Read the battery block of a camera.
 * @param {object} api - The camera API client.
 * @param {number} [channel] - The video channel.
 * @returns {Promise<object|null>} The `Battery` block, or null.
 * @example
 * const battery = await getBattery(api);
 */
export async function getBattery(api, channel = DEFAULT_CHANNEL) {
  const value = await api.send('GetBatteryInfo', { channel });
  return value?.Battery ?? null;
}

/**
 * Log a command failure without letting it break the caller.
 * @param {string} what - What was attempted.
 * @param {Error} error - The failure.
 * @example
 * logCommandFailure('the siren', error);
 */
export function logCommandFailure(what, error) {
  logger.warn(`Controlling ${what} failed: ${error.message}`);
}
