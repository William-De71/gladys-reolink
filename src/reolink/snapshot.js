// -----------------------------------------------------------------------------
// Image capture.
//
// Reolink cameras answer `cmd=Snap` with a ready-made JPEG, so — unlike a
// camera whose only output is a video stream — the nominal path needs no
// decoding at all: one HTTP request, one image.
//
// The one thing that has to be handled is SIZE. A 4K camera returns a frame of
// several hundred kilobytes, well above what Gladys accepts (see
// IMAGE_MAX_BYTES). Two levers, in order of preference:
//
//   1. ask the camera for its `sub` stream, which is natively small. Free, and
//      no re-encoding — but a `sub` frame is D1/VGA, visibly soft on a big
//      dashboard tile;
//   2. re-encode with ffmpeg, which keeps the main-stream framing and trades
//      quality then resolution until the payload fits.
//
// So the main stream is tried first and only re-encoded when it overshoots; the
// `sub` stream is the fallback for when ffmpeg is unavailable.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { logger } from '@gladysassistant/integration-sdk';
import { IMAGE_MAX_BYTES, IMAGE_WIDTH } from './constants.js';

/**
 * Re-encode steps, tried in order until the payload fits, as
 * `[width, -qscale:v]` pairs (qscale: 2 = best, 31 = worst).
 *
 * Quality alone is not enough: past `-qscale:v 15` the returns collapse, and a
 * detailed outdoor scene can stay above the limit no matter how far the quality
 * drops. Halving the pixel count is the effective lever, so the steps trade
 * resolution once quality has done what it can.
 */
const RESIZE_STEPS = [
  [IMAGE_WIDTH, 8],
  [IMAGE_WIDTH, 15],
  [1024, 12],
  [1024, 20],
  [800, 15],
];

/** Remembered across calls: probing for ffmpeg on every capture is wasteful. */
let ffmpegAvailable = null;

/**
 * Tell whether the encoded payload fits in what Gladys accepts.
 * @param {Buffer} image - The JPEG bytes.
 * @returns {boolean} True when the base64 payload is within the limit.
 * @example
 * fitsInLimit(jpeg);
 */
export function fitsInLimit(image) {
  // base64 inflates the payload by ~4/3, and Gladys checks the ENCODED size.
  return Math.ceil(image.length / 3) * 4 <= IMAGE_MAX_BYTES;
}

/**
 * Format a JPEG the way Gladys expects it.
 * @param {Buffer} image - The JPEG bytes.
 * @returns {string} The `image/jpg;base64,...` string.
 * @example
 * toGladysImage(jpeg);
 */
export function toGladysImage(image) {
  return `image/jpg;base64,${image.toString('base64')}`;
}

/**
 * Re-encode a JPEG smaller with ffmpeg, through pipes only.
 *
 * Nothing is written to disk: the sandbox mounts the rootfs read-only, and a
 * JPEG in memory is cheaper than a temporary file anyway.
 * @param {Buffer} image - The source JPEG.
 * @param {number} width - The target width, height follows the aspect ratio.
 * @param {number} quality - The `-qscale:v` value.
 * @param {number} timeoutMs - Kill ffmpeg after this delay.
 * @returns {Promise<Buffer>} The re-encoded JPEG.
 * @example
 * await reencode(jpeg, 1024, 12, 10000);
 */
