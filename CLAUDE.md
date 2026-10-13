# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** of type `device`: it brings
[Reolink](https://reolink.com) cameras, doorbells, Home Hubs and NVRs into
Gladys over the **local network only** (no Reolink account, no cloud). Each
camera becomes one device: snapshot, live view (RTSP), motion and AI
detections, doorbell ring, battery, spotlight, siren, infrared LEDs and PTZ. A
Node.js service (Node 22+, ESM, no build step) that runs in its own sandboxed
Docker container and talks to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js).
The image ships `ffmpeg`, used only to shrink an oversized snapshot.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
node --test test/devices.test.js          # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store . --skip-image-check   # store checks
node .github/scripts/release.mjs plan     # the version the next release would get
```

## Architecture

```
index.js                    SDK wiring: handlers, actions, lifecycle
src/config.js               defaults, normalization, free-text parsing
src/devices.js              cameras -> Gladys devices and features
src/messages.js             user-facing messages, in en / fr / de / es
src/reolink/constants.js    protocol values, capabilities, device params
src/reolink/api.js          HTTP client: port probe, token, batching, Snap
src/reolink/sessions.js     one shared session per camera address
src/reolink/capabilities.js GetAbility / GetAiState -> what a camera can do
src/reolink/channels.js     Home Hub / NVR channels, models, sleep states
src/reolink/discovery.js    UDP broadcast discovery (mediated by Gladys)
src/reolink/rtsp.js         live URL (codec, port) and GetNetPort
src/reolink/snapshot.js     image capture, size-bounded
src/reolink/commands.js     spotlight, siren, IR, PTZ steps and presets
src/reolink/onvif.js        ONVIF pull-point events, clock sync, fallback
src/reolink/events.js       detections (ONVIF or polled) and battery
src/reolink/batteryGuard.js capture throttling on battery models
gladys-assistant-integration.json   manifest
docs/{en,fr,de,es}.md       user documentation, re-hosted by the store
.github/scripts/release.mjs version, changelog, bump (tested in test/)
```

## Rules

- **Ids and keys are forever**: the device and feature external ids (built by
  `gladys.externalIds`, the platform id is the camera UID, then the MAC, then
  the address; `<host>-ch<n>` behind a hub that hides the UID), the feature
  suffixes of `FEATURE_SUFFIXES`, and for each feature its `category`, `type`,
  `unit`, `min`, `max`; the PTZ option values (movement codes, preset
  numbers); the device param names; the keys of `config_schema` and of the
  actions. `test/structure.test.js` compares them to
  `test/fixtures/discovery.baseline.json` (version 1.3.0): features may be
  added, none may change or disappear. Never update the baseline to make a test
  pass without a documented migration.
- **`should_poll` / `poll_frequency`** (milliseconds, one of
  `DEVICE_POLL_FREQUENCIES`) are never resynchronized on a device already
  created: the image refresh loop in `index.js` exists for the cameras created
  before polling was declared.
- **States.** Publish changes only (300 states per minute per integration).
  States sent before a device is created are dropped: `onDeviceCreated`
  republishes everything of the new camera.
- **Battery cameras.** Every capture wakes the radio: never add a request on a
  timer without going through `BatteryGuard` and the sleep states of the hub.
- **The container rootfs is read-only.** Write only under `/data` (nothing is
  written today); captures go through pipes, never temporary files.
- **Four languages.** Every user-facing text (manifest, action results,
  `docs/*.md`, README) exists in English, French, German and Spanish, with the
  vocabulary of the Gladys interface. Feature
  names stay English: Gladys translates its own categories, and the user
  renames devices freely.
- **Versions belong to the Release workflow**: never edit `version` in
  `package.json`, the lockfile or the manifest, nor the `docker_image` tag.
- **Changelog.** Never edit CHANGELOG.md by hand, it is generated at the
  release. Write the PR title as the line the user will read.
- **Commits and PR titles** follow Conventional Commits, in English: `feat` ->
  minor, `fix` / `perf` -> patch, `!` or `BREAKING CHANGE:` -> major (minor
  below 1.0.0); `docs`, `chore`, `ci`, `test`, `style`, `refactor`, `build`
  release nothing. Scope `security` lands under "Security", a description
  starting with "remove" / "drop" under "Removed".
- **Manifest.** Texts are objects `{ "en", "fr", "de", "es" }`; the catalog
  `description` holds 10 to 100 characters per language, the whole file stays
  under the 100 KB of the store. A feature type or a field older cores do not
  know needs a higher `gladys_version` minimum (see `src/constants.js` of the
  integration-store).
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network or a real camera.
