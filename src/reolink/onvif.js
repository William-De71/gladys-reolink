// -----------------------------------------------------------------------------
// ONVIF events: motion, AI detections and doorbell PUSHED by the camera.
//
// Why this exists alongside the HTTP API: `GetMdState` answers "is motion firing
// right now", so a detection is only noticed at the next poll — up to
// `event_poll_interval` seconds late — and one that starts and ends between two
// polls is never seen at all. ONVIF inverts it: the camera holds a
// `PullMessages` request open and answers the moment something happens, and it
// reports the END of the detection too.
//
// The protocol is plain SOAP over HTTP, written out by hand rather than pulling
// in a WSDL stack: the integration needs six calls (GetSystemDateAndTime,
// GetCapabilities, CreatePullPointSubscription, PullMessages, Renew,
// Unsubscribe) out of a standard covering hundreds.
//
// Authentication is WS-UsernameToken with a password digest, using the same
// camera account as the HTTP API. ONVIF has its own session model (none: every
// request carries its proof), so it does not take one of the few HTTP sessions
// the firmware allows.
//
// What is deliberately NOT done here:
//   - battery models: they have no ONVIF server, and a pull held open would
//     keep the radio awake anyway;
//   - cameras behind a Home Hub or an NVR: their events carry a video source
//     token whose mapping to a channel is firmware-specific. Those keep the
//     polled path, which names its channel explicitly.
// -----------------------------------------------------------------------------

import crypto from 'node:crypto';
import http from 'node:http';
import { logger } from '@gladysassistant/integration-sdk';
import {
  ONVIF_DEVICE_PATH,
  ONVIF_PULL_TIMEOUT_SECONDS,
  ONVIF_REQUEST_TIMEOUT_MS,
  ONVIF_DEADLINE_MARGIN_MS,
  ONVIF_MAX_RESPONSE_BYTES,
  ONVIF_QUIET_TIMEOUTS_BEFORE_FAILURE,
  ONVIF_FAILURES_BEFORE_FALLBACK,
  ONVIF_RENEW_AFTER_MS,
  ONVIF_FAST_PULL_MS,
  ONVIF_FAST_PULL_PAUSE_MS,
} from './constants.js';

/** XML namespaces of the services this module talks to. */
export const NS = {
  soap: 'http://www.w3.org/2003/05/soap-envelope',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
  device: 'http://www.onvif.org/ver10/device/wsdl',
  events: 'http://www.onvif.org/ver10/events/wsdl',
  notification: 'http://docs.oasis-open.org/wsn/b-2',
  addressing: 'http://www.w3.org/2005/08/addressing',
};

/**
 * Pause before reissuing a pull the camera ended by closing the connection.
 *
 * Small enough to stay invisible on a motion, large enough that a firmware
 * closing the connection immediately cannot turn the loop into a busy wait.
 */
const QUIET_PULL_PAUSE_MS = 250;

/** Encoding declared for the nonce: strict firmwares refuse a nonce without it. */
const NONCE_ENCODING_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/** Password type declared by the UsernameToken digest profile. */
const PASSWORD_DIGEST_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest';

/**
 * Escape the five characters XML cannot carry literally.
 * @param {string} value - The raw text.
 * @returns {string} The escaped text.
 * @example
 * escapeXml('a&b'); // 'a&amp;b'
 */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Build the WS-Security header proving the camera account.
 *
 * The digest is `base64(sha1(nonce + created + password))`. `created` is
 * stamped on the CAMERA's clock, not ours: the camera rejects a digest whose
 * timestamp is too far from its own time, and a camera that never synchronised
 * its clock would otherwise refuse every request with an "unauthorized" that
 * has nothing to do with the password.
 * @param {string} username - The camera account username.
 * @param {string} password - The camera account password.
 * @param {number} [clockOffsetMs] - Camera time minus local time.
 * @returns {string} The `<Security>` header.
 * @example
 * buildSecurityHeader('admin', 'secret');
 */
