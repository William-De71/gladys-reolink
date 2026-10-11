import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setFloodlight,
  setSiren,
  setIrLights,
  goToPreset,
  listPresets,
  getFloodlightState,
  getIrLightsState,
  getBattery,
  ptzStep,
  isFullDaySchedule,
} from '../src/reolink/commands.js';
import { CAMERA_MOVE } from '../src/reolink/constants.js';
import { fakeApi } from './helpers/fakeGladys.js';

/**
 * A fake client accepting every command, recording what it was sent. Reads
 * answer from `values` (`GetWhiteLed` → its value) and are not recorded.
 * @param {Record<string, object>} [values] - What the reads answer.
 * @returns {object} The fake.
 */
function acceptingApi(values = {}) {
  return {
    sent: [],
    async sendBatch(commands) {
      this.sent.push(...commands);
      return commands.map((command) => ({ cmd: command.cmd, code: 0, value: {} }));
    },
    async send(cmd) {
      return values[cmd] ?? null;
    },
  };
}

/**
 * A fake client refusing every command.
 * @param {number} code - The error code to report.
 * @returns {object} The fake.
 */
function refusingApi(code) {
  return {
    async sendBatch(commands) {
      return commands.map((command) => ({ cmd: command.cmd, code: 1, error: { rspCode: code } }));
    },
    async send() {
      return null;
    },
  };
}

/** The settings a user made in the Reolink app: auto at night, 19:00 to 23:00. */
const USER_LIGHTING = {
  GetWhiteLed: {
    WhiteLed: {
      state: 0,
      mode: 1,
      bright: 70,
      LightingSchedule: { StartHour: 19, StartMin: 0, EndHour: 23, EndMin: 0 },
    },
  },
};

test('turning the spotlight on widens its schedule to the whole day', async () => {
  // Mode 3 is "on according to the schedule": without widening it, the camera
  // accepts the command and leaves the light off outside its night window.
  const api = acceptingApi();
  await setFloodlight(api, true);

  const { WhiteLed } = api.sent[0].param;
  assert.equal(WhiteLed.state, 1);
  assert.equal(WhiteLed.mode, 3);
  assert.equal(WhiteLed.LightingSchedule.EndHour, 23);
  assert.equal(WhiteLed.LightingSchedule.EndMin, 59);
});

test('turning the spotlight on keeps its brightness and returns the settings to restore', async () => {
  const api = acceptingApi(USER_LIGHTING);
  const saved = await setFloodlight(api, true);

  assert.equal(api.sent[0].param.WhiteLed.bright, 70);
  assert.deepEqual(saved, {
    mode: 1,
    LightingSchedule: { StartHour: 19, StartMin: 0, EndHour: 23, EndMin: 0 },
  });
});

test('turning the spotlight off restores the schedule set in the Reolink app', async () => {
  // The former OFF wrote a blank 00:00-00:00 schedule, silently wiping the
  // one the user configured in the app.
  const api = acceptingApi();
  const previous = USER_LIGHTING.GetWhiteLed.WhiteLed;
  await setFloodlight(api, false, { previous });

  const { WhiteLed } = api.sent[0].param;
  assert.equal(WhiteLed.state, 0);
  assert.equal(WhiteLed.mode, 1);
  assert.deepEqual(WhiteLed.LightingSchedule, previous.LightingSchedule);
});

test('a second ON keeps the original settings, not the full-day ones', async () => {
  const api = acceptingApi({
    GetWhiteLed: {
      WhiteLed: {
        mode: 3,
        LightingSchedule: { StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 },
      },
    },
  });
  const original = { mode: 1, LightingSchedule: { StartHour: 19 } };
  assert.equal(await setFloodlight(api, true, { previous: original }), original);
});

test('turning the spotlight off after a restart undoes only our own schedule', async () => {
  // Nothing remembered: the full-day schedule written by Gladys goes back to
  // the night mode, any other setting is left alone.
  const ours = acceptingApi({
    GetWhiteLed: {
      WhiteLed: {
        mode: 3,
        LightingSchedule: { StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 },
      },
    },
  });
  await setFloodlight(ours, false);
  assert.equal(ours.sent[0].param.WhiteLed.mode, 1);
  assert.equal(ours.sent[0].param.WhiteLed.LightingSchedule, undefined);

  const theirs = acceptingApi(USER_LIGHTING);
  await setFloodlight(theirs, false);
  assert.deepEqual(theirs.sent[0].param.WhiteLed, { channel: 0, state: 0 });
});

test('isFullDaySchedule only matches 00:00 to 23:59', () => {
  assert.equal(isFullDaySchedule({ StartHour: 0, StartMin: 0, EndHour: 23, EndMin: 59 }), true);
  assert.equal(isFullDaySchedule({ StartHour: 19, StartMin: 0, EndHour: 23, EndMin: 59 }), false);
  assert.equal(isFullDaySchedule(null), false);
});

