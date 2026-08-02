import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  platformIdOf,
  parsePlatformId,
  getParam,
  buildFeatures,
  buildDevice,
  deviceHasCapability,
  clientFromDevice,
} from '../src/devices.js';
import { normalizeConfig } from '../src/config.js';
import { CAPABILITIES, DEVICE_PARAMS, AI_FEATURES_ENABLED } from '../src/reolink/constants.js';
import { fakeGladys, fakeDevice } from './helpers/fakeGladys.js';

const gladys = fakeGladys();

/**
 * Build a resolved camera, as `resolveCamera` produces one.
 * @param {object} [overrides] - What to change.
 * @returns {object} The camera.
 */
function camera(overrides = {}) {
  return {
    name: 'Garden',
    model: 'RLC-810A',
    ip: '192.168.1.42',
    port: 80,
    https: false,
    channel: 0,
    uid: 'UID1234567890ABC',
    platformId: 'UID1234567890ABC',
    capabilities: [],
    codecs: { main: 'h264', sub: 'h264' },
    ...overrides,
  };
}

test('platformIdOf prefers the identity that survives a DHCP change', () => {
  assert.equal(platformIdOf({ uid: 'uid1234567890abc', ip: '192.168.1.42' }), 'UID1234567890ABC');
  // No UID: the MAC is just as stable, but its colons would split a Gladys
  // external id into the wrong number of parts.
  assert.equal(platformIdOf({ mac: 'ec:71:db:11:22:33' }), 'EC71DB112233');
  // Last resort only: an address changes whenever the lease does.
  assert.equal(platformIdOf({ ip: '192.168.1.42' }), '192-168-1-42');
});

test('parsePlatformId reads the id back from a device or feature id', () => {
  assert.equal(parsePlatformId('ext:ext-dev-reolink:camera:UID1'), 'UID1');
  assert.equal(parsePlatformId('ext:ext-dev-reolink:camera:UID1:image'), 'UID1');
  assert.equal(parsePlatformId('ext:other:light:UID1'), null);
  assert.equal(parsePlatformId('nonsense'), null);
});

test('every camera gets an image and a motion feature', () => {
  const features = buildFeatures(gladys, camera());
  assert.equal(features.length, 2);
  assert.equal(features[0].category, 'camera');
  assert.equal(features[1].category, 'motion-sensor');
});

test('a feature is only created for a capability the camera announced', () => {
  // A spotlight switch on a camera without one would silently do nothing, which
  // is worse than not offering it.
  const bare = buildFeatures(gladys, camera());
  assert.ok(!bare.some((feature) => feature.category === 'light'));
  assert.ok(!bare.some((feature) => feature.category === 'siren'));
  assert.ok(!bare.some((feature) => feature.category === 'battery'));

  const loaded = buildFeatures(
    gladys,
    camera({
      capabilities: [
        CAPABILITIES.BATTERY,
        CAPABILITIES.FLOODLIGHT,
        CAPABILITIES.SIREN,
        CAPABILITIES.IR_LIGHTS,
        CAPABILITIES.PTZ_PRESETS,
        CAPABILITIES.AI_PEOPLE,
      ],
    }),
  );
  assert.ok(loaded.some((feature) => feature.category === 'battery'));
  assert.ok(loaded.some((feature) => feature.category === 'light'));
  assert.ok(loaded.some((feature) => feature.category === 'siren'));
  assert.equal(
    loaded.some((feature) => feature.category === 'presence-sensor'),
    AI_FEATURES_ENABLED,
  );
});

test('a doorbell gets a push button, an ordinary camera does not', () => {
  const doorbell = buildFeatures(gladys, camera({ capabilities: [CAPABILITIES.DOORBELL] }));
  const button = doorbell.find((feature) => feature.category === 'button');
  assert.ok(button);
  assert.equal(button.type, 'push');

  assert.ok(!buildFeatures(gladys, camera()).some((feature) => feature.category === 'button'));
});

