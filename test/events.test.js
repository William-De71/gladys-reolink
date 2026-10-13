import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EventWatcher,
  onvifEligible,
  parseMotionState,
  parseVisitorState,
} from '../src/reolink/events.js';
import { BatteryGuard } from '../src/reolink/batteryGuard.js';
import { fakeGladys, fakeDevice, fakeApi, fakeSessions } from './helpers/fakeGladys.js';

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

test('an AI detection fires the image callback', async () => {
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

test('a doorbell press is a pulse that comes back down', async () => {
  // `doorbell/ring` is a 1 -> 0 pulse: the dashboard shows "Ringing", then the
  // time of the last ring once the value is back to 0.
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
  assert.equal(watcher.resets.size, 1, 'a ring schedules its own reset');

  sessions.swap({
    api: fakeApi({
      GetMdState: { state: 0 },
      GetAlarm: { visitor: { support: 1, alarm_state: 0 } },
    }),
    camera: { name: device.name, channel: 0 },
  });
  await watcher.checkDevice(device);

  assert.deepEqual(statesFor(gladys, 'doorbell'), [0, 1, 0]);
  watcher.stop();
});

/**
 * Pretend the ONVIF stream of a device is (or is not) delivering events.
 * @param {object} watcher - The watcher.
 * @param {object} device - The device.
 * @param {boolean} live - Whether the stream is healthy.
 */
function fakeOnvif(watcher, device, live) {
  watcher.onvif.set(device.external_id, {
    key: 'fake',
    client: { isLive: () => live, stop() {} },
  });
}

test('only a wired camera with an ONVIF port takes its detections from ONVIF', () => {
  const config = { onvif_events: true };
  assert.equal(onvifEligible(fakeDevice({ onvifPort: 8000 }), config), true);
  assert.equal(onvifEligible(fakeDevice({ onvifPort: 0 }), config), false);
  assert.equal(
    onvifEligible(fakeDevice({ onvifPort: 8000, capabilities: 'battery' }), config),
    false,
  );
  assert.equal(onvifEligible(fakeDevice({ onvifPort: 8000 }), { onvif_events: false }), false);
});

test('a camera whose ONVIF stream is live is not polled for its detections', async () => {
  const { watcher, gladys, device, api } = setup({ answers: { GetMdState: { state: 1 } } });
  fakeOnvif(watcher, device, true);

  await watcher.checkDevice(device);

  assert.equal(api.batches.length, 0, 'no request at all for a wired camera');
  assert.deepEqual(statesFor(gladys, 'motion'), []);
  watcher.onvif.clear();
});

test('a battery is still read while ONVIF delivers the detections', async () => {
  const { watcher, gladys, device, api } = setup({
    answers: { GetMdState: { state: 1 }, GetBatteryInfo: { Battery: { batteryPercent: 77 } } },
    capabilities: 'battery',
  });
  fakeOnvif(watcher, device, true);

  await watcher.checkDevice(device);

  assert.deepEqual(
    api.batches[0].map((command) => command.cmd),
    ['GetBatteryInfo'],
  );
  assert.deepEqual(statesFor(gladys, 'battery'), [77]);
  assert.deepEqual(statesFor(gladys, 'motion'), []);
  watcher.onvif.clear();
});

test('a camera falls back to polling when its ONVIF stream is down', async () => {
  const { watcher, gladys, device, sessions } = setup({ answers: { GetMdState: { state: 0 } } });
  fakeOnvif(watcher, device, false);

  await watcher.checkDevice(device);
  sessions.swap({
    api: fakeApi({ GetMdState: { state: 1 } }),
    camera: { name: 'Garden', channel: 0 },
  });
  await watcher.checkDevice(device);

  assert.deepEqual(statesFor(gladys, 'motion'), [0, 1]);
  watcher.stop();
});

test('an ONVIF motion is published at once, even before any poll', async () => {
  // Unlike a polled state, an ONVIF message IS a change: swallowing it as a
  // "baseline" would lose the first motion after every restart.
  const { watcher, gladys, device } = setup({ answers: {} });
  const captured = [];
  watcher.onDetection = async (target, kind) => captured.push(kind);

  await watcher.handleOnvifEvent(device.external_id, {
    kind: 'motion',
    active: true,
    initial: false,
  });
  await watcher.handleOnvifEvent(device.external_id, {
    kind: 'motion',
    active: false,
    initial: false,
  });

  assert.deepEqual(statesFor(gladys, 'motion'), [1, 0]);
  assert.deepEqual(captured, ['motion']);
  watcher.stop();
});

test('the snapshot sent right after subscribing never fires a scene', async () => {
  const { watcher, gladys, device } = setup({ answers: {} });
  await watcher.handleOnvifEvent(device.external_id, {
    kind: 'motion',
    active: true,
    initial: true,
  });
  assert.deepEqual(statesFor(gladys, 'motion'), []);
  watcher.stop();
});

test('an ONVIF event for a detection the camera lacks is ignored', async () => {
  const { watcher, gladys, device } = setup({ answers: {} });
  await watcher.handleOnvifEvent(device.external_id, {
    kind: 'doorbell',
    active: true,
    initial: false,
  });
  await watcher.handleOnvifEvent(device.external_id, {
    kind: 'people',
    active: true,
    initial: false,
  });
  assert.deepEqual(gladys.published.states, []);
  watcher.stop();
});

test('the ONVIF streams follow the devices: opened, kept, then released', () => {
  const device = fakeDevice({ onvifPort: 8000 });
  const gladys = fakeGladys({ devices: [device] });
  const opened = [];
  const watcher = new EventWatcher({
    gladys,
    sessions: fakeSessions(null),
    createOnvifClient: (options) => {
      const client = {
        options,
        stopped: false,
        start() {},
        stop() {
          this.stopped = true;
        },
        isLive: () => true,
      };
      opened.push(client);
      return client;
    },
  });
  watcher.config = { onvif_events: true, username: 'admin', password: 'x', camera_accounts: {} };

  watcher.syncOnvif([device]);
  watcher.syncOnvif([device]);
  assert.equal(opened.length, 1, 'kept while unchanged');
  assert.equal(opened[0].options.port, 8000);

  watcher.config = { ...watcher.config, password: 'y' };
  watcher.syncOnvif([device]);
  assert.equal(opened.length, 2, 'reopened on a new password');
  assert.equal(opened[0].stopped, true, 'the old stream is released');

  watcher.syncOnvif([]);
  assert.equal(watcher.onvif.size, 0);
  assert.equal(opened[1].stopped, true, 'released once the device is gone');
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

test('a forgotten camera publishes its battery and detections again', async () => {
  // The user creates the device: Gladys dropped every state sent before, so
  // an unchanged level must still reach the new device once.
  const { watcher, gladys, device } = setup({
    answers: {
      GetMdState: { state: 0 },
      GetBatteryInfo: { Battery: { batteryPercent: 80, chargeStatus: 0 } },
    },
    capabilities: 'battery',
    batteryGuard: new BatteryGuard(),
  });

  await watcher.checkDevice(device);
  watcher.forgetDevice(device.external_id);
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'battery'), [80, 80]);
  assert.deepEqual(statesFor(gladys, 'motion'), [0, 0]);
});

test('forgetting a camera leaves the other cameras alone', async () => {
  const { watcher, device } = setup({ answers: { GetMdState: { state: 0 } } });
  await watcher.checkDevice(device);
  watcher.published.set('ext:ext-dev-reolink:camera:OTHER:motion', 0);

  watcher.forgetDevice(device.external_id);
  assert.deepEqual([...watcher.published.keys()], ['ext:ext-dev-reolink:camera:OTHER:motion']);
});

test('the charging state is published when it changes', async () => {
  const { watcher, gladys, device, sessions } = setup({
    answers: { GetBatteryInfo: { Battery: { batteryPercent: 60, chargeStatus: 1 } } },
    capabilities: 'battery',
    batteryGuard: new BatteryGuard(),
  });
  device.features = [{ external_id: `${device.external_id}:battery-charging` }];

  await watcher.checkDevice(device);
  await watcher.checkDevice(device);
  // Full on its charger: no longer being recharged.
  sessions.swap({
    api: fakeApi({ GetBatteryInfo: { Battery: { batteryPercent: 100, chargeStatus: 2 } } }),
    camera: { name: device.name, channel: 0 },
  });
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'battery-charging'), [1, 0]);
});

