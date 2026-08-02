import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventWatcher, parseMotionState, parseVisitorState } from '../src/reolink/events.js';
import { BatteryGuard } from '../src/reolink/batteryGuard.js';
import { fakeGladys, fakeDevice, fakeApi, fakeSessions } from './helpers/fakeGladys.js';
import { AI_FEATURES_ENABLED } from '../src/reolink/constants.js';

/**
 * Build a watcher over one device answering a scripted state.
 * @param {object} options - The setup.
 * @param {object} options.answers - What the camera answers, per command.
 * @param {string} [options.capabilities] - The device capabilities.
 * @param {object} [options.batteryGuard] - A guard to feed.
 * @returns {object} `{ watcher, gladys, device, api }`.
 */
function setup({ answers, capabilities = '', batteryGuard } = {}) {
  const device = fakeDevice({ capabilities });
  const gladys = fakeGladys({ devices: [device] });
  const api = fakeApi(answers);
  const sessions = fakeSessions({ api, camera: { name: device.name, channel: 0 } });
  const watcher = new EventWatcher({ gladys, batteryGuard, sessions });
  watcher.config = { capture_timeout: 10 };
  return { watcher, gladys, device, api, sessions };
}

/** The states published for one feature suffix. */
const statesFor = (gladys, suffix) =>
  gladys.published.states
    .filter((entry) => entry.featureExternalId.endsWith(`:${suffix}`))
    .map((entry) => entry.value);

test('parseMotionState reads the current motion flag', () => {
  assert.equal(parseMotionState({ state: 1 }), true);
  assert.equal(parseMotionState({ state: 0 }), false);
  assert.equal(parseMotionState(null), false);
});

test('parseVisitorState only fires on a supported, ringing doorbell', () => {
  assert.equal(parseVisitorState({ visitor: { support: 1, alarm_state: 1 } }), true);
  assert.equal(parseVisitorState({ visitor: { support: 1, alarm_state: 0 } }), false);
  // An unsupported item is "no press", not an error.
  assert.equal(parseVisitorState({ visitor: { support: 0, alarm_state: 1 } }), false);
  assert.equal(parseVisitorState({}), false);
});

test('the first round establishes a baseline without firing a detection', async () => {
  // Starting the integration must not trigger the scenes of a motion that
  // started before Gladys was even watching.
  const { watcher, gladys, device } = setup({ answers: { GetMdState: { state: 1 } } });
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'motion'), []);
});

test('a detection that starts after the baseline is published', async () => {
  const { watcher, gladys, device, api, sessions } = setup({
    answers: { GetMdState: { state: 0 } },
  });
  await watcher.checkDevice(device);

  // The camera now reports motion.
  api.batches = [];
  const moving = fakeApi({ GetMdState: { state: 1 } });
  sessions.swap({ api: moving, camera: { name: device.name, channel: 0 } });
  await watcher.checkDevice(device);

  // The leading 0 is the baseline round, which initialises the sensor to "quiet"
  // rather than leaving it without a value in Gladys.
  assert.deepEqual(statesFor(gladys, 'motion'), [0, 1]);
});

test('an unchanged state is not republished', async () => {
  // Re-publishing 1 every round while a car stays parked in frame would fill the
  // history with noise and re-trigger the scenes at each poll.
  const { watcher, gladys, device } = setup({ answers: { GetMdState: { state: 0 } } });
  await watcher.checkDevice(device);
  await watcher.checkDevice(device);
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'motion'), [0], 'only the baseline is published');
});

test('a detection coming back down is published once', async () => {
  const { watcher, gladys, device, sessions } = setup({ answers: { GetMdState: { state: 0 } } });
  await watcher.checkDevice(device);

  const moving = fakeApi({ GetMdState: { state: 1 } });
  sessions.swap({ api: moving, camera: { name: device.name, channel: 0 } });
  await watcher.checkDevice(device);

  const still = fakeApi({ GetMdState: { state: 0 } });
  sessions.swap({ api: still, camera: { name: device.name, channel: 0 } });
  await watcher.checkDevice(device);
  await watcher.checkDevice(device);

  assert.deepEqual(statesFor(gladys, 'motion'), [0, 1, 0]);
  watcher.stop();
});

test('only the AI detections the camera declared are published', async () => {
  const { watcher, gladys, device } = setup({
    answers: {
      GetMdState: { state: 0 },
      GetAiState: { channel: 0, people: { support: 1, alarm_state: 1 } },
    },
    capabilities: 'ai_people',
  });
  await watcher.checkDevice(device); // baseline
  await watcher.checkDevice(device);

  // The vehicle feature was never created, so nothing must be published for it.
  assert.deepEqual(statesFor(gladys, 'ai-vehicle'), []);
  watcher.stop();
});

