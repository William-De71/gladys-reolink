# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions
follow [Semantic Versioning](https://semver.org/). This file is generated at
each release from the Conventional Commits: do not edit it by hand.

## [1.5.0] - 2026-10-25

### Added

- require Gladys 5.3 and declare catalog keywords ([0a912ff](https://github.com/William-De71/gladys-reolink/commit/0a912fff9b60f63d142e029f303c53c2c91a6bb2))

## [1.4.2] - 2026-10-24

### Security

- build the image on Node.js 24.22.1 or later ([72a8224](https://github.com/William-De71/gladys-reolink/commit/72a8224bf07e2e3fdeb6870e4b58e9e2fcb57b2a))

## [1.4.1] - 2026-10-15

### Fixed

- **discovery:** explain why a camera is not found when its HTTP API is off ([299082d](https://github.com/William-De71/gladys-reolink/commit/299082d995dbffe724cb15dc53911411fbfb694c))

## [1.4.0] - 2026-10-13

### Added

- **devices:** show whether a battery or solar camera is charging ([29a3b6b](https://github.com/William-De71/gladys-reolink/commit/29a3b6be08885fbf573bf245a5e2d5eb64c8c75d))

### Fixed

- show the state of a camera as soon as it is added, and of its lights as soon as they are switched ([18d6607](https://github.com/William-De71/gladys-reolink/commit/18d6607cfa9b0a9021d69d2597aac43478292a07))

## [1.3.0](https://github.com/William-De71/gladys-reolink/compare/v1.2.0...v1.3.0) (2026-10-11)

### Features

* **reolink:** instant ONVIF detections, native PTZ controls and doorbell ring ([5049ead](https://github.com/William-De71/gladys-reolink/commit/5049ead6b23f1a2aeb5da64786429a8c5332611b))

## [1.2.0](https://github.com/William-De71/gladys-reolink/compare/v1.1.0...v1.2.0) (2026-08-26)

### Features

* **reolink:** stop waking sleeping battery cameras on a timer ([335604a](https://github.com/William-De71/gladys-reolink/commit/335604ab15a52a3259b8ec3a1e4c0efc51500c70))
* **reolink:** support the Home Hub and NVR, one device per camera ([81b00ae](https://github.com/William-De71/gladys-reolink/commit/81b00ae749dd2ecfc948cc82f1c4957de05f8870))

### Bug Fixes

* **reolink:** name the cameras a hub does not describe, doorbell included ([05ac029](https://github.com/William-De71/gladys-reolink/commit/05ac0297bef28298e3e4a03f039b9f525f53d04b))

## [1.1.0](https://github.com/William-De71/gladys-reolink/compare/v1.0.1...v1.1.0) (2026-08-20)

### Features

* support SDK 0.12.0, store categories and automatic changelog ([2106519](https://github.com/William-De71/gladys-reolink/commit/210651936977283fffdb7033c2159baa0210c600))

### Miscellaneous

* restore the manifest formatting broken by release 1.0.1 ([184e7f1](https://github.com/William-De71/gladys-reolink/commit/184e7f16e4c36fbc93b0b0a1bf359519777862d8))

## [1.0.0](https://github.com/William-De71/gladys-reolink/compare/a7f22308f9e6f027d46ccbff8c5c6206acd55942...v1.0.0) (2026-08-02)

### Features

* add Reolink external integration for Gladys Assistant ([a7f2230](https://github.com/William-De71/gladys-reolink/commit/a7f22308f9e6f027d46ccbff8c5c6206acd55942))

### Bug Fixes

* hold back the AI detections until Gladys can display them ([68a1d69](https://github.com/William-De71/gladys-reolink/commit/68a1d693911450472b55496c38585fd8019ed89e))

[1.5.0]: https://github.com/William-De71/gladys-reolink/compare/v1.4.2...v1.5.0
[1.4.2]: https://github.com/William-De71/gladys-reolink/compare/v1.4.1...v1.4.2
[1.4.1]: https://github.com/William-De71/gladys-reolink/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/William-De71/gladys-reolink/compare/v1.3.0...v1.4.0
