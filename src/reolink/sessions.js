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
    /** @type {Map<string, object>} One `{ api, camera }` per address. */
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

    let client = this.clients.get(ip);
    if (!client) {
      client = clientFromDevice(device, config);
      if (!client) {
        return null;
      }
      this.clients.set(ip, client);
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
    if (ip) {
      this.clients.delete(ip);
    }
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
    this.clients.forEach(({ api }) => {
      api.logout().catch((e) => logger.debug(`Logging out of ${api.ip} failed: ${e.message}`));
    });
    this.clients.clear();
  }
}
