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
import { DEFAULT_CHANNEL } from './constants.js';

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

/**
 * Turn the spotlight (white LED) on or off.
 *
 * `SetWhiteLed` carries a mode alongside the state, and the mode is what makes
 * the switch behave: mode 3 is "on according to the schedule", so turning the
 * light ON also means widening that schedule to the whole day — otherwise the
 * camera accepts the command and leaves the light off outside its night window.
 * Turning it OFF puts the mode back to 1 (night mode, camera-driven).
 * @param {object} api - The camera API client.
 * @param {boolean} on - The wanted state.
 * @param {object} [options] - Extra options.
 * @param {number} [options.channel] - The video channel.
 * @param {number} [options.brightness] - Brightness, 0-100.
 * @returns {Promise<void>} Resolves once applied.
 * @example
 * await setFloodlight(api, true);
 */
export async function setFloodlight(api, on, { channel = DEFAULT_CHANNEL, brightness = 100 } = {}) {
  await sendSetting(api, 'SetWhiteLed', {
    WhiteLed: {
      channel,
      state: on ? 1 : 0,
      mode: on ? 3 : 1,
      bright: brightness,
      LightingSchedule: on
        ? { StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 }
        : { StartHour: 0, StartMin: 0, EndHour: 0, EndMin: 0 },
    },
  });
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
  return presets
    .filter((preset) => Number(preset?.enable) === 1)
    .map((preset) => ({
      id: Number(preset.id),
      name: String(preset.name || `Preset ${preset.id}`),
    }))
    .filter((preset) => Number.isFinite(preset.id));
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
