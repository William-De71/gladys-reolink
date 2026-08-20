import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMultiChannelHost,
  isHomeHub,
  parseChannelEntry,
  parseChannelStatus,
  listChannels,
  readSleepStates,
} from '../src/reolink/channels.js';
import { fakeApi } from './helpers/fakeGladys.js';

test('a Home Hub and an NVR are recognised as hosting several cameras', () => {
  // The firmware announces its nature in `exactType`, older ones in `type`.
  // A hub that only fills the legacy field would otherwise be taken for a plain
  // camera and publish channel 0 alone — four cameras silently lost.
  assert.equal(isMultiChannelHost({ exactType: 'HOMEHUB' }), true);
  assert.equal(isMultiChannelHost({ type: 'HOMEHUB' }), true);
  assert.equal(isMultiChannelHost({ exactType: 'NVR' }), true);
  assert.equal(isMultiChannelHost({ exactType: 'WIFI_NVR' }), true);
  assert.equal(isMultiChannelHost({ exactType: 'IPC' }), false);
  assert.equal(isMultiChannelHost({}), false);
  assert.equal(isMultiChannelHost(null), false);
});

test('a Home Hub is told from an NVR, so log lines name what the user owns', () => {
  assert.equal(isHomeHub({ exactType: 'HOMEHUB' }), true);
  assert.equal(isHomeHub({ exactType: 'NVR' }), false);
});

test('a channel entry keeps only what identifies one camera', () => {
  const entry = parseChannelEntry({
    channel: 2,
    online: 1,
    name: 'Gate',
    typeInfo: 'Reolink Video Doorbell WiFi',
    uid: '95270005ZBCDEFGH',
    sleep: 0,
  });

  assert.equal(entry.channel, 2);
  assert.equal(entry.online, true);
  assert.equal(entry.name, 'Gate');
  assert.equal(entry.uid, '95270005ZBCDEFGH');
  assert.equal(entry.sleeping, false);
  // Behind a hub, `GetAbility` is answered by the HUB, which has no doorbell
  // button to declare — the model string is the only marker left.
  assert.equal(entry.isDoorbell, true);
});

test('the optional fields are genuinely optional', () => {
  // `name`, `typeInfo` and `uid` are each missing on some firmwares, and a hub
  // that omits all three must still yield a usable channel.
  const entry = parseChannelEntry({ channel: 1, online: 1 });
  assert.equal(entry.channel, 1);
  assert.equal(entry.name, null);
  assert.equal(entry.model, null);
  assert.equal(entry.uid, null);
  assert.equal(entry.isDoorbell, false);
  // Unknown is NOT the same as awake: the guard treats the two differently.
  assert.equal(entry.sleeping, null);
});

test('a channel number used as a name is refused', () => {
  // Some firmwares put the channel number in `name` when the camera was never
  // renamed. "0" as a camera name in Gladys is worse than no name at all.
  assert.equal(parseChannelEntry({ channel: 0, name: '0' }).name, null);
  assert.equal(parseChannelEntry({ channel: 1, name: '1' }).name, null);
  assert.equal(parseChannelEntry({ channel: 1, name: '  ' }).name, null);
  assert.equal(parseChannelEntry({ channel: 1, name: 'Garden' }).name, 'Garden');
});

test('an entry carrying no usable channel number is dropped', () => {
  assert.equal(parseChannelEntry({ online: 1 }), null);
  assert.equal(parseChannelEntry({ channel: -1 }), null);
  assert.equal(parseChannelEntry({ channel: 'two' }), null);
  // Well past Reolink's largest NVR: a nonsense count must not have the
  // integration probe hundreds of channels on every scan.
  assert.equal(parseChannelEntry({ channel: 9999 }), null);
  assert.equal(parseChannelEntry(null), null);
});

