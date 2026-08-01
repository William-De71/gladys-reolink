// -----------------------------------------------------------------------------
// A stand-in for the SDK, so the modules that talk to Gladys can be tested
// without a running host.
//
// It records what was published rather than asserting on it: each test then
// checks the one thing it cares about, which keeps the helper free of
// test-specific knowledge.
// -----------------------------------------------------------------------------

/**
 * Build a fake SDK instance.
 * @param {object} [options] - What the fake should pretend.
 * @param {object[]} [options.devices] - The devices `getDevices` returns.
 * @param {object[]} [options.scanResults] - What `scanNetwork` returns.
 * @param {Error} [options.scanError] - Thrown by `scanNetwork` instead.
 * @returns {object} The fake, carrying the recorded calls.
 * @example
 * const gladys = fakeGladys({ devices: [device] });
 */
export function fakeGladys({ devices = [], scanResults = [], scanError = null } = {}) {
  const selector = 'ext-dev-reolink';
  return {
    selector,
    devices,
    /** Everything published, in order. */
    published: {
      states: [],
      images: [],
      discovered: [],
      connectionStatus: [],
    },

    externalIds(type, platformId) {
      const device = `ext:${selector}:${type}:${platformId}`;
      return { device, feature: (key) => `${device}:${key}` };
    },

    async getDevices() {
      return devices;
    },

    async publishState(featureExternalId, value) {
      this.published.states.push({ featureExternalId, value });
      return { success: true };
    },

    async publishCameraImage(deviceExternalId, image) {
      this.published.images.push({ deviceExternalId, image });
      return { success: true };
    },

    async publishDiscoveredDevices(list) {
      this.published.discovered.push(list);
      return { success: true, count: list.length };
    },

    async setConnectionStatus(connected, message) {
      this.published.connectionStatus.push({ connected, message });
      return { success: true };
    },

    async scanNetwork() {
      if (scanError) {
        throw scanError;
      }
      return scanResults;
    },
  };
}

/**
 * Build a Gladys device the way this integration publishes it.
 * @param {object} [overrides] - Params to change.
 * @returns {object} The device.
 * @example
 * const device = fakeDevice({ capabilities: 'battery' });
 */
export function fakeDevice({
  platformId = 'UID0000000000001',
  name = 'Garden',
  ip = '192.168.1.42',
  port = 80,
  https = false,
  capabilities = '',
  features = [],
} = {}) {
  return {
    name,
    external_id: `ext:ext-dev-reolink:camera:${platformId}`,
    features,
    params: [
      { name: 'REOLINK_IP', value: ip },
      { name: 'REOLINK_PORT', value: String(port) },
      { name: 'REOLINK_HTTPS', value: https ? '1' : '0' },
      { name: 'REOLINK_UID', value: platformId },
      { name: 'REOLINK_MODEL', value: 'RLC-810A' },
      { name: 'REOLINK_CAPABILITIES', value: capabilities },
    ],
  };
}

/**
 * Build a fake session pool handing out one scripted client.
 *
 * The real pool keys its clients by address; here a single client is enough, and
 * `swap` lets a test change what the camera answers between two rounds.
 * @param {object} client - The `{ api, camera }` to hand out.
 * @returns {object} The fake pool, recording the drops it received.
 * @example
 * const sessions = fakeSessions({ api, camera: { name: 'Garden', channel: 0 } });
 */
export function fakeSessions(client) {
  return {
    client,
    dropped: 0,
    for() {
      return this.client;
    },
    drop() {
      this.dropped += 1;
      this.client = null;
    },
    reset() {
      this.client = null;
    },
    /**
     * Replace the client, as if the camera now answered differently.
     * @param {object} next - The new client.
     */
    swap(next) {
      this.client = next;
    },
  };
}

/**
 * Build a fake API client, answering a scripted batch.
 * @param {object} answers - Answers keyed by command name.
 * @returns {object} The fake client, recording the batches it received.
 * @example
 * const api = fakeApi({ GetMdState: { state: 1 } });
 */
export function fakeApi(answers = {}) {
  return {
    /** Every batch received, in order. */
    batches: [],
    port: 80,
    https: false,

    async sendBatch(commands) {
      this.batches.push(commands);
      return commands.map((command) => {
        const value = answers[command.cmd];
        if (value === undefined) {
          return { cmd: command.cmd, code: 1, error: { rspCode: -9 } };
        }
        return { cmd: command.cmd, code: 0, value };
      });
    },

    async send(cmd, param) {
      const [result] = await this.sendBatch([{ cmd, action: 0, param }]);
      return Number(result.code) === 0 ? result.value : null;
    },

    async logout() {},
  };
}
