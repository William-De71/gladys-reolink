import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitsInLimit, toGladysImage, captureImage } from '../src/reolink/snapshot.js';
import { IMAGE_MAX_BYTES } from '../src/reolink/constants.js';

/**
 * Build a fake camera API answering a scripted snapshot per stream.
 * @param {object} images - The JPEG bytes, keyed by stream name.
 * @returns {object} The fake client, recording the streams it was asked for.
 */
function fakeSnapApi(images) {
  return {
    asked: [],
    async snapshot({ stream }) {
      this.asked.push(stream);
      const image = images[stream];
      if (!image) {
        throw new Error(`no image for ${stream}`);
      }
      return image;
    },
  };
}

const config = { capture_timeout: 10, stream_quality: 'HD' };
const camera = { name: 'Garden', channel: 0 };

test('fitsInLimit measures the ENCODED size, not the raw one', () => {
  // base64 inflates the payload by ~4/3 and Gladys checks the encoded size, so a
  // raw-byte comparison would let an oversized image through.
  const justUnder = Buffer.alloc(Math.floor((IMAGE_MAX_BYTES * 3) / 4) - 8);
  const justOver = Buffer.alloc(Math.ceil((IMAGE_MAX_BYTES * 3) / 4) + 8);
  assert.equal(fitsInLimit(justUnder), true);
  assert.equal(fitsInLimit(justOver), false);
  assert.equal(
    Buffer.byteLength(justUnder.toString('base64')) <= IMAGE_MAX_BYTES,
    true,
    'the estimate must agree with a real base64 encoding',
  );
});

test('toGladysImage produces the prefix Gladys expects', () => {
  assert.match(toGladysImage(Buffer.from([0xff, 0xd8])), /^image\/jpg;base64,/);
});

test('a small image is published untouched', async () => {
  const jpeg = Buffer.alloc(1024, 0x41);
  const api = fakeSnapApi({ main: jpeg });

  const image = await captureImage(api, camera, config);
  assert.equal(image, toGladysImage(jpeg));
  assert.deepEqual(api.asked, ['main'], 'no re-encoding, no fallback');
});

test('the SD setting asks the camera for its light stream directly', async () => {
  const api = fakeSnapApi({ sub: Buffer.alloc(512) });
  await captureImage(api, camera, { ...config, stream_quality: 'SD' });
  assert.deepEqual(api.asked, ['sub']);
});

test('an oversized frame falls back to the low-resolution stream', async () => {
  // ffmpeg may be unavailable (or fail); a softer image still beats an error on
  // the dashboard.
  const huge = Buffer.alloc(400 * 1024, 0x42);
  const small = Buffer.alloc(2048, 0x43);
  const api = fakeSnapApi({ main: huge, sub: small });

  const image = await captureImage(api, camera, config);
  assert.equal(image, toGladysImage(small));
  assert.deepEqual(api.asked, ['main', 'sub']);
});

test('a camera whose every stream overshoots reports it rather than publishing', async () => {
  const huge = Buffer.alloc(400 * 1024, 0x42);
  const api = fakeSnapApi({ main: huge, sub: huge });
  await assert.rejects(() => captureImage(api, camera, config), /REOLINK_IMAGE_TOO_LARGE/);
});
