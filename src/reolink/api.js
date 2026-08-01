// -----------------------------------------------------------------------------
// Client of the local HTTP API of ONE Reolink camera.
//
// The protocol, in short:
//   POST /cgi-bin/api.cgi?cmd=<name>&token=<token>
//   body:     [{ "cmd": "<name>", "action": 0, "param": { ... } }]
//   answer:   [{ "cmd": "<name>", "code": 0, "value": { ... } }]
//
// Both the body and the answer are ARRAYS — the API is batch-oriented, and a
// single command is just a batch of one. `sendBatch` uses that to read the
// motion state, the AI state and the battery level in ONE round trip, which
// matters on battery models: every request wakes the radio.
//
// Authentication is a token obtained from `Login`, valid for `leaseTime`
// seconds. It is renewed before it expires and re-obtained transparently when
// the camera drops it, so callers never deal with sessions.
//
// The camera serves a self-signed certificate on HTTPS, so TLS verification is
// disabled: identity is proven by the password, not by the certificate chain.
// -----------------------------------------------------------------------------

import http from 'node:http';
import https from 'node:https';
import { logger } from '@gladysassistant/integration-sdk';
import {
  API_PATH,
  API_PORTS,
  API_TIMEOUT_MS,
  TOKEN_RENEW_MARGIN_SECONDS,
  RETRYABLE_ERROR_CODES,
  API_ERROR_CODES,
  DEFAULT_CHANNEL,
} from './constants.js';

/**
 * Agents shared across cameras.
 *
 * `rejectUnauthorized: false` is required: every Reolink camera serves a
 * self-signed certificate, and identity is proven here by the password, not by
 * a certificate chain. Keeping the agents alive also pools the connections, so
 * a poll round reuses the TLS handshake instead of paying for a new one.
 */
const AGENTS = {
  https: new https.Agent({ rejectUnauthorized: false, keepAlive: true }),
  http: new http.Agent({ keepAlive: true }),
};

/**
 * Perform one HTTP(S) request and return the raw body.
 *
 * `node:http` rather than `fetch`: the global fetch of Node cannot be told to
 * accept a self-signed certificate (its `dispatcher` option needs undici, which
 * is not exposed as a module), and every Reolink camera serves exactly that on
 * HTTPS.
 * @param {URL} url - The full URL.
 * @param {object} options - The request options.
 * @param {string} [options.method] - The HTTP method.
 * @param {string} [options.body] - The request body.
 * @param {Record<string, string>} [options.headers] - Extra headers.
 * @param {number} options.timeoutMs - Abort after this delay.
 * @returns {Promise<{ status: number, contentType: string, body: Buffer }>} The response.
 * @example
 * await httpRequest(new URL('http://192.168.1.20/cgi-bin/api.cgi'), { timeoutMs: 10000 });
 */
export function httpRequest(url, { method = 'GET', body, headers = {}, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const transport = secure ? https : http;

    const request = transport.request(
      url,
      {
        method,
        agent: secure ? AGENTS.https : AGENTS.http,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (response) => {
        /** @type {Buffer[]} */
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode || 0,
            contentType: response.headers['content-type'] || '',
            body: Buffer.concat(chunks),
          }),
        );
      },
    );

    // `setTimeout` only covers inactivity, so the destroy is what actually
    // bounds a camera that accepts the connection and then goes quiet.
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('REOLINK_TIMEOUT'));
    });
    request.on('error', reject);

    if (body) {
      request.write(body);
    }
    request.end();
  });
}

/** Raised when the camera rejects the credentials, so the caller can say so. */
export class ReolinkAuthError extends Error {
  /**
   * @param {string} message - What went wrong.
   */
  constructor(message) {
    super(message);
    this.name = 'ReolinkAuthError';
  }
}

/**
 * Read the error code out of one command result.
 *
 * The firmware reports failures two ways depending on the command and the
 * version: a non-zero `code` at the top level, and/or a nested
 * `error.rspCode`. The nested one is the precise one when both are present.
 * @param {object} result - One entry of the answer array.
 * @returns {number} The error code, 0 when the command succeeded.
 * @example
 * errorCodeOf({ code: 1, error: { rspCode: -6 } }); // -6
 */
