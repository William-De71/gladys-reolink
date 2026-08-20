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

test('two cameras behind one hub share the session but not the camera', () => {
  // Sharing the SESSION is the point: a hub tolerates a handful, and one per
  // camera behind it would exhaust them. Sharing the CAMERA would be a bug —
  // every command would target whichever channel was resolved last.
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });

  const garden = pool.for(
    fakeDevice({ platformId: 'UID1', ip: '192.168.1.50', channel: 0 }),
    config,
  );
  const gate = pool.for(fakeDevice({ platformId: 'UID2', ip: '192.168.1.50', channel: 2 }), config);

  assert.equal(garden.api, gate.api);
  assert.notEqual(garden.camera, gate.camera);
  assert.equal(garden.camera.channel, 0);
  assert.equal(gate.camera.channel, 2);
});

test('a camera behind a hub keeps its own client across calls', () => {
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });
  const device = fakeDevice({ platformId: 'UID2', ip: '192.168.1.50', channel: 2 });

  assert.equal(pool.for(device, config), pool.for(device, config));
});

test('dropping one camera of a hub drops the whole shared session', () => {
  // The session is what went bad, and it belongs to the ADDRESS. Keeping the
  // other cameras on a token the hub already forgot only wastes the next round.
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });

  const gardenDevice = fakeDevice({ platformId: 'UID1', ip: '192.168.1.50', channel: 0 });
  const gateDevice = fakeDevice({ platformId: 'UID2', ip: '192.168.1.50', channel: 2 });
  const garden = pool.for(gardenDevice, config);
  pool.for(gateDevice, config);

  pool.drop(gateDevice);

  assert.notEqual(pool.for(gardenDevice, config), garden);
});

test('a hub is logged out once, not once per camera behind it', () => {
  // The extra logouts would be refused anyway: the first one already
  // invalidated the token they all share.
  const pool = new SessionPool();
  const config = normalizeConfig({ password: 'secret' });

  pool.for(fakeDevice({ platformId: 'UID1', ip: '192.168.1.50', channel: 0 }), config);
  pool.for(fakeDevice({ platformId: 'UID2', ip: '192.168.1.50', channel: 1 }), config);
  pool.for(fakeDevice({ platformId: 'UID3', ip: '192.168.1.50', channel: 2 }), config);

  let logouts = 0;
  pool.apis.forEach((api) => {
    api.logout = async () => {
      logouts += 1;
    };
  });
  pool.reset();

  assert.equal(logouts, 1);
});
