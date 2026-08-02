// -----------------------------------------------------------------------------
// Every Reolink-specific constant, in one place.
//
// Reolink cameras expose a documented local HTTP API on `/cgi-bin/api.cgi`:
// a POST whose body is an ARRAY of commands, answered by an ARRAY of results.
// No cloud account is involved — everything here happens on the LAN, which is
// why this integration declares only the `local` transport.
// -----------------------------------------------------------------------------

/**
 * The `type` part of the external ids, as in
 * `ext:<selector>:<type>:<platformId>`. The SDK builds them; this is the only
 * piece the integration chooses.
 */
export const EXTERNAL_ID_TYPE = 'camera';

// --- Local HTTP API ----------------------------------------------------------

/** Path of the CGI endpoint, identical on every model and firmware. */
export const API_PATH = '/cgi-bin/api.cgi';

/**
 * Ports tried when the user did not pin one, in order.
 *
 * Reolink firmwares ship with HTTP on 80 by default, but recent ones (and every
 * camera whose owner ticked "HTTPS only") answer on 443 instead. Probing beats
 * asking: the port is an implementation detail the user has no reason to know.
 */
export const API_PORTS = [
  { port: 80, https: false },
  { port: 443, https: true },
];

/** A local request that hangs must not hold the event loop. */
export const API_TIMEOUT_MS = 10 * 1000;

/**
 * How long before its expiry a token is renewed, in seconds.
 *
 * The camera hands out a token with a `leaseTime` (usually 3600 s). Renewing at
 * the very last second races the clock skew between Gladys and the camera, so
 * the session is refreshed while it is still comfortably valid.
 */
export const TOKEN_RENEW_MARGIN_SECONDS = 300;

/**
 * Error codes the firmware returns in `[{ code, error: { rspCode } }]`.
 *
 * Only the ones this integration acts on are listed. `-6` and `-7` both mean
 * "your token is no longer accepted", which is the signal to log in again
 * rather than to report a failure to the user.
 */
export const API_ERROR_CODES = {
  LOGIN_REQUIRED: -6,
  TOKEN_EXPIRED: -7,
  LOGIN_FAILED: -8,
  ABILITY_ERROR: -9,
};

/** Codes that mean "re-authenticate and retry", not "this request is wrong". */
export const RETRYABLE_ERROR_CODES = [
  API_ERROR_CODES.LOGIN_REQUIRED,
  API_ERROR_CODES.TOKEN_EXPIRED,
];

// --- Local network discovery --------------------------------------------------

/**
 * UDP port Reolink devices listen on for the discovery broadcast, and the magic
 * bytes the Reolink client sends. A camera answers with a payload carrying its
 * UID, MAC and name — the same exchange the desktop client uses to populate its
 * device list.
 */
export const DISCOVERY_PORT = 2000;

/** The 4-byte magic the devices answer to. */
export const DISCOVERY_MAGIC = 'aaaa0000';

/** How long the core listens for discovery replies. */
export const DISCOVERY_TIMEOUT_SECONDS = 5;

// --- RTSP --------------------------------------------------------------------

/** The RTSP port of every Reolink camera. */
export const RTSP_PORT = 554;

/**
 * RTSP paths, per quality. Reolink exposes two streams under the fixed
 * `/h264Preview_<channel>_<quality>` scheme: `main` is the full-resolution one,
 * `sub` the lighter D1/VGA feed.
 */
export const RTSP_STREAMS = {
  HD: 'main',
  SD: 'sub',
};

/**
 * The channel every standalone camera answers on.
 *
 * Reolink numbers the video inputs of an NVR from 0; a camera used on its own
 * only ever has channel 0. NVR and Home Hub support (several channels behind one
 * address) is deliberately out of scope, so this is a constant rather than a
 * per-device param.
 */
export const DEFAULT_CHANNEL = 0;

// --- Device params stored on each Gladys device -------------------------------

export const DEVICE_PARAMS = {
  /** Local IP (or hostname) of the camera. */
  IP: 'REOLINK_IP',
  /** HTTP port of the API, discovered by probing. */
  PORT: 'REOLINK_PORT',
  /** '1' when the API is reached over HTTPS. */
  HTTPS: 'REOLINK_HTTPS',
  /** Camera UID, the stable identity across renames and IP changes. */
  UID: 'REOLINK_UID',
  /** Camera model, e.g. RLC-810A (shown to the user, drives nothing). */
  MODEL: 'REOLINK_MODEL',
  /** Comma-separated list of the capabilities detected on this camera. */
  CAPABILITIES: 'REOLINK_CAPABILITIES',
  /**
   * Stream URL read by the rtsp-camera service to serve the live view. The name
   * is imposed by that service, which is why it carries no REOLINK_ prefix.
   */
  CAMERA_URL: 'CAMERA_URL',
  /** Rotation applied to the live view, same contract as rtsp-camera. */
  CAMERA_ROTATION: 'CAMERA_ROTATION',
};

/**
 * How often Gladys polls a camera. One of the frequencies the core accepts.
 *
 * This is the CEILING, not the capture rate: `onPoll` is also what reads the
 * battery, the actuators and the detections, and those must keep running even
 * when capturing is paused. The interval between two captures is decided per
 * camera by `image_refresh_interval` / `battery_image_refresh_interval`, which
 * the poll honours through a per-device timestamp.
 */
export const POLL_FREQUENCY_MS = 60 * 1000;

// --- Capabilities ------------------------------------------------------------

/**
 * What a camera can do, as resolved from its `GetAbility` answer.
 *
 * Features are built from these: declaring a spotlight on a camera that has none
 * would put a switch on the dashboard that silently does nothing.
 */
