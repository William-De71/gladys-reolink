// -----------------------------------------------------------------------------
// index.js end to end, against the fake Gladys of the SDK.
//
// index.js builds its own `GladysIntegration` and connects on import, so the
// SDK module is mocked to hand it the fake instead, and the two modules that
// reach a camera (the session pool and the snapshot) are mocked to answer a
// scripted camera. Nothing touches the network.
//
// Needs `--experimental-test-module-mocks` (see the `test` script).
// -----------------------------------------------------------------------------

import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

import * as sdk from '@gladysassistant/integration-sdk';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

import { buildDevice } from '../src/devices.js';
import { fakeGladys, fakeApi } from './helpers/fakeGladys.js';
import { SAMPLE_CAMERAS } from './helpers/samples.js';

const IMAGE = 'image/jpg;base64,/9j/AAAA';

// A wired camera with a spotlight and infrared LEDs, without ONVIF so that no
// event stream is opened.
const camera = { ...SAMPLE_CAMERAS.wiredPtz, onvifPort: 0 };
const device = buildDevice(fakeGladys(), camera);
const featureId = (suffix) => `${device.external_id}:${suffix}`;

const api = fakeApi({
  GetWhiteLed: { WhiteLed: { state: 1, mode: 1 } },
  GetIrLights: { IrLights: { state: 'Auto' } },
  GetMdState: { state: 0 },
  GetAiState: {},
  SetWhiteLed: { rspCode: 200 },
  SetIrLights: { rspCode: 200 },
});

const gladys = createFakeGladys({
  selector: 'ext-dev-reolink',
  config: { username: 'admin', password: 'secret' },
});

const { default: _default, ...namedExports } = sdk;
mock.module('@gladysassistant/integration-sdk', {
  namedExports: {
    ...namedExports,
    GladysIntegration: function GladysIntegration() {
      return gladys;
    },
  },
});
mock.module('../src/reolink/sessions.js', {
  namedExports: {
    SessionPool: class {
      for() {
        return { api, camera: { name: camera.name, channel: 0 } };
      }
      drop() {}
      reset() {}
    },
  },
});
mock.module('../src/reolink/snapshot.js', {
  namedExports: { captureImage: async () => IMAGE },
});

await import('../index.js');
// index.js connects on its own: wait for its `connected` handler to settle.
for (let i = 0; i < 100 && gladys.fake.connectionStatuses.length === 0; i += 1) {
  await sleep(10);
}

after(() => gladys.fake.shutdown());

/** The states published for one feature, in order. */
const statesOf = (suffix) =>
  gladys.fake.states
    .filter((state) => state.device_feature_external_id === featureId(suffix))
    .map((state) => state.state);

test('a camera just created gets its actuators, detections and image at once', async () => {
  await gladys.fake.deviceCreated(device);

  assert.deepEqual(statesOf('floodlight'), [1]);
  assert.deepEqual(statesOf('ir-lights'), [1]);
  // The first round initialises the sensors to "quiet".
  assert.deepEqual(statesOf('motion'), [0]);
  assert.deepEqual(
    gladys.fake.cameraImages.map((entry) => entry.device_external_id),
    [device.external_id],
  );
});

test('a poll publishes the actuators only when they change', async () => {
  await gladys.fake.poll(device);
  assert.deepEqual(statesOf('floodlight'), [1]);
});

test('a camera created again is published again, unchanged values included', async () => {
  await gladys.fake.deviceDeleted(device);
  await gladys.fake.deviceCreated(device);
  assert.deepEqual(statesOf('floodlight'), [1, 1]);
  assert.deepEqual(statesOf('motion'), [0, 0]);
});

test('switching the spotlight reports its new state without waiting for a poll', async () => {
  const spotlight = device.features.find((feature) => feature.external_id.endsWith(':floodlight'));
  const ack = await gladys.fake.setValue(device, spotlight, 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(gladys.fake.lastState(featureId('floodlight')), 0);
});

test('switching the infrared LEDs reports their new state too', async () => {
  const infrared = device.features.find((feature) => feature.external_id.endsWith(':ir-lights'));
  const ack = await gladys.fake.setValue(device, infrared, 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(gladys.fake.lastState(featureId('ir-lights')), 0);
});
