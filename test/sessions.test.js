import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionPool } from '../src/reolink/sessions.js';
import { normalizeConfig } from '../src/config.js';
import { fakeDevice } from './helpers/fakeGladys.js';

test('the same camera is handed the same client', () => {
  // This is the whole point of the pool: a camera only accepts a handful of
  // sessions, and one poll round asks for a client three times.
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });
  const device = fakeDevice();

  const first = pool.for(device, config);
  const second = pool.for(device, config);
  assert.equal(first, second);
});

test('two cameras get their own client', () => {
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });

  const garden = pool.for(fakeDevice({ ip: '192.168.1.42' }), config);
  const gate = pool.for(fakeDevice({ ip: '192.168.1.43' }), config);
  assert.notEqual(garden, gate);
  assert.equal(garden.api.ip, '192.168.1.42');
  assert.equal(gate.api.ip, '192.168.1.43');
});

test('a config object rebuilt with the same credentials keeps the sessions', () => {
  // `normalizeConfig` returns a fresh object on every scan and every action, so
  // comparing references would throw the sessions away several times a minute —
  // exactly what the pool exists to avoid.
  const pool = new SessionPool();
  const device = fakeDevice();

  const first = pool.for(device, normalizeConfig({ password: 'secret' }));
  const second = pool.for(device, normalizeConfig({ password: 'secret' }));
  assert.equal(first, second);
});

test('a setting unrelated to the credentials keeps the sessions', () => {
  const pool = new SessionPool();
  const device = fakeDevice();

  const first = pool.for(device, normalizeConfig({ password: 'secret', event_poll_interval: 15 }));
  const second = pool.for(device, normalizeConfig({ password: 'secret', event_poll_interval: 60 }));
  assert.equal(first, second);
});

test('a changed per-camera account rebuilds the clients', () => {
  const pool = new SessionPool();
  const device = fakeDevice();

  const before = pool.for(device, normalizeConfig({ password: 'secret' }));
  const after = pool.for(
    device,
    normalizeConfig({ password: 'secret', camera_accounts: '192.168.1.42|gladys|other' }),
  );

  assert.notEqual(before, after);
  assert.equal(after.api.username, 'gladys');
});

test('a changed configuration rebuilds the clients', () => {
  // The new config may carry a new password; keeping the old client would fail
  // every request until a restart.
  const pool = new SessionPool();
  const device = fakeDevice();

  const before = pool.for(device, normalizeConfig({ password: 'old' }));
  const after = pool.for(device, normalizeConfig({ password: 'new' }));

  assert.notEqual(before, after);
  assert.equal(after.api.password, 'new');
});

test('dropping a client makes the next call open a fresh one', () => {
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });
  const device = fakeDevice();

  const first = pool.for(device, config);
  pool.drop(device);
  const second = pool.for(device, config);
  assert.notEqual(first, second);
});

test('reset logs out of every camera', () => {
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });
  const loggedOut = [];

  const device = fakeDevice();
  const client = pool.for(device, config);
  client.api.logout = async () => {
    loggedOut.push(client.api.ip);
  };

  pool.reset();
  assert.deepEqual(loggedOut, ['192.168.1.42']);
  assert.equal(pool.clients.size, 0);
});

test('a device with no address gets no client', () => {
  const pool = new SessionPool();
  const device = fakeDevice();
  device.params = device.params.filter((param) => param.name !== 'REOLINK_IP');
  assert.equal(pool.for(device, normalizeConfig({ password: 'x' })), null);
});

test('a renamed device updates the name its logs use', () => {
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });

  pool.for(fakeDevice({ name: 'Garden' }), config);
  const client = pool.for(fakeDevice({ name: 'Front garden' }), config);
  assert.equal(client.camera.name, 'Front garden');
});