export function buildSecurityHeader(username, password, clockOffsetMs = 0) {
  const nonce = crypto.randomBytes(16);
  // Without milliseconds: some firmwares only parse `YYYY-MM-DDTHH:MM:SSZ`.
  const created = new Date(Date.now() + clockOffsetMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const digest = crypto
    .createHash('sha1')
    .update(Buffer.concat([nonce, Buffer.from(created, 'utf8'), Buffer.from(password, 'utf8')]))
    .digest('base64');

  return (
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST_TYPE}">${digest}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${NONCE_ENCODING_TYPE}">${nonce.toString('base64')}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

/**
 * Wrap a SOAP body in the envelope the camera expects.
 * @param {string} body - The body XML.
 * @param {string} [header] - The SOAP headers (security, addressing).
 * @returns {string} The complete envelope.
 * @example
 * buildEnvelope('<tds:GetSystemDateAndTime/>');
 */
export function buildEnvelope(body, header = '') {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="${NS.soap}" xmlns:tds="${NS.device}" ` +
    `xmlns:tev="${NS.events}" xmlns:wsa="${NS.addressing}" xmlns:wsnt="${NS.notification}">` +
    `<s:Header>${header}</s:Header>` +
    `<s:Body>${body}</s:Body></s:Envelope>`
  );
}

/**
 * Read the text of the first matching element, whatever namespace prefix the
 * camera chose.
 * @param {string} xml - The response body.
 * @param {string} localName - The tag name, without its prefix.
 * @returns {string|null} The text, or null when absent.
 * @example
 * readTag(xml, 'Address');
 */
export function readTag(xml, localName) {
  const pattern = new RegExp(
    `<(?:[\\w.-]+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${localName}>`,
    'i',
  );
  const match = pattern.exec(String(xml || ''));
  return match ? match[1].trim() : null;
}

/**
 * Summarize a SOAP fault into something a log line can carry: the subcodes
 * (`ter:NotAuthorized`, `ter:InvalidArgVal`…) name the failure, the text adds
 * to it when it says anything.
 * @param {string} xml - The response body.
 * @returns {string} The summary, empty when the body carries no fault.
 * @example
 * faultSummary(xml); // 'ter:NotAuthorized: Sender not Authorized'
 */
export function faultSummary(xml) {
  const body = String(xml || '');
  const codes = [];
  // Walked as a token stream: subcodes NEST, and it is the innermost one that
  // names the ONVIF error.
  const tokenPattern = /<(\/?)(?:[\w.-]+:)?(Subcode|Value)\b[^>]*>([\s\S]*?)(?=<)/gi;
  let depth = 0;
  let token = tokenPattern.exec(body);
  while (token !== null) {
    const [, closing, name, text] = token;
    if (name.toLowerCase() === 'subcode') {
      depth += closing ? -1 : 1;
    } else if (!closing && depth > 0 && text.trim()) {
      codes.push(text.trim());
    }
    token = tokenPattern.exec(body);
  }

  const text = readTag(body, 'Text') || readTag(body, 'faultstring') || '';
  const code = codes.join('/');
  if (code && text) {
    return `${code}: ${text}`;
  }
  return code || text;
}

/**
 * Tell whether a failed pull is the camera ending a quiet poll rather than a
 * real fault: a closed connection or a timeout means "nothing happened".
 *
 * Deliberately narrow: a refused connection or a SOAP fault is NOT benign, and
 * treating it as such would hide a camera rejecting the account behind an
 * endless quiet loop.
 * @param {Error} error - The error the pull rejected with.
 * @returns {boolean} True when the pull can simply be reissued.
 * @example
 * isBenignDisconnect(new Error('socket hang up')); // true
 */
export function isBenignDisconnect(error) {
  const message = String(error?.message || '');
  if (error?.code === 'ECONNRESET') {
    return true;
  }
  return (
    message.includes('socket hang up') ||
    message.includes('Data after `Connection: close`') ||
    message.includes('ONVIF_TIMEOUT')
  );
}

/**
 * POST a SOAP envelope and return the raw response body.
 *
 * A SOAP fault comes back with HTTP 400/500 and a body explaining why, so the
 * fault is kept in the error: an ONVIF rejection is almost always a wrong
 * account or a disabled user, and that reason has to survive to the logs.
 * @param {string} url - The service URL.
 * @param {string} envelope - The envelope to send.
 * @param {number} [timeoutMs] - How long to wait.
 * @returns {Promise<string>} The response body.
 * @example
 * await postSoap('http://192.168.1.20:8000/onvif/device_service', envelope);
 */
export function postSoap(url, envelope, timeoutMs = ONVIF_REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    let settled = false;

    /**
     * Settle once: every exit path goes through here, so the deadline is always
     * cleared and a late event never resolves the promise twice.
     * @param {Error|null} error - The failure, or null on success.
     * @param {string} [body] - The response body.
     */
    const settle = (error, body) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadline);
      if (error) {
        request.destroy();
        reject(error);
      } else {
        resolve(body);
      }
    };

    // An OVERALL deadline on top of the socket timeout, which only measures
    // inactivity: a camera dripping bytes, or cutting the connection mid-body,
    // would otherwise leave this promise pending and freeze the pull loop.
    const deadline = setTimeout(
      () => settle(new Error('ONVIF_TIMEOUT')),
      timeoutMs + ONVIF_DEADLINE_MARGIN_MS,
    );

    const request = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: target.pathname + target.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(envelope),
        },
        timeout: timeoutMs,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
          if (body.length > ONVIF_MAX_RESPONSE_BYTES) {
            settle(new Error('ONVIF_RESPONSE_TOO_LARGE'));
          }
        });
        response.on('error', (e) => settle(e));
        response.on('aborted', () =>
          settle(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })),
        );
        response.on('end', () => {
          if (response.statusCode >= 400) {
            const reason =
              faultSummary(body) ||
              body.replace(/\s+/g, ' ').trim().slice(0, 200) ||
              '(empty body)';
            settle(new Error(`ONVIF_HTTP_${response.statusCode}:${reason.slice(0, 200)}`));
            return;
          }
          settle(null, body);
        });
      },
    );

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('ONVIF_TIMEOUT'));
    });
    request.on('error', (e) => settle(e));
    request.end(envelope);
  });
}

/**
 * Turn an ONVIF topic into the kind of detection the integration publishes.
 *
 * Reolink hangs its events under these topics:
 *   - `tns1:RuleEngine/CellMotionDetector/Motion` (and `VideoSource/MotionAlarm`
 *     on some firmwares) — the plain motion;
 *   - `tns1:RuleEngine/MyRuleDetector/PeopleDetect`, `VehicleDetect`,
 *     `DogCatDetect` — the AI detections;
 *   - `tns1:RuleEngine/MyRuleDetector/Visitor` — the doorbell button.
 *
 * Anything else (`FaceDetect`, `Package`, tampering…) yields null rather than a
 * guessed motion: a false motion firing a scene is worse than a missed one.
 * @param {string} topic - The `Topic` element content.
 * @returns {'motion'|'people'|'vehicle'|'animal'|'doorbell'|null} The kind.
 * @example
 * classifyTopic('tns1:RuleEngine/CellMotionDetector/Motion'); // 'motion'
 */
export function classifyTopic(topic) {
  const normalized = String(topic || '').toLowerCase();
  if (!normalized) {
    return null;
  }
  if (normalized.includes('visitor')) {
    return 'doorbell';
  }
  if (normalized.includes('peopledetect') || normalized.includes('persondetect')) {
    return 'people';
  }
  if (normalized.includes('vehicledetect')) {
    return 'vehicle';
  }
  if (normalized.includes('dogcatdetect') || normalized.includes('animaldetect')) {
    return 'animal';
  }
  if (normalized.includes('cellmotiondetector') || normalized.includes('motionalarm')) {
    return 'motion';
  }
  return null;
}

/**
 * Extract the detections from a `PullMessages` response.
 *
 * ONVIF reports both edges of a detection: a `SimpleItem` whose value is true
 * when it starts and false when it ends. The value is read from `<tt:Data>`
 * SPECIFICALLY: a notification also carries a `<tt:Source>` (the video source
 * token, `VideoSourceConfigurationToken="000"`) which is a SimpleItem too and
 * comes first — reading the first one would decode every event as false.
 *
 * `initial` marks the `PropertyOperation="Initialized"` messages a camera sends
 * right after a subscription: they describe the CURRENT state, not a change,
 * and must not fire a scene for a detection that started before anyone was
 * listening.
 * @param {string} xml - The response body.
 * @returns {Array<{ kind: string, active: boolean, initial: boolean }>} The events.
 * @example
 * parsePullMessages(xml);
 */
export function parsePullMessages(xml) {
  const events = [];
  const chunks = String(xml || '').split(/<(?:[\w.-]+:)?NotificationMessage\b/i);

  chunks.slice(1).forEach((chunk) => {
    const kind = classifyTopic(readTag(chunk, 'Topic'));
    if (!kind) {
      return;
    }

    const data = /<(?:[\w.-]+:)?Data\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Data>/i.exec(chunk);
    const scope = data ? data[1] : chunk;
    const valueMatch = /<(?:[\w.-]+:)?SimpleItem\b[^>]*\bValue="([^"]*)"/i.exec(scope);
    const raw = valueMatch ? valueMatch[1].toLowerCase() : null;
    // No value at all: a stateless event, always an activation.
    const active = raw === null ? true : raw === 'true' || raw === '1';
    const initial = /\bPropertyOperation="Initialized"/i.test(chunk);

    events.push({ kind, active, initial });
  });

  return events;
}

/**
 * Compute how far the camera clock is from ours, from a `GetSystemDateAndTime`
 * answer.
 * @param {string} xml - The response body.
 * @param {number} [now] - The local time the answer was received at.
 * @returns {number} Camera time minus local time, in ms; 0 when unreadable.
 * @example
 * clockOffsetFrom(xml);
 */
export function clockOffsetFrom(xml, now = Date.now()) {
  const utc = /<(?:[\w.-]+:)?UTCDateTime\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?UTCDateTime>/i.exec(
    String(xml || ''),
  );
  if (!utc) {
    return 0;
  }
  const field = (name) => Number(readTag(utc[1], name));
  const parts = ['Year', 'Month', 'Day', 'Hour', 'Minute', 'Second'].map(field);
  if (parts.some((value) => !Number.isFinite(value))) {
    return 0;
  }
  const [year, month, day, hour, minute, second] = parts;
  const cameraTime = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(cameraTime) ? cameraTime - now : 0;
}

/**
 * ONVIF event client for ONE camera: the pull point subscription and the
 * long-poll loop. Nothing is shared between cameras: a camera that stops
 * answering must not hold up the others.
 * @example
 * const client = new ReolinkOnvif({ ip: '192.168.1.20', port: 8000, username: 'admin', password: 'secret' });
 * client.start((event) => console.log(event.kind, event.active));
 */
export class ReolinkOnvif {
  /**
   * @param {object} options - The connection settings.
   * @param {string} options.ip - The camera address.
   * @param {number} options.port - The ONVIF port.
   * @param {string} options.username - The camera account username.
   * @param {string} options.password - The camera account password.
   * @param {string} [options.name] - The camera name, for the logs.
   */
  constructor({ ip, port, username, password, name }) {
    this.ip = ip;
    this.port = port;
    this.username = username;
    this.password = password;
    this.name = name || ip;

    this.deviceUrl = `http://${ip}:${port}${ONVIF_DEVICE_PATH}`;
    /** URL of the Events service, read from the capabilities. @type {string|null} */
    this.eventsUrl = null;
    /** URL of the pull point handed out at subscription. @type {string|null} */
    this.pullPointUrl = null;
    /** Camera clock minus ours, measured once per subscription. */
    this.clockOffsetMs = 0;
    /** @type {((event: object) => void)|null} */
    this.onEvent = null;
    this.running = false;
    /** Set for good by `stop()`, even before the loop has started. */
    this.stopped = false;
    /** Consecutive failures, used to back off and to report the fallback. */
    this.failures = 0;
    /** Consecutive quiet pulls that ended on a timeout. */
    this.quietTimeouts = 0;
    /** Whether at least one pull went through since the last failure run. */
    this.healthy = false;
    /** When the subscription was opened or last renewed. */
    this.subscribedAt = 0;
    /** Cuts the current wait short, so `stop()` is not held by it. */
    this.wake = null;
  }

  /**
   * Tell whether events are currently flowing from this camera, so the polled
   * path can stand down for it.
   * @returns {boolean} True while the pull loop is healthy.
   * @example
   * client.isLive();
   */
  isLive() {
    return this.running && this.healthy && this.failures < ONVIF_FAILURES_BEFORE_FALLBACK;
  }

  /**
   * Rewrite an address handed out by the camera onto the address and port we
   * reach it on. Firmwares commonly announce their own idea of their IP (or
   * the default port after it was changed): only the PATH they chose is kept.
   * @param {string} address - The address from the camera.
   * @returns {string} The reachable URL.
   * @example
   * client.reachable('http://10.0.0.5:8000/onvif/Subscription?Idx=0');
   */
  reachable(address) {
    const target = new URL(address);
    return `http://${this.ip}:${this.port}${target.pathname}${target.search}`;
  }

  /**
   * Send one call to a service, authenticated unless told otherwise.
   * @param {string} url - The service URL.
   * @param {string} body - The SOAP body.
   * @param {object} [options] - Call options.
   * @param {number} [options.timeoutMs] - How long to wait.
   * @param {string} [options.action] - The WS-Addressing action, when required.
   * @param {boolean} [options.anonymous] - Send without credentials.
   * @returns {Promise<string>} The response body.
   * @example
   * await client.call(url, '<tds:GetCapabilities/>');
   */
  call(url, body, { timeoutMs, action, anonymous = false } = {}) {
    // A fresh security header per call: the digest carries a timestamp the
    // camera checks, so a reused one is eventually rejected as a replay.
    const security = anonymous
      ? ''
      : buildSecurityHeader(this.username, this.password, this.clockOffsetMs);
    const addressing = action
      ? `<wsa:Action>${action}</wsa:Action><wsa:To>${escapeXml(url)}</wsa:To>`
      : '';
    return postSoap(url, buildEnvelope(body, security + addressing), timeoutMs);
  }

  /**
   * Measure the camera clock. Unauthenticated by design: it is what makes the
   * authenticated calls possible on a camera whose clock drifted.
   * @returns {Promise<void>} Resolves once measured (or given up on).
   * @example
   * await client.syncClock();
   */
  async syncClock() {
    try {
      const xml = await this.call(this.deviceUrl, '<tds:GetSystemDateAndTime/>', {
        anonymous: true,
      });
      this.clockOffsetMs = clockOffsetFrom(xml);
      if (Math.abs(this.clockOffsetMs) > 60 * 1000) {
        logger.debug(
          `The clock of "${this.name}" is ${Math.round(this.clockOffsetMs / 1000)}s off, compensating`,
        );
      }
    } catch (e) {
      logger.debug(`Reading the clock of "${this.name}" failed: ${e.message}`);
    }
  }

  /**
   * Read where the Events service lives and whether pull points are supported.
   * @returns {Promise<void>} Resolves once known.
   * @example
   * await client.readCapabilities();
   */
  async readCapabilities() {
    const xml = await this.call(
      this.deviceUrl,
      '<tds:GetCapabilities><tds:Category>Events</tds:Category></tds:GetCapabilities>',
    );
    const section = /<(?:[\w.-]+:)?Events\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?Events>/i.exec(xml);
    const scope = section ? section[1] : '';
    if ((readTag(scope, 'WSPullPointSupport') || '').toLowerCase() === 'false') {
      throw new Error('ONVIF_NO_PULLPOINT_SUPPORT');
    }
    const address = readTag(scope, 'XAddr');
    this.eventsUrl = address ? this.reachable(address) : this.deviceUrl;
  }

  /**
   * Open a pull point subscription and remember where to pull from.
   * @returns {Promise<void>} Resolves once the subscription is open.
   * @example
   * await client.subscribe();
   */
  async subscribe() {
    await this.syncClock();
    if (!this.eventsUrl) {
      await this.readCapabilities();
    }

    // The termination time is optional in the standard and some firmwares
    // refuse it: they are asked again without it and pick their own default.
    const subscribe = (body) => this.call(this.eventsUrl, body);
    const xml = await subscribe(
      '<tev:CreatePullPointSubscription>' +
        '<tev:InitialTerminationTime>PT10M</tev:InitialTerminationTime>' +
        '</tev:CreatePullPointSubscription>',
    ).catch((e) => {
      if (!String(e.message).includes('InvalidArgVal')) {
        throw e;
      }
      return subscribe('<tev:CreatePullPointSubscription/>');
    });

    const address = readTag(xml, 'Address');
    if (!address) {
      throw new Error('ONVIF_NO_PULLPOINT');
    }
    const pullPointUrl = this.reachable(address);

    // Stopped while the camera was answering: release the subscription at once,
    // or it holds one of the few slots the firmware has until it expires.
    if (this.stopped) {
      this.unsubscribe(pullPointUrl);
      throw new Error('ONVIF_STOPPED');
    }
    this.pullPointUrl = pullPointUrl;
    this.subscribedAt = Date.now();
    logger.debug(`ONVIF subscription open on "${this.name}"`);
  }

  /**
   * Renew the subscription a little before it lapses. A camera that refuses is
   * left alone unless it says the subscription is gone.
   * @returns {Promise<void>} Resolves once renewed, or when nothing was due.
   * @example
   * await client.renewIfDue();
   */
  async renewIfDue() {
    if (!this.pullPointUrl || Date.now() - this.subscribedAt < ONVIF_RENEW_AFTER_MS) {
      return;
    }
    try {
      await this.call(
        this.pullPointUrl,
        '<wsnt:Renew><wsnt:TerminationTime>PT10M</wsnt:TerminationTime></wsnt:Renew>',
        { action: `${NS.notification}/SubscriptionManager/RenewRequest` },
      );
    } catch (e) {
      if (/ResourceUnknown|UnknownSubscription/i.test(String(e.message))) {
        this.pullPointUrl = null;
      }
      logger.debug(`Renewing the ONVIF subscription of "${this.name}" failed: ${e.message}`);
    }
    this.subscribedAt = Date.now();
  }

  /**
   * Release a subscription on the camera, best effort: the camera keeps only a
   * few, and every one abandoned is a slot a later subscribe cannot get.
   * @param {string|null} url - The pull point address to release.
   * @example
   * client.unsubscribe(client.pullPointUrl);
   */
  unsubscribe(url) {
    if (!url) {
      return;
    }
    this.call(url, '<wsnt:Unsubscribe/>', {
      timeoutMs: 3000,
      action: `${NS.notification}/SubscriptionManager/UnsubscribeRequest`,
    }).catch(() => {});
  }

  /**
   * Pull the events the camera accumulated, waiting for one if there is none.
   * @returns {Promise<object[]>} The events, possibly empty.
   * @example
   * const events = await client.pull();
   */
  async pull() {
    await this.renewIfDue();
    if (!this.pullPointUrl) {
      try {
        await this.subscribe();
      } catch (e) {
        // Tagged so the loop never mistakes it for a quiet pull: a subscribe
        // that times out is a camera not answering.
        e.phase = 'subscribe';
        throw e;
      }
    }

    const xml = await this.call(
      this.pullPointUrl,
      '<tev:PullMessages>' +
        `<tev:Timeout>PT${ONVIF_PULL_TIMEOUT_SECONDS}S</tev:Timeout>` +
        '<tev:MessageLimit>32</tev:MessageLimit>' +
        '</tev:PullMessages>',
      {
        // The camera is EXPECTED to hold this open for the whole pull timeout,
        // so the socket must outlive it.
        timeoutMs: (ONVIF_PULL_TIMEOUT_SECONDS + 10) * 1000,
        action: `${NS.events}/PullPointSubscription/PullMessagesRequest`,
      },
    );

    const events = parsePullMessages(xml);
    if (events.length > 0) {
      logger.debug(
        `ONVIF events from "${this.name}": ${events.map((event) => `${event.kind}=${event.active}`).join(', ')}`,
      );
    }
    return events;
  }

  /**
   * Start the long-poll loop. Runs until `stop()`, re-subscribing whenever the
   * camera drops the subscription — on reboot, or after an idle period.
   * @param {(event: object) => void} onEvent - Called for each event.
   * @example
   * client.start((event) => { ... });
   */
  start(onEvent) {
    if (this.running || this.stopped) {
      return;
    }
    this.onEvent = onEvent;
    this.running = true;
    this.loop().catch((e) => logger.debug(`ONVIF loop of "${this.name}" ended: ${e.message}`));
  }

  /**
   * The loop itself: pull, dispatch, repeat.
   * @returns {Promise<void>} Resolves when the loop stops.
   * @example
   * await client.loop();
   */
  async loop() {
    while (this.running) {
      const startedAt = Date.now();
      try {
        const events = await this.pull();
        if (!this.running) {
          return;
        }
        if (this.failures >= ONVIF_FAILURES_BEFORE_FALLBACK) {
          logger.info(`ONVIF events are flowing again from "${this.name}"`);
        } else if (!this.healthy) {
          logger.info(`"${this.name}" now reports its detections instantly over ONVIF`);
        }
        this.failures = 0;
        this.quietTimeouts = 0;
        this.healthy = true;
        events.forEach((event) => this.onEvent?.(event));

        // A firmware that answers an empty pull at once instead of holding it:
        // the pulls are spaced rather than fired back to back.
        if (events.length === 0 && Date.now() - startedAt < ONVIF_FAST_PULL_MS) {
          await this.sleep(ONVIF_FAST_PULL_PAUSE_MS);
        }
      } catch (e) {
        if (!this.running) {
          return;
        }

        // A camera ending a quiet pull by closing the connection: nothing was
        // lost, the subscription is kept and the next pull goes straight out.
        // A run of timeouts, however, is a camera that went silent.
        const timedOut = String(e.message).includes('ONVIF_TIMEOUT');
        this.quietTimeouts = timedOut ? this.quietTimeouts + 1 : 0;
        const benign =
          e.phase !== 'subscribe' &&
          isBenignDisconnect(e) &&
          this.quietTimeouts < ONVIF_QUIET_TIMEOUTS_BEFORE_FAILURE;
        if (benign) {
          await this.sleep(QUIET_PULL_PAUSE_MS);
          continue;
        }

        this.failures += 1;
        this.quietTimeouts = 0;
        // The subscription is the first suspect: it expires, and a rebooted
        // camera forgets it. Released on the camera unless it says it no longer
        // knows it.
        const dropped = this.pullPointUrl;
        this.pullPointUrl = null;
        if (dropped && !/ResourceUnknown|UnknownSubscription/i.test(String(e.message))) {
          this.unsubscribe(dropped);
        }
        // An address reached through the wrong path is re-read next time.
        if (e.phase === 'subscribe') {
          this.eventsUrl = null;
        }

        const waitMs = Math.min(60_000, 2_000 * this.failures);
        logger.debug(
          `ONVIF pull on "${this.name}" failed (${this.failures}): ${e.message} — retrying in ${waitMs / 1000}s`,
        );
        // Said ONCE per outage: from here on the detections of this camera go
        // back to the polled path until ONVIF recovers.
        if (this.failures === ONVIF_FAILURES_BEFORE_FALLBACK) {
          logger.warn(
            `No ONVIF event could be read from "${this.name}" (${e.message}). Its detections are polled every few seconds instead until ONVIF answers again. Check that ONVIF is enabled on the camera (Reolink app → Settings → Network → Advanced → Server settings).`,
          );
        }
        await this.sleep(waitMs);
      }
    }
  }

  /**
   * Wait, unless `stop()` cuts it short.
   * @param {number} ms - How long to wait.
   * @returns {Promise<void>} Resolves after the delay, or at once on stop.
   * @example
   * await client.sleep(2000);
   */
  sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(timer);
        this.wake = null;
        resolve();
      };
    });
  }

  /**
   * Stop the loop and release the subscription. The in-flight pull is left to
   * finish on its own (it is bounded by its deadline); the loop checks
   * `running` before doing anything with what it returns.
   * @example
   * client.stop();
   */
  stop() {
    this.running = false;
    this.stopped = true;
    this.healthy = false;
    this.wake?.();
    const url = this.pullPointUrl;
    this.pullPointUrl = null;
    this.unsubscribe(url);
  }
}