test('a camera created before the charging feature is not sent its state', async () => {
  // Gladys would refuse a state for a feature the device does not have.
  const { watcher, gladys, device } = setup({
    answers: { GetBatteryInfo: { Battery: { batteryPercent: 60, chargeStatus: 1 } } },
    capabilities: 'battery',
    batteryGuard: new BatteryGuard(),
  });
  await watcher.checkDevice(device);
  assert.deepEqual(statesFor(gladys, 'battery-charging'), []);
  assert.deepEqual(statesFor(gladys, 'battery'), [60]);
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

test('a camera behind a hub is polled on its own channel', () => {
  // Getting this wrong is the classic hub failure: every command lands on
  // channel 0, and five cameras all report the motion of the first.
  const device = fakeDevice({ channel: 3 });
  const gladys = fakeGladys({ devices: [device] });
  const api = fakeApi({ GetMdState: { state: 1 } });
  const sessions = fakeSessions({ api, camera: { name: device.name, channel: 3 } });
  const watcher = new EventWatcher({ gladys, sessions });
  watcher.config = { capture_timeout: 10 };

  return watcher.checkDevice(device).then(() => {
    api.batches[0].forEach((command) => {
      assert.equal(command.param.channel, 3);
    });
  });
});

test('one command answers the sleep state of every camera behind a hub', async () => {
  // Asking each battery camera whether it is awake would WAKE it — which is
  // exactly what reading this is meant to prevent.
  const garden = fakeDevice({ platformId: 'UID1', ip: '192.168.1.50', channel: 0 });
  const gate = fakeDevice({ platformId: 'UID2', ip: '192.168.1.50', channel: 1 });
  const gladys = fakeGladys({ devices: [garden, gate] });
  const api = fakeApi({
    GetChannelstatus: {
      count: 2,
      status: [
        { channel: 0, online: 1, sleep: 1 },
        { channel: 1, online: 1, sleep: 0 },
      ],
    },
  });
  const guard = new BatteryGuard();
  const watcher = new EventWatcher({
    gladys,
    batteryGuard: guard,
    sessions: fakeSessions({ api, camera: { name: 'Hub', channel: 0 } }),
  });
  watcher.config = { capture_timeout: 10 };

  await watcher.refreshSleepStates([garden, gate]);

  assert.equal(api.batches.length, 1);
  assert.equal(guard.isSleeping(garden.external_id), true);
  assert.equal(guard.isSleeping(gate.external_id), false);
});

test('a camera reached directly is never asked whether it sleeps', async () => {
  // It has no hub to answer for it, so the question would wake the very camera
  // it is meant to leave alone.
  const device = fakeDevice({ channel: 0 });
  const gladys = fakeGladys({ devices: [device] });
  const api = fakeApi({ GetChannelstatus: { count: 1, status: [{ channel: 0, sleep: 1 }] } });
  const watcher = new EventWatcher({
    gladys,
    batteryGuard: new BatteryGuard(),
    sessions: fakeSessions({ api, camera: { name: device.name, channel: 0 } }),
  });
  watcher.config = { capture_timeout: 10 };

  await watcher.refreshSleepStates([device]);
  assert.equal(api.batches.length, 0);
});

test('a sleeping camera is not polled at all', async () => {
  // Its hub already said it has nothing new to report, and every command would
  // wake its radio for nothing.
  const device = fakeDevice({ channel: 1 });
  const gladys = fakeGladys({ devices: [device] });
  const api = fakeApi({ GetMdState: { state: 1 } });
  const guard = new BatteryGuard();
  guard.setSleeping(device.external_id, true);
  const watcher = new EventWatcher({
    gladys,
    batteryGuard: guard,
    sessions: fakeSessions({ api, camera: { name: device.name, channel: 1 } }),
  });
  watcher.config = { capture_timeout: 10 };

  await watcher.checkDevice(device);
  assert.equal(api.batches.length, 0);
});
