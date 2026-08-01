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
} from '../src/reolink/commands.js';
import { fakeApi } from './helpers/fakeGladys.js';

/**
 * A fake client accepting every command, recording what it was sent.
 * @returns {object} The fake.
 */
function acceptingApi() {
  return {
    sent: [],
    async sendBatch(commands) {
      this.sent.push(...commands);
      return commands.map((command) => ({ cmd: command.cmd, code: 0, value: {} }));
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
  };
}

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

test('turning the spotlight off hands control back to the camera', async () => {
  const api = acceptingApi();
  await setFloodlight(api, false);

  const { WhiteLed } = api.sent[0].param;
  assert.equal(WhiteLed.state, 0);
  assert.equal(WhiteLed.mode, 1, 'mode 1 is the camera-driven night mode');
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
