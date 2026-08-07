// -----------------------------------------------------------------------------
// Local network discovery of the cameras.
//
// Reolink devices listen for a UDP broadcast on port 2000 and answer, to the
// sender, with a payload carrying their UID, MAC, name and IP — the same
// exchange the Reolink desktop client uses to populate its device list.
//
// The core performs the broadcast itself (a bridge container never receives LAN
// broadcast) and relays the raw replies, which is what the manifest declares
// under `network_discovery`.
//
// The reply is not JSON on every firmware: some answer with a binary header
// followed by an XML-ish body, others with plain JSON. Rather than parsing a
// shape that varies, the fields are pulled out of the decoded text — a UID and
// a MAC are distinctive enough that a false positive is implausible.
// -----------------------------------------------------------------------------

import { logger } from '@gladysassistant/integration-sdk';
import { DISCOVERY_PORT, DISCOVERY_MAGIC, DISCOVERY_TIMEOUT_SECONDS } from './constants.js';

/**
 * Build the discovery request the Reolink client broadcasts.
 *
 * The payload is the ASCII magic `aaaa0000`: devices answer any datagram
 * starting with it, no handshake or encryption involved at this stage.
 * @returns {Buffer} The request bytes.
 * @example
 * buildDiscoveryRequest();
 */
export function buildDiscoveryRequest() {
  return Buffer.from(DISCOVERY_MAGIC, 'ascii');
}

/**
 * Extract what identifies a camera from a discovery reply.
 *
 * A Reolink UID is 16 uppercase alphanumeric characters; the MAC is the
 * fallback identity for firmwares that do not announce a UID at all.
 * @param {Buffer} payload - The raw reply.
 * @returns {{ uid: string|null, mac: string|null, name: string|null, ip: string|null }} What could be read.
 * @example
 * parseDiscoveryReply(buffer);
 */
export function parseDiscoveryReply(payload) {
  const text = payload.toString('utf-8');

  // Both spellings appear, quoted in JSON or bare in the XML-ish body.
  //
  // The key is ANCHORED on its left: an unanchored `uid` also matches the tail of
  // a longer key (`deviceuid`, `puid`), and such a field is not the camera UID —
  // it may hold the same value on every camera of a model, which collapses two
  // cameras onto one external id and makes the second one silently overwrite the
  // first in Gladys.
  const uidMatch = /(?:^|[{,\s"<[])"?(?:uid|UID)"?\s*[:=>]\s*"?([0-9A-Za-z]{16})"?/.exec(text);
  const macMatch = /([0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5})/.exec(text);
  const nameMatch = /"?(?:name|devName)"?\s*[:=>]\s*"([^"<]{1,64})"/.exec(text);
  const ipMatch = /"?(?:ip|IP)"?\s*[:=>]\s*"?((?:\d{1,3}\.){3}\d{1,3})"?/.exec(text);

  return {
    uid: uidMatch ? uidMatch[1].toUpperCase() : null,
    mac: macMatch ? macMatch[1].toUpperCase() : null,
    name: nameMatch ? nameMatch[1] : null,
    ip: ipMatch ? ipMatch[1] : null,
  };
}

/**
 * Discover the Reolink devices present on the network.
 *
 * Failures are swallowed on purpose: discovery is a convenience over the manual
 * address list, so a filtered broadcast or a rate-limited scan must degrade to
 * "nothing found", never break the whole publish.
 * @param {object} gladys - The SDK instance.
 * @returns {Promise<object[]>} One entry per device: `{ ip, uid, mac, name }`.
 * @example
 * const found = await discoverCameras(gladys);
 */
export async function discoverCameras(gladys) {
  let replies;
  try {
    replies = await gladys.scanNetwork('udp-active-broadcast', {
      port: DISCOVERY_PORT,
      payload: buildDiscoveryRequest(),
      timeoutSeconds: DISCOVERY_TIMEOUT_SECONDS,
    });
  } catch (e) {
    // A 403 means the running Gladys still holds a manifest without
    // `network_discovery` — the integration was installed before the field was
    // declared. Reinstalling it is the fix, and staying silent here would hide
    // the reason why no camera is ever found.
    if (e.status === 403) {
      logger.warn(
        'Gladys refused the network scan: the installed integration predates its "network_discovery" declaration. Reinstall the integration to pick up the new manifest.',
      );
    } else {
      logger.warn(`The network scan failed: ${e.message}`);
    }
    return [];
  }

  /** @type {Map<string, object>} */
  const cameras = new Map();

  (replies || []).forEach((reply) => {
    try {
      const parsed = parseDiscoveryReply(Buffer.from(reply.payload_base64, 'base64'));
      // The source address always beats the one announced in the payload: a
      // camera behind a NAT or with a stale configuration reports an address
      // Gladys cannot reach, while the datagram demonstrably came from this one.
      const ip = reply.source_ip || parsed.ip;
      if (!ip) {
        return;
      }
      // A device answering several times (two interfaces, retries) must yield
      // one camera, so the address is the key.
      cameras.set(ip, { ...parsed, ip });
    } catch (e) {
      logger.debug(`Unreadable discovery reply from ${reply.source_ip}: ${e.message}`);
    }
  });

  const found = [...cameras.values()];
  if (found.length > 0) {
    logger.info(`${found.length} Reolink device(s) located on the local network`);
  } else {
    logger.debug('The network scan located no Reolink device');
  }
  return found;
}
