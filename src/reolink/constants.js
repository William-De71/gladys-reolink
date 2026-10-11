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

/**
 * The RTSP port of a Reolink camera left at its factory settings.
 *
 * Only the fallback: the port can be changed in the Reolink app, and
 * `GetNetPort` reports the one actually in use (see `NET_PORT_COMMAND`).
 */
export const RTSP_PORT = 554;

/**
 * Command reporting the network services of a camera: which ports RTSP and
 * ONVIF listen on, and whether they are enabled at all.
 *
 * Asked at discovery because recent firmwares ship with RTSP and ONVIF turned
 * OFF: a live URL built on the default port of a disabled server fails with a
 * timeout that says nothing about the cause, and so would an ONVIF
 * subscription.
 */
export const NET_PORT_COMMAND = 'GetNetPort';

// --- ONVIF events ------------------------------------------------------------

/**
 * The ONVIF port of a Reolink camera left at its factory settings. Like the RTSP
 * one, the port actually in use comes from `GetNetPort`.
 */
export const ONVIF_PORT = 8000;

/** Path of the ONVIF device service, identical on every Reolink firmware. */
export const ONVIF_DEVICE_PATH = '/onvif/device_service';

/**
 * How long the camera may hold a `PullMessages` request open, in seconds.
 *
 * This is NOT the detection delay: the camera answers the moment something
 * happens. It only bounds how long a quiet pull lasts before being reissued,
 * so a longer one means fewer requests on a quiet camera.
 */
export const ONVIF_PULL_TIMEOUT_SECONDS = 30;

/** Timeout of every other ONVIF call (capabilities, subscribe, renew). */
export const ONVIF_REQUEST_TIMEOUT_MS = 10 * 1000;

/**
 * Margin added on top of a request timeout before the overall deadline fires.
 *
 * The socket timeout only measures inactivity; the deadline is what bounds a
 * camera dripping bytes or cutting the connection mid-body.
 */
export const ONVIF_DEADLINE_MARGIN_MS = 2 * 1000;

/** Largest SOAP answer accepted: these are a few kilobytes at most. */
export const ONVIF_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * Consecutive timeouts after which a quiet camera is treated as gone.
 *
 * One timeout is a firmware holding a quiet pull a little long; several in a row
 * is a camera that stopped answering.
 */
export const ONVIF_QUIET_TIMEOUTS_BEFORE_FAILURE = 3;

/**
 * Consecutive failures after which a camera falls back to polling.
 *
 * Polling is the safety net, never switched off for good: as soon as the pull
 * loop recovers, the camera goes back to ONVIF.
 */
export const ONVIF_FAILURES_BEFORE_FALLBACK = 3;

/**
 * When to renew the subscription, in milliseconds after it was opened.
 *
 * The subscription is requested for ten minutes; renewing at eight leaves room
 * for a slow answer without the camera ever dropping it.
 */
export const ONVIF_RENEW_AFTER_MS = 8 * 60 * 1000;

/**
 * Pull answered this fast with nothing in it means the firmware does not hold
 * the request open (some Reolink firmwares answer at once). The loop then
 * spaces its pulls by `ONVIF_FAST_PULL_PAUSE_MS` instead of spinning.
 */
export const ONVIF_FAST_PULL_MS = 1000;

/** Pause between two pulls on a firmware that does not long-poll. */
export const ONVIF_FAST_PULL_PAUSE_MS = 1500;

/**
 * How long a detection reported over ONVIF stays up when the camera never says
 * it ended.
 *
 * Much longer than the polled `DETECTION_RESET_MS`: ONVIF reports the end of a
 * detection itself, so this is only a safety net against a lost message, and a
 * short one would drop a motion that is still going on.
 */
export const ONVIF_DETECTION_RESET_MS = 5 * 60 * 1000;

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
 * The channel a standalone camera answers on.
 *
 * Reolink numbers the video inputs from 0, and a camera used on its own only
 * ever has channel 0. A Home Hub or an NVR puts SEVERAL cameras behind one
 * address, each on its own channel, so the channel is stored per device (see
 * `DEVICE_PARAMS.CHANNEL`) and this is only the fallback for a device that
 * predates that param, or for a camera reached directly.
 */
export const DEFAULT_CHANNEL = 0;

/**
 * `exactType`/`type` values of `GetDevInfo` that mean "several cameras behind
 * this address".
 *
 * A Home Hub is an NVR as far as the API is concerned — the difference matters
 * only for features this integration does not use (recording, HDD), so both are
 * enumerated the same way. The values come from what the firmware actually
 * answers; anything else is a plain camera (`IPC`).
 */
export const MULTI_CHANNEL_DEVICE_TYPES = ['NVR', 'WIFI_NVR', 'HOMEHUB'];

/**
 * The `typeInfo` marker that identifies a doorbell behind a hub.
 *
 * Behind a hub, `GetAbility` is answered by the HUB, which has no doorbell
 * button of its own to declare — so the per-channel model string is the only
 * thing that tells a doorbell from an ordinary camera.
 */
export const DOORBELL_MODEL_MARKER = 'Doorbell';

/**
 * The `boardInfo` prefix that identifies a doorbell behind a hub.
 *
 * A second, independent marker: the commercial name in `typeInfo` is what
 * Reolink prints on the box and translates per market, while `boardInfo` names
 * the hardware and starts with `DB_` on every doorbell board — as in
 * `DB_560MIXDB32M35DBB14MP`. Checking both means a doorbell sold under a name
 * that never says "Doorbell" is still recognised.
 */