test('a PTZ step moves then stops on its own', async () => {
  // PtzCtrl starts a continuous move: without the Stop, a scene action would
  // leave the camera turning until someone noticed.
  const api = acceptingApi();
  await ptzStep(api, CAMERA_MOVE.PAN_LEFT, { durationMs: 1 });
  assert.deepEqual(
    api.sent.map((command) => command.param.op),
    ['Left', 'Stop'],
  );
});

test('a PTZ stop is sent at once and an unknown movement is refused', async () => {
  const api = acceptingApi();
  await ptzStep(api, CAMERA_MOVE.STOP);
  assert.deepEqual(
    api.sent.map((command) => command.param.op),
    ['Stop'],
  );
  await assert.rejects(() => ptzStep(api, 42), /REOLINK_PTZ_UNKNOWN_MOVE/);
});

test('zooming maps onto the firmware operations', async () => {
  const api = acceptingApi();
  await ptzStep(api, CAMERA_MOVE.ZOOM_IN, { durationMs: 1 });
  assert.equal(api.sent[0].param.op, 'ZoomInc');
});

test('the siren latches so it can be stopped again', async () => {
  // `times` would play a fixed number of times and ignore any stop command — a
  // siren that cannot be silenced from Gladys is a genuine nuisance.
  const api = acceptingApi();
  await setSiren(api, true);
  assert.equal(api.sent[0].param.alarm_mode, 'manul');
  assert.equal(api.sent[0].param.manual_switch, 1);

  await setSiren(api, false);
  assert.equal(api.sent[1].param.manual_switch, 0);
});

test('the infrared LEDs take a mode, not a boolean', async () => {
  const api = acceptingApi();
  await setIrLights(api, true);
  assert.equal(api.sent[0].param.IrLights.state, 'Auto');

  await setIrLights(api, false);
  assert.equal(api.sent[1].param.IrLights.state, 'Off');
});

test('goToPreset sends the move the firmware expects', async () => {
  const api = acceptingApi();
  await goToPreset(api, 3);
  assert.equal(api.sent[0].cmd, 'PtzCtrl');
  assert.equal(api.sent[0].param.op, 'ToPos');
  assert.equal(api.sent[0].param.id, 3);
});

test('a refused command is reported rather than swallowed', async () => {
  // A command the camera silently ignores is worse than one that fails loudly.
  await assert.rejects(() => setFloodlight(refusingApi(-9), true), /REOLINK_SetWhiteLed_REFUSED/);
  await assert.rejects(() => setSiren(refusingApi(-9), true), /REOLINK_AudioAlarmPlay_REFUSED/);
});

test('listPresets only returns the slots that are actually saved', async () => {
  // The firmware always reports 64 slots, the empty ones carrying `enable: 0`
  // and a placeholder name.
  const api = fakeApi({
    GetPtzPreset: {
      PtzPreset: [
        { id: 1, enable: 1, name: 'Gate' },
        { id: 2, enable: 0, name: 'preset_2' },
        { id: 3, enable: 1, name: 'Driveway' },
      ],
    },
  });

  assert.deepEqual(await listPresets(api), [
    { id: 1, name: 'Gate' },
    { id: 3, name: 'Driveway' },
  ]);
});

test('listPresets never hands Gladys a blank label or a duplicate number', async () => {
  // Either one makes Gladys refuse the option list, and the device with it.
  const api = fakeApi({
    GetPtzPreset: {
      PtzPreset: [
        { id: 4, enable: 1, name: '   ' },
        { id: 4, enable: 1, name: 'Again' },
      ],
    },
  });
  assert.deepEqual(await listPresets(api), [{ id: 4, name: 'Preset 4' }]);
});

test('listPresets returns nothing when the camera has no PTZ', async () => {
  assert.deepEqual(await listPresets(fakeApi({})), []);
});

test('the readable actuator states come back as booleans', async () => {
  assert.equal(
    await getFloodlightState(fakeApi({ GetWhiteLed: { WhiteLed: { state: 1 } } })),
    true,
  );
  assert.equal(
    await getFloodlightState(fakeApi({ GetWhiteLed: { WhiteLed: { state: 0 } } })),
    false,
  );
  assert.equal(
    await getIrLightsState(fakeApi({ GetIrLights: { IrLights: { state: 'Auto' } } })),
    true,
  );
  assert.equal(
    await getIrLightsState(fakeApi({ GetIrLights: { IrLights: { state: 'Off' } } })),
    false,
  );
});

test('an unreadable actuator returns null rather than a wrong state', async () => {
  // Publishing `false` for a state we could not read would show the spotlight as
  // off while it is on.
  assert.equal(await getFloodlightState(fakeApi({})), null);
  assert.equal(await getIrLightsState(fakeApi({})), null);
});

test('getBattery reads the block the guard needs', async () => {
  const api = fakeApi({ GetBatteryInfo: { Battery: { batteryPercent: 62, chargeStatus: 1 } } });
  assert.deepEqual(await getBattery(api), { batteryPercent: 62, chargeStatus: 1 });
  assert.equal(await getBattery(fakeApi({})), null);
});
