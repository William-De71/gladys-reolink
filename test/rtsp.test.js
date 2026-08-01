import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRtspUrl, codecOf, readCodecs } from '../src/reolink/rtsp.js';
import { fakeApi } from './helpers/fakeGladys.js';

const account = { username: 'admin', password: 'secret' };

test('buildRtspUrl numbers the channel from 1 and pads it', () => {
  // Every JSON command numbers this channel 0, but the RTSP path wants `01`.
  // A URL built with the JSON numbering answers "404 stream not found".
  const url = buildRtspUrl({ ip: '192.168.1.42', channel: 0 }, account);
  assert.match(url, /\/h264Preview_01_main$/);
});

test('buildRtspUrl percent-encodes the credentials', () => {
  // A Reolink password commonly contains `@` or `/`, which would otherwise split
  // the URL apart and fail with an authentication error saying nothing useful.
  const url = buildRtspUrl({ ip: '192.168.1.42' }, { username: 'gla dys', password: 'p@ss/word' });
  assert.match(url, /rtsp:\/\/gla%20dys:p%40ss%2Fword@192\.168\.1\.42:554\//);
  assert.ok(!url.includes('p@ss'), 'the raw password must not appear in the URL');
});

test('buildRtspUrl follows the requested quality', () => {
  const camera = { ip: '192.168.1.42' };
  assert.match(buildRtspUrl(camera, account, 'SD'), /_01_sub$/);
  assert.match(buildRtspUrl(camera, account, 'HD'), /_01_main$/);
});

test('buildRtspUrl names the codec the camera actually serves', () => {
  // A recent camera serves h265 on its main stream; a URL naming h264 simply
  // does not resolve.
  const camera = { ip: '192.168.1.42', codecs: { main: 'h265', sub: 'h264' } };
  assert.match(buildRtspUrl(camera, account, 'HD'), /\/h265Preview_01_main$/);
  assert.match(buildRtspUrl(camera, account, 'SD'), /\/h264Preview_01_sub$/);
});

test('codecOf falls back to h264 on an unknown answer', () => {
  assert.equal(codecOf({ mainStream: { vType: 'h265' } }, 'main'), 'h265');
  assert.equal(codecOf({ mainStream: { vType: 'H264' } }, 'main'), 'h264');
  assert.equal(codecOf({ mainStream: { vType: 'mjpeg' } }, 'main'), 'h264');
  assert.equal(codecOf(null, 'main'), 'h264');
});

test('readCodecs reads both streams from GetEnc', async () => {
  const api = fakeApi({
    GetEnc: { Enc: { mainStream: { vType: 'h265' }, subStream: { vType: 'h264' } } },
  });
  assert.deepEqual(await readCodecs(api), { main: 'h265', sub: 'h264' });
});

test('readCodecs degrades to h264 when the camera refuses GetEnc', async () => {
  // An older firmware answers `-9` (ability error) here, and the live view must
  // still get a URL rather than none at all.
  const api = fakeApi({});
  assert.deepEqual(await readCodecs(api), { main: 'h264', sub: 'h264' });
});
