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

test('battery cameras have their own refresh interval', () => {
  // The two used to share one setting, so sparing a solar camera also let every
  // wired camera's image go stale. They are unrelated costs.
  const config = normalizeConfig({
    image_refresh_interval: '60',
    battery_image_refresh_interval: '1800',
  });
  assert.equal(config.image_refresh_interval, 60);
  assert.equal(config.battery_image_refresh_interval, 1800);
});

test('the battery refresh interval defaults well above the wired one', () => {
  const config = normalizeConfig();
  assert.ok(
    config.battery_image_refresh_interval > config.image_refresh_interval,
    'a battery camera must not be captured as often as a wired one',
  );
});

test('changing the wired interval leaves the battery one alone', () => {
  const config = normalizeConfig({ image_refresh_interval: '15' });
  assert.equal(
    config.battery_image_refresh_interval,
    DEFAULT_CONFIG.battery_image_refresh_interval,
  );
});

test('a cleared numeric field falls back to its default', () => {
  // `Number('')` is 0: a cleared refresh interval used to become a 0-second
  // loop, and a cleared battery threshold disarmed the protection entirely.
  const config = normalizeConfig({
    image_refresh_interval: '',
    battery_image_refresh_interval: '',
    battery_pause_refresh: '',
    battery_stop_all: '',
    capture_timeout: '',
  });
  assert.equal(config.image_refresh_interval, DEFAULT_CONFIG.image_refresh_interval);
  assert.equal(
    config.battery_image_refresh_interval,
    DEFAULT_CONFIG.battery_image_refresh_interval,
  );
  assert.equal(config.battery_pause_refresh, DEFAULT_CONFIG.battery_pause_refresh);
  assert.equal(config.battery_stop_all, DEFAULT_CONFIG.battery_stop_all);
  assert.equal(config.capture_timeout, DEFAULT_CONFIG.capture_timeout);
});

test('a non-numeric value falls back to its default', () => {
  assert.equal(
    normalizeConfig({ image_refresh_interval: 'soon' }).image_refresh_interval,
    DEFAULT_CONFIG.image_refresh_interval,
  );
});

test('the resume level is configurable', () => {
  assert.equal(normalizeConfig().battery_resume, DEFAULT_CONFIG.battery_resume);
  assert.equal(normalizeConfig({ battery_resume: '90' }).battery_resume, 90);
});