export function reencode(image, width, quality, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      '-',
      '-vf',
      `scale=${width}:-1`,
      '-qscale:v',
      String(quality),
      '-frames:v',
      '1',
      '-f',
      'image2pipe',
      '-vcodec',
      'mjpeg',
      '-',
    ]);

    /** @type {Buffer[]} */
    const chunks = [];
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => ffmpeg.kill('SIGKILL'), timeoutMs);

    /**
     * Settle once, whatever happens first.
     * @param {Error|null} error - The failure, or null on success.
     * @param {Buffer} [result] - The re-encoded image.
     * @example
     * settle(null, buffer);
     */
    const settle = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-500);
    });

    ffmpeg.on('error', (e) => {
      settle(new Error(e.code === 'ENOENT' ? 'FFMPEG_NOT_FOUND' : `FFMPEG_FAILED:${e.message}`));
    });

    ffmpeg.on('close', () => {
      const output = Buffer.concat(chunks);
      if (output.length > 0) {
        settle(null, output);
        return;
      }
      settle(new Error(`FFMPEG_NO_OUTPUT:${stderr}`));
    });

    // A closed pipe when ffmpeg exits first is expected, not a failure.
    ffmpeg.stdin.on('error', () => {});
    ffmpeg.stdin.end(image);
  });
}

/**
 * Shrink an image until it fits, giving up gracefully when ffmpeg is missing.
 * @param {Buffer} image - The source JPEG.
 * @param {string} cameraName - Used for the logs only.
 * @param {number} timeoutMs - Budget for each ffmpeg run.
 * @returns {Promise<Buffer|null>} A fitting JPEG, or null when none was reached.
 * @example
 * await shrinkToFit(jpeg, 'Garden', 10000);
 */
export async function shrinkToFit(image, cameraName, timeoutMs) {
  if (ffmpegAvailable === false) {
    return null;
  }

  for (const [width, quality] of RESIZE_STEPS) {
    let candidate;
    try {
      candidate = await reencode(image, width, quality, timeoutMs);
      ffmpegAvailable = true;
    } catch (e) {
      if (e.message === 'FFMPEG_NOT_FOUND') {
        // Remembered so the remaining steps — and every later capture — skip
        // straight to the `sub` stream fallback instead of spawning in vain.
        ffmpegAvailable = false;
        logger.warn(
          'ffmpeg is not available: oversized images will fall back to the camera low-resolution stream.',
        );
        return null;
      }
      logger.debug(`Re-encoding the image of "${cameraName}" failed: ${e.message}`);
      return null;
    }

    if (fitsInLimit(candidate)) {
      return candidate;
    }
    logger.debug(
      `The image of "${cameraName}" is still too big at ${width}px/q${quality}, retrying smaller`,
    );
  }
  return null;
}

/**
 * Capture one image of a camera and return it in the format Gladys expects.
 * @param {object} api - The camera API client.
 * @param {object} camera - The resolved camera (name, channel).
 * @param {object} config - The normalized configuration.
 * @returns {Promise<string>} The `image/jpg;base64,...` string.
 * @example
 * const image = await captureImage(api, camera, config);
 */
export async function captureImage(api, camera, config) {
  const timeoutMs = config.capture_timeout * 1000;

  // The user may have asked for the low-resolution stream outright, on a slow
  // network or to spare a battery camera.
  const preferred = config.stream_quality === 'SD' ? 'sub' : 'main';
  const image = await api.snapshot({ channel: camera.channel, stream: preferred });

  if (fitsInLimit(image)) {
    return toGladysImage(image);
  }

  logger.debug(`The image of "${camera.name}" is ${image.length} bytes, shrinking it`);
  const shrunk = await shrinkToFit(image, camera.name, timeoutMs);
  if (shrunk) {
    return toGladysImage(shrunk);
  }

  // ffmpeg could not help. The camera itself can produce a smaller frame, which
  // is softer but real — and an image beats an error on the dashboard.
  if (preferred === 'main') {
    logger.debug(`Falling back to the low-resolution stream for "${camera.name}"`);
    const small = await api.snapshot({ channel: camera.channel, stream: 'sub' });
    if (fitsInLimit(small)) {
      return toGladysImage(small);
    }
  }

  throw new Error(`REOLINK_IMAGE_TOO_LARGE:${image.length}`);
}

/**
 * Reset the remembered ffmpeg probe. Tests only.
 * @example
 * resetFfmpegProbe();
 */
export function resetFfmpegProbe() {
  ffmpegAvailable = null;
}
