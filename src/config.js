// -----------------------------------------------------------------------------
// Integration configuration.
//
// The user-facing values come from the `config_schema` of the manifest; the SDK
// fetches them (`gladys.getConfig()`) and notifies changes through
// `gladys.onConfigUpdated()`.
//
// This module provides the defaults, normalizes the received object (a numeric
// field arrives as a string from the form), and parses the two free-text fields
// the manifest cannot express structurally: the manual camera addresses and the
// per-camera accounts.
// -----------------------------------------------------------------------------

import { RTSP_STREAMS, BATTERY_THRESHOLDS } from './reolink/constants.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  username: 'admin',
  stream_quality: 'HD',
  event_poll_interval: 15, // seconds, between two event checks
  capture_timeout: 12, // seconds, before giving up on a capture
  image_refresh_interval: 60, // seconds, between two automatic captures (wired)
  // Battery cameras get their OWN interval: the wired one exists to keep a
  // dashboard image fresh, which is cheap on mains and expensive on a cell. Tying
  // them together meant sparing a battery camera also degraded every wired one.
  // 15 min is roughly what a solar panel refills between two captures.
  battery_image_refresh_interval: 900,
  battery_pause_refresh: BATTERY_THRESHOLDS.PAUSE_REFRESH, // percent, below which the auto refresh stops
  battery_stop_all: BATTERY_THRESHOLDS.STOP_ALL, // percent, below which nothing is captured
  battery_resume: BATTERY_THRESHOLDS.RESUME, // percent, at which capturing resumes
};

/**
 * Split a multi-entry field into its trimmed, non-empty entries.
 *
 * Entries are separated by a COMMA, because the Gladys configuration form renders
 * a `string`/`secret` field as a single-line input: a newline simply cannot be
 * typed there. Newlines are accepted all the same, so a value pasted from a note
 * — or entered in a future multi-line field — still parses.
 * @param {unknown} raw - The raw field value.
 * @returns {string[]} The meaningful entries.
 * @example
 * splitEntries('192.168.1.42, 192.168.1.43');
 */