export function errorCodeOf(result) {
  if (!result || typeof result !== 'object') {
    return 0;
  }
  const nested = result.error && Number(result.error.rspCode);
  if (Number.isFinite(nested) && nested !== 0) {
    return nested;
  }
  return Number(result.code) || 0;
}

/**
 * Client of one camera. It owns the session and re-authenticates on its own.
 * @example
 * const api = new ReolinkApi({ ip: '192.168.1.20', username: 'admin', password: 'secret' });
 * const [state] = await api.sendBatch([{ cmd: 'GetMdState', action: 0, param: { channel: 0 } }]);
 */
export class ReolinkApi {
  /**
   * @param {object} options - The connection settings.
   * @param {string} options.ip - The camera address.
   * @param {string} options.username - The camera user, usually `admin`.
   * @param {string} options.password - That user's password.
   * @param {number} [options.port] - Pinned HTTP port; probed when omitted.
   * @param {boolean} [options.https] - Whether that port speaks HTTPS.
   * @param {number} [options.timeoutMs] - Per-request timeout.
   */
  constructor({ ip, username, password, port, https, timeoutMs = API_TIMEOUT_MS }) {
    this.ip = ip;
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs;

    /** The endpoint in use, discovered by probing when not pinned. */
    this.port = port || null;
    this.https = https === undefined ? null : Boolean(https);

    /** @type {string|null} */
    this.token = null;
    /** Epoch milliseconds at which the token stops being accepted. */
    this.tokenExpiresAt = 0;
    /** In-flight login, so concurrent callers share one session. */
    this.loginPromise = null;
  }

  /**
   * The base URL of the API, once the endpoint is known.
   * @returns {string} The origin, e.g. `https://192.168.1.20:443`.
   * @example
   * api.baseUrl();
   */
  baseUrl() {
    return `${this.https ? 'https' : 'http'}://${this.ip}:${this.port}`;
  }