test('a missing `online` reads as online', () => {
  // A firmware that omits the field is announcing a channel it considers
  // usable; treating that as offline would publish nothing at all.
  assert.equal(parseChannelEntry({ channel: 0 }).online, true);
  assert.equal(parseChannelEntry({ channel: 0, online: 0 }).online, false);
});

test('a hub announcing a channel twice yields one camera', () => {
  // Two devices fighting over one external id is a silent loss: Gladys upserts,
  // so the second would overwrite the first.
  const channels = parseChannelStatus({
    count: 2,
    status: [
      { channel: 0, online: 1, name: 'Garden' },
      { channel: 0, online: 1, name: 'Garden' },
    ],
  });
  assert.equal(channels.length, 1);
});

test('an answer that is not a channel list yields nothing', () => {
  assert.deepEqual(parseChannelStatus(null), []);
  assert.deepEqual(parseChannelStatus({}), []);
  assert.deepEqual(parseChannelStatus({ status: 'nope' }), []);
});

test('a plain camera is not asked to enumerate its channels', async () => {
  // It has no `GetChannelstatus` to answer, and asking would add a failed
  // command to every scan.
  const api = fakeApi({});
  const channels = await listChannels(api, { exactType: 'IPC', name: 'Garden' });

  assert.equal(channels.length, 1);
  assert.equal(channels[0].channel, 0);
  assert.equal(api.batches.length, 0);
});

test('a hub lists its cameras and skips the ones it cannot reach', async () => {
  // A hub remembers a camera that is unpaired or out of range and keeps
  // announcing it offline. Publishing those creates Gladys devices that can
  // never answer.
  const api = fakeApi({
    GetChannelstatus: {
      count: 3,
      status: [
        {
          channel: 0,
          online: 1,
          name: 'Garden',
          typeInfo: 'Argus 3 Ultra',
          uid: 'UIDAAAAAAAAAAAA1',
        },
        { channel: 1, online: 0, name: 'Shed' },
        { channel: 2, online: 1, name: 'Gate', typeInfo: 'Reolink Video Doorbell WiFi' },
      ],
    },
  });

  const channels = await listChannels(api, { exactType: 'HOMEHUB', name: 'Hub' });

  assert.deepEqual(
    channels.map((entry) => entry.channel),
    [0, 2],
  );
  assert.equal(channels[1].isDoorbell, true);
});

test('a hub whose firmware lacks the command falls back to its channel count', async () => {
  // Without this, a hub with no enumerable channels publishes nothing — which
  // looks exactly like a broken integration to the user.
  const api = fakeApi({});
  const channels = await listChannels(api, { exactType: 'HOMEHUB', channelNum: 4 });

  assert.deepEqual(
    channels.map((entry) => entry.channel),
    [0, 1, 2, 3],
  );
});

test('a hub that announces neither channels nor a count publishes nothing', async () => {
  const api = fakeApi({});
  const channels = await listChannels(api, { exactType: 'HOMEHUB' });
  assert.deepEqual(channels, []);
});

test('the sleep states of a whole hub cost one command', async () => {
  // This is the point of reading them here: asking each battery camera whether
  // it is awake would WAKE it, which is what the answer exists to prevent.
  const api = fakeApi({
    GetChannelstatus: {
      count: 3,
      status: [
        { channel: 0, online: 1, sleep: 1 },
        { channel: 1, online: 1, sleep: 0 },
        { channel: 2, online: 1 },
      ],
    },
  });

  const states = await readSleepStates(api);

  assert.equal(api.batches.length, 1);
  assert.equal(states.get(0), true);
  assert.equal(states.get(1), false);
  // Unknown stays unknown rather than defaulting to awake, so a firmware that
  // never reports it does not have its cameras woken on a timer.
  assert.equal(states.has(2), false);
});

test('an unreadable hub reports no sleep state rather than failing the round', async () => {
  const api = {
    ip: '192.168.1.42',
    async send() {
      throw new Error('REOLINK_TIMEOUT');
    },
  };
  assert.equal((await readSleepStates(api)).size, 0);
});
