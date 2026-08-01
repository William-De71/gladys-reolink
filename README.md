# gladys-reolink

External integration bringing **Reolink** cameras to [Gladys Assistant](https://gladysassistant.com): dashboard snapshots, live video, motion and AI detections as scene triggers, battery level, and control of the spotlight, siren, infrared LEDs and PTZ presets.

📖 User documentation: [English](docs/en.md) — [Français](docs/fr.md)

## What it does

- **Local only.** No Reolink account, no cloud: every exchange is a direct call to a camera on the LAN, over its documented HTTP API (`/cgi-bin/api.cgi`).
- **Discovery** by UDP broadcast on port 2000, the same exchange the Reolink client uses, plus a manual address list for what the broadcast cannot reach.
- **Features per camera, decided by asking the camera.** `GetAbility` and `GetAiState` say what a given unit supports; a spotlight switch is never created on a camera that has none.
- **Images straight from the camera** (`cmd=Snap`), which returns a ready-made JPEG — no video decoding on the nominal path.
- **Live video** through the `CAMERA_URL` param read by the rtsp-camera service.
- **Battery protection** for wire-free models, which backs off before the cell reaches a level it may not recover from.

## Architecture

```
index.js                    SDK wiring: handlers, actions, lifecycle
src/
  config.js                 defaults, normalization, free-text parsing
  devices.js                cameras -> Gladys devices and features
  reolink/
    constants.js            protocol values, capabilities, device params
    api.js                  HTTP client: port probe, token, batching, Snap
    sessions.js             one shared session per camera
    capabilities.js         GetAbility / GetAiState -> what a camera can do
    discovery.js            UDP broadcast discovery
    rtsp.js                 live URL, with the codec the camera serves
    snapshot.js             image capture, size-bounded
    commands.js             spotlight, siren, IR, PTZ
    events.js               motion / AI / doorbell / battery watcher
    batteryGuard.js         capture throttling on battery models
```

## Development

```bash
npm install
npm test          # node --test
npm run lint      # eslint
npm run format    # prettier
```

`ffmpeg` is optional: it only shrinks an oversized snapshot. Without it, the integration falls back to the camera's own low-resolution stream. The Docker image installs it.

## Design notes

**Everything is read in one batch.** The API is batch-oriented, and a poll asks for motion, AI state, battery and doorbell in a single round trip. On a battery model each request wakes the radio, so three separate reads would cost three wakeups per round.

**One session per camera, shared.** A camera only accepts a handful of concurrent sessions and does not free them when the client walks away — they expire minutes later. A single poll round touches a camera three times (capture, actuators, detections), so the API client is owned by a pool keyed by address rather than opened per call. Without it, a busy install exhausts the pool and every command starts failing with a "login refused" that has nothing to do with the password.

**Detections are states, not events.** Reolink reports "is motion firing right now" rather than a history, so the poll interval _is_ the detection latency, and a detection seen once has to be brought back down by the integration. Only changes are published: re-publishing `1` every round while a car stays parked in frame would flood the history and re-trigger scenes at each poll.

**Capabilities come from the camera, never from its model name.** Two cameras of the same range differ, and `GetAbility` is also user-scoped — a restricted account sees fewer abilities than an admin.

**The RTSP path is not mechanical.** The channel is 1-based and zero-padded there (`01`) while every JSON command numbers it from 0, and the codec is part of the path — a recent camera serves h265 on its main stream, so `GetEnc` is asked rather than assumed.

## Not covered

NVR and Home Hub devices, which expose several cameras behind one address. The API supports it through the `channel` parameter — every call here already carries one — but the device model, discovery and configuration would need to represent a multi-camera host, which is a separate piece of work.

## License

Apache-2.0