test('the AI detections are presence sensors, not a second motion sensor', () => {
  // Gladys already gets a motion feature from GetMdState; a second one saying
  // the same thing differently would be confusing in the scene editor.
  //
  // While AI_FEATURES_ENABLED is false the presence features are held back
  // (Gladys cannot display a presence-sensor/binary yet), so the expected count
  // follows the flag — the motion sensor is unaffected either way.
  const features = buildFeatures(
    gladys,
    camera({ capabilities: [CAPABILITIES.AI_PEOPLE, CAPABILITIES.AI_VEHICLE] }),
  );
  const presence = features.filter((feature) => feature.category === 'presence-sensor');
  assert.equal(presence.length, AI_FEATURES_ENABLED ? 2 : 0);
  assert.equal(features.filter((feature) => feature.category === 'motion-sensor').length, 1);
});

test('the actuators the camera changes on its own declare feedback', () => {
  // The spotlight follows the camera night schedule and the IR LEDs switch with
  // the light sensor, so Gladys must re-read them rather than trust what it sent.
  const features = buildFeatures(
    gladys,
    camera({ capabilities: [CAPABILITIES.FLOODLIGHT, CAPABILITIES.IR_LIGHTS, CAPABILITIES.SIREN] }),
  );
  assert.equal(features.find((feature) => feature.category === 'light').has_feedback, true);
  assert.equal(features.find((feature) => feature.category === 'switch').has_feedback, true);
  // The siren has no readable state: the firmware exposes no "is it sounding".
  assert.equal(features.find((feature) => feature.category === 'siren').has_feedback, false);
});

test('buildDevice carries everything a later capture needs', () => {
  const device = buildDevice(gladys, camera({ capabilities: [CAPABILITIES.BATTERY] }));
  assert.equal(device.external_id, 'ext:ext-dev-reolink:camera:UID1234567890ABC');
  assert.equal(device.model, 'RLC-810A');
  assert.equal(device.should_poll, true);
  assert.equal(getParam(device, DEVICE_PARAMS.IP), '192.168.1.42');
  assert.equal(getParam(device, DEVICE_PARAMS.PORT), '80');
  assert.equal(getParam(device, DEVICE_PARAMS.CAPABILITIES), 'battery');
});

test('buildDevice publishes the RTSP URL the live view reads', () => {
  // The rtsp-camera service streams any device carrying CAMERA_URL, whatever
  // service owns it: this param is what unlocks the live video.
  const device = buildDevice(gladys, camera({ streamUrl: 'rtsp://admin:x@192.168.1.42:554/a' }));
  assert.equal(getParam(device, DEVICE_PARAMS.CAMERA_URL), 'rtsp://admin:x@192.168.1.42:554/a');
});

test('deviceHasCapability reads what was stored at discovery time', () => {
  const device = fakeDevice({ capabilities: 'battery,floodlight' });
  assert.equal(deviceHasCapability(device, CAPABILITIES.BATTERY), true);
  assert.equal(deviceHasCapability(device, CAPABILITIES.FLOODLIGHT), true);
  assert.equal(deviceHasCapability(device, CAPABILITIES.SIREN), false);
  assert.equal(deviceHasCapability(fakeDevice(), CAPABILITIES.BATTERY), false);
});

test('clientFromDevice rebuilds a client without any discovery round', () => {
  const config = normalizeConfig({ password: 'secret' });
  const { api, camera: rebuilt } = clientFromDevice(fakeDevice({ port: 443, https: true }), config);
  assert.equal(api.ip, '192.168.1.42');
  assert.equal(api.port, 443);
  assert.equal(api.https, true);
  assert.equal(api.username, 'admin');
  assert.equal(rebuilt.name, 'Garden');
});

test('clientFromDevice re-probes the scheme when no port was stored', () => {
  // A camera switched to HTTPS since it was added would fail every request if
  // the stale scheme were trusted.
  const device = fakeDevice({ port: '', https: false });
  const { api } = clientFromDevice(device, normalizeConfig({ password: 'secret' }));
  assert.equal(api.port, null);
  assert.equal(api.https, null, 'an unknown port must leave the scheme to be probed');
});

test('clientFromDevice applies the per-camera account', () => {
  const config = normalizeConfig({
    password: 'global',
    camera_accounts: '192.168.1.42|gladys|specific',
  });
  const { api } = clientFromDevice(fakeDevice(), config);
  assert.equal(api.username, 'gladys');
  assert.equal(api.password, 'specific');
});

test('clientFromDevice refuses a device with no address', () => {
  const device = fakeDevice();
  device.params = device.params.filter((param) => param.name !== DEVICE_PARAMS.IP);
  assert.equal(clientFromDevice(device, normalizeConfig({ password: 'x' })), null);
});