export const CAPABILITIES = {
  BATTERY: 'battery',
  FLOODLIGHT: 'floodlight',
  SIREN: 'siren',
  IR_LIGHTS: 'ir_lights',
  PTZ_PRESETS: 'ptz_presets',
  AI_PEOPLE: 'ai_people',
  AI_VEHICLE: 'ai_vehicle',
  AI_ANIMAL: 'ai_animal',
  DOORBELL: 'doorbell',
};

/**
 * Ability keys, as the firmware names them in `GetAbility`, mapped to the
 * capability they unlock. Several spellings exist for the same thing: firmwares
 * disagree, and a camera only ever announces one of them.
 */
export const ABILITY_KEYS = {
  [CAPABILITIES.BATTERY]: ['battery'],
  [CAPABILITIES.FLOODLIGHT]: ['floodLight', 'supportFLswitch'],
  [CAPABILITIES.SIREN]: ['alarmAudio', 'supportAudioAlarm'],
  [CAPABILITIES.IR_LIGHTS]: ['ledControl', 'supportIrLight'],
  [CAPABILITIES.PTZ_PRESETS]: ['ptzPreset'],
};

// --- Features ----------------------------------------------------------------

/** Suffixes of the feature external ids, appended to the device external id. */
export const FEATURE_SUFFIXES = {
  IMAGE: 'image',
  MOTION: 'motion',
  DOORBELL: 'doorbell',
  BATTERY: 'battery',
  AI_PEOPLE: 'ai-people',
  AI_VEHICLE: 'ai-vehicle',
  AI_ANIMAL: 'ai-animal',
  FLOODLIGHT: 'floodlight',
  SIREN: 'siren',
  IR_LIGHTS: 'ir-lights',
  PTZ_PRESET: 'ptz-preset',
};

/**
 * Whether the AI detections (person, vehicle, animal) become Gladys features.
 *
 * They are held back, NOT removed: the capability detection, the polling and the
 * feature builders below all stay in place and come back by flipping this to
 * true. The reason is entirely on the Gladys side — the core knows the
 * `presence-sensor` category, but its front end only maps it to the `push` type.
 * A `presence-sensor` + `binary` feature therefore reaches the UI with no label
 * and no icon (an empty grey box in the device editor), and its history renders
 * through `LastSeenDeviceValue`, showing "seen 9 hours ago" instead of a
 * yes/no state.
 *
 * See `docs/gladys-presence-sensor-binary.md` for the upstream change that
 * makes them displayable, and flip this once it has shipped.
 */
export const AI_FEATURES_ENABLED = false;

/**
 * How long a detection stays reported before being reset to 0.
 *
 * `GetMdState` and `GetAiState` report the CURRENT state, so a detection that
 * ended between two polls would otherwise be missed entirely — and one still
 * running is re-read as 1 on the next round anyway. This only bounds how long a
 * detection seen once stays up when the camera stops reporting it.
 */
export const DETECTION_RESET_MS = 30 * 1000;

// --- Images ------------------------------------------------------------------

/**
 * Largest base64 payload an image may reach.
 *
 * The host API documents 150 KB, but that bound is never reached: Gladys mounts
 * `express.json()` with no `limit`, so the HTTP layer rejects any body above
 * Express' 100 KB default with `PayloadTooLargeError` — before the application
 * check ever runs. The effective ceiling is therefore ~100 KB for the WHOLE
 * request, and the margin below leaves room for the JSON envelope.
 *
 * `snapshot.js` lowers the JPEG quality until the payload fits.
 */
export const IMAGE_MAX_BYTES = 96 * 1024;
export const IMAGE_WIDTH = 1280;

// --- Battery protection ------------------------------------------------------

/**
 * Battery thresholds guarding a battery/solar camera, in percent.
 *
 * A lithium cell drained too far may stop accepting charge altogether, and a
 * solar panel only refills it in bursts — so capturing must back off long before
 * the camera reaches a critical level.
 *
 * Only battery models are affected; a wired camera is never throttled.
 */
export const BATTERY_THRESHOLDS = {
  /** Below this, the periodic image refresh stops. */
  PAUSE_REFRESH: 60,
  /** Below this, no capture at all happens, not even an explicit one. */
  STOP_ALL: 40,
  /**
   * Level at which capturing resumes.
   *
   * Comfortably above the pause threshold rather than a couple of points over
   * it: resuming early restarts the drain on a still-weak reserve, and repeated
   * shallow cycles in the low range wear the cell faster than one proper cycle.
   *
   * NOT a full charge, though. A camera on its charger is already released by
   * `chargeStatus`, so this level only ever applies to a camera refilling on
   * SOLAR — which charges in bursts and rarely sits at 100%. Requiring it meant
   * a solar camera that dipped once stayed paused for good, with no charger to
   * put it on.
   */
  RESUME: 80,
};

/**
 * How long a battery reading stays trusted, in milliseconds.
 *
 * The guard decides from the last known level, so a level that stopped being
 * refreshed — camera asleep, session refused, network down — must not keep
 * authorizing captures on an increasingly stale number. Past this age the
 * reading is dropped and a battery camera falls back to on-demand only.
 *
 * Generous on purpose: a battery camera in deep sleep legitimately misses
 * several rounds, and treating that as a fault would pause it for nothing.
 */
export const BATTERY_READING_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * `chargeStatus` values of `GetBatteryInfo`.
 *
 * A camera on its charger is not draining, so the guard must not hold it back:
 * `chargeComplete` and `charging` both mean the cell is being refilled.
 */
export const CHARGE_STATUS = {
  NONE: 0,
  CHARGING: 1,
  CHARGE_COMPLETE: 2,
  LOW_POWER: 3,
};
