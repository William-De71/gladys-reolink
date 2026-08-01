// -----------------------------------------------------------------------------
// The RTSP URL that feeds the live view.
//
// The dashboard camera widget plays live video through the Gladys `rtsp-camera`
// service, which streams ANY device carrying a `CAMERA_URL` param — whatever
// service owns it. Publishing that URL is therefore what unlocks the live video
// for an external integration; the still image published alongside is a separate
// path (see snapshot.js).
//
// Reolink exposes its streams under a fixed scheme:
//   rtsp://<user>:<password>@<ip>:554/<codec>Preview_<NN>_<main|sub>
//
// Two details make this less mechanical than it looks:
//   - the channel is 1-BASED and zero-padded here (`01`), while every JSON
//     command numbers the same channel from 0. Getting this wrong yields a URL
//     the camera answers with "404 stream not found";
//   - the CODEC is part of the path. A recent camera serves h265 on its main
//     stream and h264 on its sub stream, and a URL naming the wrong one simply
//     does not resolve. `GetEnc` reports what each stream actually uses, so it
//     is asked rather than assumed.
// -----------------------------------------------------------------------------

import { RTSP_PORT, RTSP_STREAMS, DEFAULT_CHANNEL } from './constants.js';

/** What the camera serves when `GetEnc` could not be read. */
const DEFAULT_CODEC = 'h264';

/**
 * Read the codec of one stream out of a `GetEnc` answer.
 * @param {object|null} enc - The `Enc` block of `GetEnc`.
 * @param {'main'|'sub'} stream - Which stream to look at.
 * @returns {string} The codec, e.g. `h264` or `h265`.
 * @example
 * codecOf({ mainStream: { vType: 'h265' } }, 'main'); // 'h265'
 */
export function codecOf(enc, stream) {
  const vType = enc?.[`${stream}Stream`]?.vType;
  // `vType` comes back as 'h264' / 'h265'; anything else is a firmware we do
  // not know, and h264 is the safe guess every model still answers.
  return typeof vType === 'string' && /^h26[45]$/i.test(vType)
    ? vType.toLowerCase()
    : DEFAULT_CODEC;
}

/**
 * Build the RTSP URL of one camera.
 *
 * The credentials are percent-encoded: a Reolink password commonly contains
 * `@`, `#` or `/`, each of which would otherwise break the URL apart — and the
 * live view would fail with an authentication error that says nothing about the
 * real cause.
 * @param {object} camera - The resolved camera (ip, channel, codecs).
 * @param {object} account - The account, as `{ username, password }`.
 * @param {string} [quality] - 'HD' or 'SD'.
 * @returns {string} The RTSP URL.
 * @example
 * buildRtspUrl({ ip: '192.168.1.42' }, { username: 'admin', password: 'p@ss' });
 */
export function buildRtspUrl(camera, account, quality = 'HD') {
  const user = encodeURIComponent(account.username || '');
  const password = encodeURIComponent(account.password || '');
  const stream = RTSP_STREAMS[quality] || RTSP_STREAMS.HD;
  const channel = camera.channel ?? DEFAULT_CHANNEL;
  // 1-based and zero-padded, unlike every other channel number in this API.
  const channelPath = String(channel + 1).padStart(2, '0');
  const codec = camera.codecs?.[stream] || DEFAULT_CODEC;
  return `rtsp://${user}:${password}@${camera.ip}:${RTSP_PORT}/${codec}Preview_${channelPath}_${stream}`;
}

/**
 * Read the codecs of both streams, so the live URL names the right one.
 * @param {object} api - The camera API client.
 * @param {number} [channel] - The video channel.
 * @returns {Promise<{ main: string, sub: string }>} The codecs.
 * @example
 * const codecs = await readCodecs(api);
 */
export async function readCodecs(api, channel = DEFAULT_CHANNEL) {
  const value = await api.send('GetEnc', { channel });
  const enc = value?.Enc ?? null;
  return { main: codecOf(enc, 'main'), sub: codecOf(enc, 'sub') };
}