export const DOORBELL_BOARD_PREFIX = 'DB_';

/**
 * Per-channel command giving the model of the camera on one channel.
 *
 * `GetChannelstatus` carries a `typeInfo` on some firmwares only; this is the
 * command that answers for the rest. The hub replies on behalf of its cameras,
 * so asking costs nothing to a sleeping battery model.
 *
 * Firmwares disagree on the shape of the answer: some nest it under
 * `ChnTypeInfo`, others return the fields directly in `value`. Both are read.
 */
export const CHANNEL_TYPE_COMMAND = 'GetChnTypeInfo';

/**
 * Largest number of channels an answer may declare.
 *
 * A firmware that reports a nonsense `count` (or a `channelNum` left at a
 * placeholder) would otherwise have this integration probe hundreds of channels
 * on every scan, each one a request to a device that has nothing to answer.
 * Reolink's largest NVR takes 36 cameras, so this is well clear of any real
 * installation.
 */
export const MAX_CHANNELS = 64;

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
   * Video channel of this camera on its host.
   *
   * Always '0' for a camera reached directly; behind a Home Hub or an NVR it is
   * what tells the cameras apart, since they all share one address, one port and
   * one session.
   */
  CHANNEL: 'REOLINK_CHANNEL',
  /**
   * UID of the HOST this camera answers through, when it is not the camera
   * itself. Empty for a direct camera, the hub UID for a camera behind one.
   *
   * Kept so a camera whose own identity is unreadable can still derive a stable
   * id from its host plus its channel.
   */
  HOST_UID: 'REOLINK_HOST_UID',
  /**
   * Stream URL read by the rtsp-camera service to serve the live view. The name
   * is imposed by that service, which is why it carries no REOLINK_ prefix.
   */
  CAMERA_URL: 'CAMERA_URL',
  /** Rotation applied to the live view, same contract as rtsp-camera. */
  CAMERA_ROTATION: 'CAMERA_ROTATION',
  /**
   * Port of the ONVIF server, '0' when the camera has none or keeps it disabled.
   *
   * Only ever set on a camera reached directly: behind a hub or an NVR, ONVIF
   * events do not say which camera they come from reliably enough to be used.
   */
  ONVIF_PORT: 'REOLINK_ONVIF_PORT',
  /** '1' when the camera reported its RTSP server as disabled at discovery. */
  RTSP_DISABLED: 'REOLINK_RTSP_DISABLED',
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
  PTZ_PAN_TILT: 'ptz_pan_tilt',
  PTZ_ZOOM: 'ptz_zoom',
};

/**
 * `ptzType` versions of `GetAbility`, and the movements each one allows.
 *
 * Unlike the other abilities, the `ver` here is not a "supported" flag but an
 * enumeration of the mechanics: a zoom lens alone (the "AF" bullet cameras), a
 * pan/tilt head without zoom, or both. Reading it as a plain boolean would put
 * arrows on a camera that can only zoom.
 */
export const PTZ_TYPE_VERSIONS = {
  ZOOM: [1, 2, 5],
  PAN_TILT: [2, 3, 5],
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
  // Kept as it was when this feature was a numeric switch: the value sent is
  // still the preset NUMBER, so the scenes built on the old feature keep working.
  PTZ_PRESET: 'ptz-preset',
  PTZ_MOVE: 'ptz-move',
};

// --- PTZ ---------------------------------------------------------------------

/**
 * Canonical values of the Gladys `camera/move` feature.
 *
 * Mirrors `CAMERA_MOVE` in the core (`server/utils/constants.js`, spec
 * `docs/specs/camera-ptz-control.md` A.2). Declared here because the SDK
 * publishes the feature TYPES but no constant for the movement VALUES.
 */
export const CAMERA_MOVE = {
  STOP: 0,
  PAN_LEFT: 1,
  PAN_RIGHT: 2,
  TILT_UP: 3,
  TILT_DOWN: 4,
  ZOOM_IN: 5,
  ZOOM_OUT: 6,
};

/** The `PtzCtrl` operation of each movement. */
export const PTZ_OPERATIONS = {
  [CAMERA_MOVE.STOP]: 'Stop',
  [CAMERA_MOVE.PAN_LEFT]: 'Left',
  [CAMERA_MOVE.PAN_RIGHT]: 'Right',
  [CAMERA_MOVE.TILT_UP]: 'Up',
  [CAMERA_MOVE.TILT_DOWN]: 'Down',
  [CAMERA_MOVE.ZOOM_IN]: 'ZoomInc',
  [CAMERA_MOVE.ZOOM_OUT]: 'ZoomDec',
};

/**
 * How long one movement runs before the integration stops it, in milliseconds.
 *
 * `PtzCtrl` starts a CONTINUOUS move that only ends on `Stop`. A lone value — a
 * scene action, a dashboard tap whose release is lost — must still end in a
 * nudge, never in a camera spinning until someone notices, so every move is a
 * bounded step that stops itself.
 */
export const PTZ_STEP_MS = 600;

/** Speed of a step, 1-64. Slow enough for a step to be a nudge, not a swing. */
export const PTZ_STEP_SPEED = 16;

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
