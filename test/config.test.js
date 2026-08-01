import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeConfig,
  isConfigured,
  parseCameraAddresses,
  parseCameraAccounts,
  resolveAccount,
  DEFAULT_CONFIG,
} from '../src/config.js';

test('normalizeConfig falls back to the defaults on an empty config', () => {
  const config = normalizeConfig();
  assert.equal(config.username, DEFAULT_CONFIG.username);
  assert.equal(config.password, '');
  assert.equal(config.stream_quality, 'HD');
  assert.equal(config.event_poll_interval, DEFAULT_CONFIG.event_poll_interval);
  assert.deepEqual(config.camera_addresses, []);
});

test('normalizeConfig forces the numeric types the form sends as strings', () => {
  // The Gladys configuration form posts every value as a string, so a number
  // field arrives as '30' and would break every arithmetic comparison.
  const config = normalizeConfig({ event_poll_interval: '30', battery_stop_all: '25' });
  assert.equal(config.event_poll_interval, 30);
  assert.equal(config.battery_stop_all, 25);
});

test('normalizeConfig maps the quality to the matching RTSP stream', () => {
  assert.equal(normalizeConfig({ stream_quality: 'SD' }).rtsp_stream, 'sub');
  assert.equal(normalizeConfig({ stream_quality: 'HD' }).rtsp_stream, 'main');
  // An unknown value must not silently produce an undefined stream path.
  assert.equal(normalizeConfig({ stream_quality: 'ULTRA' }).rtsp_stream, 'main');
});

test('normalizeConfig never trims the password', () => {
  // A password may legitimately start or end with a space, and trimming it would
  // make the login fail with no way for the user to see why.
  assert.equal(normalizeConfig({ password: ' secret ' }).password, ' secret ');
});

test('normalizeConfig keeps the default username when the field is blank', () => {
  assert.equal(normalizeConfig({ username: '   ' }).username, 'admin');
  assert.equal(normalizeConfig({ username: ' gladys ' }).username, 'gladys');
});

test('isConfigured requires both a username and a password', () => {
  assert.equal(isConfigured(normalizeConfig({ password: 'x' })), true);
  assert.equal(isConfigured(normalizeConfig({ password: '' })), false);
  assert.equal(isConfigured(normalizeConfig({ username: '', password: 'x' })), true);
});

test('parseCameraAddresses reads a comma-separated list', () => {
  assert.deepEqual(parseCameraAddresses('192.168.1.42, 192.168.1.43'), [
    { ip: '192.168.1.42', port: null },
    { ip: '192.168.1.43', port: null },
  ]);
});

test('parseCameraAddresses reads an explicit port', () => {
  assert.deepEqual(parseCameraAddresses('192.168.1.42:8000'), [{ ip: '192.168.1.42', port: 8000 }]);
});

test('parseCameraAddresses keeps a malformed port as part of the address', () => {
  // Splitting on a non-numeric suffix would silently truncate the address and
  // Gladys would query the wrong host.
  assert.deepEqual(parseCameraAddresses('camera.local:abc'), [
    { ip: 'camera.local:abc', port: null },
  ]);
  assert.deepEqual(parseCameraAddresses('192.168.1.42:99999'), [
    { ip: '192.168.1.42:99999', port: null },
  ]);
});

test('parseCameraAddresses accepts newlines and ignores blanks', () => {
  assert.deepEqual(parseCameraAddresses('192.168.1.42\n\n , 192.168.1.43 '), [
    { ip: '192.168.1.42', port: null },
    { ip: '192.168.1.43', port: null },
  ]);
  assert.deepEqual(parseCameraAddresses(undefined), []);
});

test('parseCameraAccounts reads the address|user|password triples', () => {
  assert.deepEqual(parseCameraAccounts('192.168.1.42|gladys|p@ss'), {
    '192.168.1.42': { username: 'gladys', password: 'p@ss' },
  });
});

test('parseCameraAccounts lets a password contain a pipe', () => {
  // Only the first two separators split, so a password is taken as the rest of
  // the entry — splitting on all of them would silently truncate it.
  assert.deepEqual(parseCameraAccounts('192.168.1.42|gladys|pa|ss'), {
    '192.168.1.42': { username: 'gladys', password: 'pa|ss' },
  });
});

test('parseCameraAccounts ignores incomplete entries', () => {
  assert.deepEqual(parseCameraAccounts('192.168.1.42|gladys'), {});
  assert.deepEqual(parseCameraAccounts('|gladys|pass'), {});
  assert.deepEqual(parseCameraAccounts('192.168.1.42||pass'), {});
});

test('resolveAccount prefers the per-camera entry over the global one', () => {
  const config = normalizeConfig({
    username: 'admin',
    password: 'global',
    camera_accounts: '192.168.1.42|gladys|specific',
  });
  assert.deepEqual(resolveAccount(config, '192.168.1.42'), {
    username: 'gladys',
    password: 'specific',
  });
  assert.deepEqual(resolveAccount(config, '192.168.1.99'), {
    username: 'admin',
    password: 'global',
  });
});
