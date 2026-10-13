// -----------------------------------------------------------------------------
// Representative cameras, as `resolveChannel` produces them, covering every
// branch of `buildFeatures`: a wired PTZ camera with every actuator, a battery
// doorbell, a camera behind a Home Hub identified by its host and channel, and
// a bare camera known only by its MAC.
//
// test/fixtures/discovery.baseline.json was generated from these cameras with
// the code of version 1.3.0; test/structure.test.js rebuilds them with the
// current code and compares.
// -----------------------------------------------------------------------------

import { CAPABILITIES } from '../../src/reolink/constants.js';

const ALL_WIRED = [
  CAPABILITIES.FLOODLIGHT,
  CAPABILITIES.SIREN,
  CAPABILITIES.IR_LIGHTS,
  CAPABILITIES.PTZ_PRESETS,
  CAPABILITIES.PTZ_PAN_TILT,
  CAPABILITIES.PTZ_ZOOM,
  CAPABILITIES.AI_PEOPLE,
  CAPABILITIES.AI_VEHICLE,
  CAPABILITIES.AI_ANIMAL,
];

/** The cameras, by a short name used in the baseline. */
export const SAMPLE_CAMERAS = {
  wiredPtz: {
    name: 'Driveway',
    model: 'RLC-823A',
    ip: '192.168.1.42',
    port: 443,
    https: true,
    channel: 0,
    uid: '95270005ZBCDEFGH',
    platformId: '95270005ZBCDEFGH',
    hostUid: null,
    mac: 'EC:71:DB:11:22:33',
    capabilities: ALL_WIRED,
    codecs: { main: 'h265', sub: 'h264' },
    presets: [
      { id: 1, name: 'Gate' },
      { id: 3, name: 'Garage' },
    ],
    rtspPort: 554,
    rtspEnabled: true,
    onvifPort: 8000,
    streamUrl: 'rtsp://admin:secret@192.168.1.42:554/h265Preview_01_main',
  },
  batteryDoorbell: {
    name: 'Front door',
    model: 'Reolink Video Doorbell',
    ip: '192.168.1.50',
    port: 80,
    https: false,
    channel: 0,
    uid: '9527000KN95C1JG7',
    platformId: '9527000KN95C1JG7',
    hostUid: null,
    mac: null,
    capabilities: [CAPABILITIES.BATTERY, CAPABILITIES.DOORBELL, CAPABILITIES.AI_PEOPLE],
    codecs: { main: 'h264', sub: 'h264' },
    presets: [],
    rtspPort: 554,
    rtspEnabled: false,
    onvifPort: 0,
    streamUrl: 'rtsp://admin:secret@192.168.1.50:554/h264Preview_01_sub',
  },
  hubChannel: {
    name: 'Living room',
    model: 'E1 Zoom',
    ip: '192.168.1.69',
    port: 443,
    https: true,
    channel: 3,
    uid: null,
    platformId: '9527000HUB00001A-ch3',
    hostUid: '9527000HUB00001A',
    mac: null,
    capabilities: [CAPABILITIES.PTZ_PRESETS, CAPABILITIES.PTZ_PAN_TILT, CAPABILITIES.PTZ_ZOOM],
    codecs: { main: 'h264', sub: 'h264' },
    presets: [{ id: 2, name: 'Sofa' }],
    rtspPort: 554,
    rtspEnabled: true,
    onvifPort: 0,
    streamUrl: 'rtsp://admin:secret@192.168.1.69:554/h264Preview_04_main',
  },
  bare: {
    name: 'Shed',
    model: 'RLC-510A',
    ip: '192.168.1.77',
    port: 80,
    https: false,
    channel: 0,
    uid: null,
    platformId: 'EC71DB445566',
    hostUid: null,
    mac: 'EC:71:DB:44:55:66',
    capabilities: [],
    codecs: { main: 'h264', sub: 'h264' },
    presets: [],
    rtspPort: null,
    rtspEnabled: true,
    onvifPort: 0,
    streamUrl: 'rtsp://admin:secret@192.168.1.77:554/h264Preview_01_main',
  },
};