// Skipped while the AI features are held back: with no presence feature to
// publish to, an AI detection is not watched at all, so there is no callback to
// fire. The test comes back with the features (see AI_FEATURES_ENABLED).
test('an AI detection fires the image callback', { skip: !AI_FEATURES_ENABLED }, async () => {
  const device = fakeDevice({ capabilities: 'ai_people' });
  const gladys = fakeGladys({ devices: [device] });
  const captured = [];

  const idle = fakeApi({ GetMdState: { state: 0 }, GetAiState: { channel: 0, people: 0 } });
  const sessions = fakeSessions({ api: idle, camera: { name: device.name, channel: 0 } });
  const watcher = new EventWatcher({
    gladys,
    sessions,
    onDetection: async (target, kind) => {
      captured.push(kind);
    },
  });
  watcher.config = { capture_timeout: 10 };

  await watcher.checkDevice(device); // baseline

  const firing = fakeApi({ GetMdState: { state: 0 }, GetAiState: { channel: 0, people: 1 } });
  sessions.swap({ api: firing, camera: { name: device.name, channel: 0 } });
  await watcher.checkDevice(device);

  assert.deepEqual(captured, ['people']);
  watcher.stop();
});

test('a doorbell press is never reset back to zero', async () => {
  // A push button has no "released" state: Gladys treats every published 1 as
  // one press, so a reset would count as a second one.
  const { watcher, gladys, device, sessions } = setup({
    answers: { GetMdState: { state: 0 }, GetAlarm: { visitor: { support: 1, alarm_state: 0 } } },
    capabilities: 'doorbell',
  });
  await watcher.checkDevice(device);

  const ringing = fakeApi({
    GetMdState: { state: 0 },
    GetAlarm: { visitor: { support: 1, alarm_state: 1 } },
  });
  sessions.swap({ api: ringing, camera: { name: device.name, channel: 0 } });
  await watcher.checkDevice(device);

  assert.deepEqual(statesFor(gladys, 'doorbell'), [0, 1]);
  assert.equal(watcher.resets.size, 0, 'a push button must schedule no reset');
});

test('the battery level is published and fed to the guard', async () => {
  const guard = new BatteryGuard();
  const { watcher, gladys, device } = setup({
    answers: {
      GetMdState: { state: 0 },
      GetBatteryInfo: { Battery: { batteryPercent: 35, chargeStatus: 0 } },
    },
    capabilities: 'battery',
    batteryGuard: guard,
  });

  await watcher.checkDevice(device);

  assert.deepEqual(statesFor(gladys, 'battery'), [35]);
  assert.equal(guard.levelOf(device.external_id), 35);
  // Below the stop threshold: the guard must have blocked the captures.
  assert.equal(guard.allowsOnDemand(device.external_id), false);
});

test('an unchanged battery level is not republished', async () => {
  // A battery moves slowly: one point per poll would be pure noise.
  const { watcher, gladys, device } = setup({
    answers: {
      GetMdState: { state: 0 },
      GetBatteryInfo: { Battery: { batteryPercent: 80, chargeStatus: 0 } },
    },
    capabilities: 'battery',
    batteryGuard: new BatteryGuard(),
  });

  await watcher.checkDevice(device);
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'battery'), [80]);
});

test('a camera without battery is not asked for one', async () => {
  // Every request wakes the radio of a battery model, so the batch only carries
  // what the camera can actually answer.
  const { watcher, device, api } = setup({ answers: { GetMdState: { state: 0 } } });
  await watcher.checkDevice(device);

  const sent = api.batches[0].map((command) => command.cmd);
  assert.ok(sent.includes('GetMdState'));
  assert.ok(!sent.includes('GetBatteryInfo'));
  assert.ok(!sent.includes('GetAlarm'));
});

test('everything is read in one batch', async () => {
  const { watcher, device, api } = setup({
    answers: {
      GetMdState: { state: 0 },
      GetAiState: { channel: 0 },
      GetBatteryInfo: { Battery: { batteryPercent: 90 } },
      GetAlarm: { visitor: { support: 1, alarm_state: 0 } },
    },
    capabilities: 'battery,doorbell',
    batteryGuard: new BatteryGuard(),
  });
  await watcher.checkDevice(device);

  assert.equal(api.batches.length, 1, 'one round trip per camera, not one per command');
  assert.equal(api.batches[0].length, 4);
});

test('a camera that stops answering drops its client so the next round reconnects', async () => {
  const device = fakeDevice();
  const gladys = fakeGladys({ devices: [device] });
  const failing = {
    async sendBatch() {
      throw new Error('ECONNREFUSED');
    },
    async logout() {},
  };
  const sessions = fakeSessions({ api: failing, camera: { name: device.name, channel: 0 } });
  const watcher = new EventWatcher({ gladys, sessions });
  watcher.config = { capture_timeout: 10 };

  await watcher.checkDevice(device);
  assert.equal(sessions.dropped, 1, 'a dead session must be dropped, not reused');
});