function splitEntries(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  return raw
    .split(/[,\r\n]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse the "camera addresses" field: a plain list of addresses, optionally
 * carrying a port as `192.168.1.42:8000`.
 *
 * Unlike a cloud-backed integration, there is no camera list to match a name
 * against: an address IS the identity here until the camera has been asked who
 * it is. So the field is a list, not a `name|ip` mapping.
 * @param {unknown} raw - The raw field value.
 * @returns {Array<{ ip: string, port: number|null }>} The addresses.
 * @example
 * parseCameraAddresses('192.168.1.42, 192.168.1.43:8000');
 */
export function parseCameraAddresses(raw) {
  return splitEntries(raw)
    .map((entry) => {
      // Only the LAST colon splits, so an IPv6 literal keeps its colons and only
      // a trailing `:port` is taken as a port.
      const separator = entry.lastIndexOf(':');
      if (separator <= 0) {
        return { ip: entry, port: null };
      }
      const port = Number(entry.slice(separator + 1));
      if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        // Not a port after all (an IPv6 address, a typo): keep the whole entry.
        return { ip: entry, port: null };
      }
      return { ip: entry.slice(0, separator).trim(), port };
    })
    .filter((entry) => entry.ip.length > 0);
}

/**
 * Parse the "accounts per camera" field: one `address|username|password` triple
 * per entry.
 *
 * The global account below covers the common case — one admin password reused on
 * every camera, which is what the Reolink app encourages. This field carries the
 * exceptions: a camera with its own password, or one where Gladys should use a
 * restricted user rather than the admin.
 *
 * The password is taken as the rest of the entry, so it may legitimately contain
 * a `|`; only the first two separators split. It cannot, however, contain a
 * comma, which separates the entries — the documentation says so, and the global
 * account fields remain available for such a password.
 * @param {unknown} raw - The raw field value.
 * @returns {Record<string, { username: string, password: string }>} Accounts
 * indexed by lower-cased address.
 * @example
 * parseCameraAccounts('192.168.1.42|gladys|p@ss');
 */
export function parseCameraAccounts(raw) {
  /** @type {Record<string, { username: string, password: string }>} */
  const accounts = {};
  splitEntries(raw).forEach((line) => {
    const first = line.indexOf('|');
    if (first <= 0) {
      return;
    }
    const second = line.indexOf('|', first + 1);
    if (second === -1) {
      return;
    }
    const address = line.slice(0, first).trim().toLowerCase();
    const username = line.slice(first + 1, second).trim();
    // Never trimmed: a password may legitimately start or end with a space.
    const password = line.slice(second + 1);
    if (address && username && password) {
      accounts[address] = { username, password };
    }
  });
  return accounts;
}

/**
 * Read a numeric field, falling back to the default when it is unusable.
 *
 * `Number()` alone was not enough: a field the user cleared arrives as `''`,
 * which `Number` turns into 0 — a 0-second refresh interval, or a battery
 * threshold of 0 that disarms the protection entirely. Anything that is not a
 * finite number now falls back to the documented default instead.
 * @param {unknown} value - The raw field value.
 * @param {string} key - The key in `DEFAULT_CONFIG`, used as the fallback.
 * @returns {number} The usable number.
 * @example
 * numberOrDefault('', 'image_refresh_interval'); // 60
 */
function numberOrDefault(value, key) {
  if (value === undefined || value === null || value === '') {
    return DEFAULT_CONFIG[key];
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIG[key];
}

/**
 * Merge the user config with the defaults, force the numeric types and parse
 * the free-text fields.
 * @param {Record<string, unknown>} [raw] - Config returned by the SDK.
 * @returns {object} The normalized configuration.
 * @example
 * const config = normalizeConfig(await gladys.getConfig());
 */
export function normalizeConfig(raw = {}) {
  const quality = raw.stream_quality === 'SD' ? 'SD' : DEFAULT_CONFIG.stream_quality;
  return {
    ...DEFAULT_CONFIG,
    username:
      typeof raw.username === 'string' && raw.username.trim()
        ? raw.username.trim()
        : DEFAULT_CONFIG.username,
    // Never trimmed: a password may legitimately start or end with a space.
    password: typeof raw.password === 'string' ? raw.password : '',
    stream_quality: quality,
    rtsp_stream: RTSP_STREAMS[quality],
    event_poll_interval: numberOrDefault(raw.event_poll_interval, 'event_poll_interval'),
    capture_timeout: numberOrDefault(raw.capture_timeout, 'capture_timeout'),
    image_refresh_interval: numberOrDefault(raw.image_refresh_interval, 'image_refresh_interval'),
    battery_image_refresh_interval: numberOrDefault(
      raw.battery_image_refresh_interval,
      'battery_image_refresh_interval',
    ),
    battery_pause_refresh: numberOrDefault(raw.battery_pause_refresh, 'battery_pause_refresh'),
    battery_stop_all: numberOrDefault(raw.battery_stop_all, 'battery_stop_all'),
    battery_resume: numberOrDefault(raw.battery_resume, 'battery_resume'),
    camera_addresses: parseCameraAddresses(raw.camera_addresses),
    camera_accounts: parseCameraAccounts(raw.camera_accounts),
  };
}

/**
 * Tell whether the camera account is filled in. Everything else (discovery,
 * image capture, commands) depends on it, so it is worth checking before any
 * call.
 * @param {object} config - The normalized configuration.
 * @returns {boolean} True when the integration can talk to a camera.
 * @example
 * isConfigured(config);
 */
export function isConfigured(config) {
  return Boolean(config.username && config.password);
}

/**
 * Resolve the account to use for one camera.
 *
 * The per-camera entry wins; the global fields act as the default, which is what
 * most installations use — the Reolink app pushes the same admin password to
 * every camera.
 * @param {object} config - The normalized configuration.
 * @param {string} address - The camera address.
 * @returns {{ username: string, password: string }} The account.
 * @example
 * resolveAccount(config, '192.168.1.42');
 */
export function resolveAccount(config, address) {
  const specific = config.camera_accounts[String(address || '').toLowerCase()];
  if (specific) {
    return specific;
  }
  return { username: config.username, password: config.password };
}