  /**
   * POST a command batch to one endpoint and return the parsed answer.
   *
   * Kept separate from `sendBatch` so the port probe can try an endpoint without
   * committing the client to it.
   * @param {object} endpoint - `{ port, https }`.
   * @param {object[]} body - The command array.
   * @param {Record<string, string>} query - The query string parameters.
   * @returns {Promise<object[]>} The answer array.
   * @example
   * await api.post({ port: 80, https: false }, [{ cmd: 'Login', ... }], { cmd: 'Login' });
   */
  async post(endpoint, body, query) {
    const origin = `${endpoint.https ? 'https' : 'http'}://${this.ip}:${endpoint.port}`;
    const url = new URL(API_PATH, origin);
    Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

    const response = await httpRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: this.timeoutMs,
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`REOLINK_HTTP_${response.status}`);
    }

    let answer;
    try {
      answer = JSON.parse(response.body.toString('utf-8'));
    } catch {
      throw new Error('REOLINK_UNEXPECTED_ANSWER');
    }
    if (!Array.isArray(answer)) {
      // Every documented answer is an array. Anything else means we are not
      // talking to a Reolink API — a captive portal or another device entirely.
      throw new Error('REOLINK_UNEXPECTED_ANSWER');
    }
    return answer;
  }

  /**
   * Find which port/scheme the camera answers on, and remember it.
   *
   * A `Login` is used as the probe rather than a harmless read: it is the one
   * command that works before authentication, and a successful probe therefore
   * doubles as the login itself.
   * @returns {Promise<object>} The working endpoint.
   * @example
   * await api.resolveEndpoint();
   */
  async resolveEndpoint() {
    // A known endpoint still goes through `loginOn`: this method both FINDS the
    // endpoint and obtains the token, so returning early here would leave the
    // client without one and every later request unauthenticated.
    const candidates =
      this.port !== null ? [{ port: this.port, https: Boolean(this.https) }] : API_PORTS;

    let lastError = null;
    for (const endpoint of candidates) {
      try {
        await this.loginOn(endpoint);
        this.port = endpoint.port;
        this.https = endpoint.https;
        logger.debug(`Reolink ${this.ip}: API reached on ${this.baseUrl()}`);
        return endpoint;
      } catch (e) {
        // A refused password is conclusive: the endpoint is right and trying the
        // other one would only produce a second, more confusing failure.
        if (e instanceof ReolinkAuthError) {
          throw e;
        }
        lastError = e;
      }
    }
    throw new Error(
      `REOLINK_UNREACHABLE:${lastError ? lastError.message : 'no endpoint answered'}`,
    );
  }

  /**
   * Log in on one endpoint and store the token it hands out.
   * @param {object} endpoint - `{ port, https }`.
   * @returns {Promise<void>} Resolves once the token is usable.
   * @example
   * await api.loginOn({ port: 443, https: true });
   */
  async loginOn(endpoint) {
    const answer = await this.post(
      endpoint,
      [
        {
          cmd: 'Login',
          action: 0,
          param: { User: { userName: this.username, password: this.password } },
        },
      ],
      { cmd: 'Login' },
    );

    const result = answer[0] || {};
    const code = errorCodeOf(result);
    if (code !== 0) {
      // The firmware answers the same way for a wrong password and for a user
      // that does not exist, so the message covers both.
      throw new ReolinkAuthError(`REOLINK_LOGIN_REFUSED:${code}`);
    }

    const token = result?.value?.Token?.name;
    const leaseTime = Number(result?.value?.Token?.leaseTime);
    if (!token) {
      throw new Error('REOLINK_NO_TOKEN');
    }

    this.token = token;
    // A firmware that omits `leaseTime` gets the documented default of one hour;
    // the renew margin below keeps that guess safe.
    const lease = Number.isFinite(leaseTime) && leaseTime > 0 ? leaseTime : 3600;
    this.tokenExpiresAt = Date.now() + (lease - TOKEN_RENEW_MARGIN_SECONDS) * 1000;
  }

  /**
   * Make sure a usable token is held, logging in when needed.
   * @returns {Promise<void>} Resolves once authenticated.
   * @example
   * await api.ensureLogin();
   */
  async ensureLogin() {
    if (this.token && Date.now() < this.tokenExpiresAt) {
      return;
    }
    // Serialised on purpose: the firmware only accepts a handful of sessions,
    // and a poll round firing several commands at once would open one each.
    if (!this.loginPromise) {
      this.loginPromise = (async () => {
        this.token = null;
        await this.resolveEndpoint();
      })().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  /**
   * Send a batch of commands, authenticating and retrying once when the camera
   * drops the session.
   *
   * Batching is what keeps a poll cheap: motion, AI and battery come back in one
   * request rather than three, which on a battery camera is three radio wakeups
   * saved per round.
   * @param {object[]} commands - The command array.
   * @returns {Promise<object[]>} The answer array, one entry per command.
   * @example
   * await api.sendBatch([{ cmd: 'GetMdState', action: 0, param: { channel: 0 } }]);
   */
  async sendBatch(commands) {
    await this.ensureLogin();

    const query = { cmd: commands.length === 1 ? commands[0].cmd : 'Batch', token: this.token };

    let answer;
    try {
      answer = await this.post({ port: this.port, https: this.https }, commands, query);
    } catch {
      // A transport failure may be a session the camera closed under us; one
      // clean retry costs little and covers the common case.
      this.token = null;
      await this.ensureLogin();
      answer = await this.post({ port: this.port, https: this.https }, commands, {
        ...query,
        token: this.token,
      });
    }

    // A token refused mid-flight surfaces as an error code, not an HTTP status.
    const rejected = answer.some((result) => RETRYABLE_ERROR_CODES.includes(errorCodeOf(result)));
    if (rejected) {
      logger.debug(`Reolink ${this.ip}: token refused, logging in again`);
      this.token = null;
      await this.ensureLogin();
      answer = await this.post({ port: this.port, https: this.https }, commands, {
        ...query,
        token: this.token,
      });
    }

    return answer;
  }

  /**
   * Send one command and return its `value`, or null when it failed.
   *
   * Failures are values here rather than exceptions: capabilities differ across
   * models, and "this camera has no battery" is an ordinary answer to
   * `GetBatteryInfo`, not an error worth propagating.
   * @param {string} cmd - The command name.
   * @param {object} [param] - Its parameters.
   * @returns {Promise<object|null>} The `value`, or null.
   * @example
   * await api.send('GetDevInfo');
   */
  async send(cmd, param = {}) {
    const [result] = await this.sendBatch([{ cmd, action: 0, param }]);
    const code = errorCodeOf(result);
    if (code !== 0) {
      if (code === API_ERROR_CODES.ABILITY_ERROR) {
        logger.debug(`Reolink ${this.ip}: ${cmd} is not supported by this camera`);
      } else {
        logger.debug(`Reolink ${this.ip}: ${cmd} failed with code ${code}`);
      }
      return null;
    }
    return result?.value ?? null;
  }

  /**
   * Read the device identity: model, name, serial and firmware.
   * @returns {Promise<object|null>} The `DevInfo` block, or null.
   * @example
   * const info = await api.getDevInfo();
   */
  async getDevInfo() {
    const value = await this.send('GetDevInfo');
    return value?.DevInfo ?? null;
  }

  /**
   * Read what the camera can do, for the logged-in user.
   *
   * `GetAbility` is the only honest source: two cameras of the same range differ
   * (a spotlight here, none there), and the answer is also user-scoped — a
   * restricted account sees fewer abilities than an admin.
   * @returns {Promise<object|null>} The `Ability` block, or null.
   * @example
   * const ability = await api.getAbility();
   */
  async getAbility() {
    const value = await this.send('GetAbility', { User: { userName: this.username } });
    return value?.Ability ?? null;
  }

  /**
   * Capture a still image, straight from the camera.
   *
   * `Snap` answers with the JPEG bytes rather than JSON, so it bypasses
   * `sendBatch` entirely — and it is why this integration needs no ffmpeg for
   * the dashboard image.
   * @param {object} [options] - The capture options.
   * @param {number} [options.channel] - The video channel.
   * @param {'main'|'sub'} [options.stream] - Which stream to grab from.
   * @returns {Promise<Buffer>} The JPEG bytes.
   * @example
   * const jpeg = await api.snapshot({ stream: 'main' });
   */
  async snapshot({ channel = DEFAULT_CHANNEL, stream = 'main' } = {}) {
    await this.ensureLogin();

    const url = new URL(API_PATH, this.baseUrl());
    url.searchParams.set('cmd', 'Snap');
    url.searchParams.set('channel', String(channel));
    url.searchParams.set('snapType', stream);
    // The firmware caches aggressively: without a changing parameter the same
    // frame comes back for minutes, and the dashboard image would look frozen.
    url.searchParams.set('rs', Date.now().toString(36));
    url.searchParams.set('token', this.token);

    const response = await httpRequest(url, { timeoutMs: this.timeoutMs });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`REOLINK_SNAP_HTTP_${response.status}`);
    }

    // A refused token comes back as a JSON error with a 200 status, so the
    // content type is what tells success from failure here.
    if (!response.contentType.includes('image')) {
      throw new Error(`REOLINK_SNAP_NO_IMAGE:${response.body.toString('utf-8').slice(0, 120)}`);
    }

    return response.body;
  }

  /**
   * Close the session so the camera frees it.
   *
   * Dropping the token locally is not enough: the firmware keeps the session on
   * its side and only accepts a handful at a time.
   * @returns {Promise<void>} Resolves once logged out.
   * @example
   * await api.logout();
   */
  async logout() {
    if (this.token) {
      await this.sendBatch([{ cmd: 'Logout', action: 0, param: {} }]).catch(() => {});
    }
    this.token = null;
    this.tokenExpiresAt = 0;
  }
}
