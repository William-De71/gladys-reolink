// -----------------------------------------------------------------------------
// One session per camera, shared by everything that talks to it.
//
// Why this exists: a Reolink camera only accepts a handful of concurrent
// sessions, and it does NOT free them when the client walks away — they expire
// on their own, minutes later. Meanwhile, a single poll round touches the same
// camera three times: it captures an image, re-reads the actuators, then checks
// the detections. Opening (and closing) a session for each would mean three
// logins per camera per minute, plus one more whenever the user flips a switch.
//
// That is enough to exhaust the pool on a busy install, and the symptom is
// miserable to diagnose: every command starts failing with a "login refused"
// that has nothing to do with the password.
//
// So the client is owned HERE, keyed by address, and handed out to whoever needs
// it. The token inside it renews itself (see api.js), so a long-lived client
// costs nothing to keep — and one session per camera is exactly what the
// firmware is comfortable with.
//
// A Home Hub makes that sharing MORE valuable, not less: its five cameras all
// answer through one address, so they get one session between them rather than
// five. But they must not share the CAMERA description that travels with it —
// each one has its own channel, name and capabilities, and handing the same
// object to all five would point every command at whichever camera was resolved
// last. So the API client is keyed by address, and the camera by address AND
// channel.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { clientFromDevice, getParam } from '../devices.js';
import { DEVICE_PARAMS } from './constants.js';

/**
 * A fingerprint of everything a held session depends on.
 *
 * Object identity is NOT usable here: `normalizeConfig` builds a fresh object on
 * every scan and every action, so comparing references would throw the sessions
 * away several times a minute for nothing. Only the credentials matter — a
 * changed poll interval has no bearing on a session already opened.
 * @param {object} config - The normalized configuration.
 * @returns {string} The fingerprint.
 * @example
 * credentialsOf(config);
 */
export function credentialsOf(config) {
  return JSON.stringify([config?.username, config?.password, config?.camera_accounts]);
}

/**
 * Holds one API client per camera address.
 * @example
 * const sessions = new SessionPool();
 * const client = sessions.for(device, config);
 */
export class SessionPool {
  constructor() {
    /** @type {Map<string, object>} One API client per address — one session. */
    this.apis = new Map();
    /** @type {Map<string, object>} One `{ api, camera }` per address+channel. */
    this.clients = new Map();
    /** Fingerprint of the credentials the held clients were built with. */
    this.credentials = null;
  }

  /**
   * The client of one device, built once and reused.
   * @param {object} device - The Gladys device.
   * @param {object} config - The normalized configuration.
   * @returns {object|null} `{ api, camera }`, or null when the device has no address.
   * @example
   * const client = sessions.for(device, config);
   */
  for(device, config) {
    // New credentials mean every held client would authenticate with the old
    // password and fail every request until a restart, so they are dropped.
    const credentials = credentialsOf(config);
    if (credentials !== this.credentials) {
      if (this.credentials !== null) {
        logger.debug('The camera credentials changed: reopening every session');
      }
      this.reset();
      this.credentials = credentials;
    }

    const ip = getParam(device, DEVICE_PARAMS.IP);
    if (!ip) {
      return null;
    }

    // Address AND channel: behind a hub, five devices share this address and
    // each needs its own camera description.
    const key = `${ip}:${getParam(device, DEVICE_PARAMS.CHANNEL) || '0'}`;

    let client = this.clients.get(key);
    if (!client) {
      client = clientFromDevice(device, config);
      if (!client) {
        return null;
      }
      // The session belongs to the ADDRESS: a hub only tolerates a handful, and
      // one per camera behind it would exhaust them. So the first camera to be
      // built opens it and the others reuse it.
      const held = this.apis.get(ip);
      if (held) {
        client.api = held;
      } else {
        this.apis.set(ip, client.api);
      }
      this.clients.set(key, client);
    }
    // The device may have been renamed in Gladys since the client was built, and
    // the name is what every log line about this camera uses.
    client.camera.name = device.name || client.camera.name;
    return client;
  }

  /**
   * Drop the client of one camera, so the next caller opens a fresh session.
   *
   * Used when a request fails in a way that suggests the camera forgot us: the
   * held token is then worthless and reusing it only wastes the next round.
   * @param {object} device - The Gladys device.
   * @example
   * sessions.drop(device);
   */
  drop(device) {
    const ip = getParam(device, DEVICE_PARAMS.IP);
    if (!ip) {
      return;
    }
    // The SESSION is what went bad, and it is shared by every camera on this
    // address — so all of them are dropped, not just the one that noticed.
    this.apis.delete(ip);
    [...this.clients.keys()]
      .filter((key) => key.startsWith(`${ip}:`))
      .forEach((key) => this.clients.delete(key));
  }

  /**
   * Log out of every camera and forget the clients.
   *
   * Called on shutdown and whenever the configuration changes: a session left
   * open counts against the handful the firmware allows, and the next start
   * would eventually be refused.
   * @example
   * sessions.reset();
   */
  reset() {
    // Iterating the APIs rather than the clients logs out ONCE per address, not
    // once per camera behind it — the extra logouts would be refused anyway,
    // since the first one already invalidated the shared token.
    this.apis.forEach((api) => {
      api.logout().catch((e) => logger.debug(`Logging out of ${api.ip} failed: ${e.message}`));
    });
    this.apis.clear();
    this.clients.clear();
  }
}
