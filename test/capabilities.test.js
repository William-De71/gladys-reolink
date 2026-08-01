import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  abilityVersion,
  supportsCapability,
  parseAiSupport,
  aiStateOf,
  resolveCapabilities,
  aiTypesOf,
} from '../src/reolink/capabilities.js';
import { CAPABILITIES } from '../src/reolink/constants.js';

test('abilityVersion reads both the shared and the per-channel blocks', () => {
  const ability = {
    battery: { ver: 1, permit: 4 },
    abilityChn: [{ floodLight: { ver: 1, permit: 6 } }],
  };
  assert.equal(abilityVersion(ability, 'battery'), 1);
  assert.equal(abilityVersion(ability, 'floodLight'), 1);
  assert.equal(abilityVersion(ability, 'missing'), 0);
  assert.equal(abilityVersion(null, 'battery'), 0);
});

test('supportsCapability accepts any of the spellings a firmware may use', () => {
  // Firmwares announce one spelling or the other, never both, so matching a
  // single name would miss half the cameras.
  assert.equal(supportsCapability({ floodLight: { ver: 1 } }, CAPABILITIES.FLOODLIGHT), true);
  assert.equal(supportsCapability({ supportFLswitch: { ver: 1 } }, CAPABILITIES.FLOODLIGHT), true);
  assert.equal(supportsCapability({ alarmAudio: { ver: 1 } }, CAPABILITIES.SIREN), true);
  assert.equal(supportsCapability({ supportAudioAlarm: { ver: 1 } }, CAPABILITIES.SIREN), true);
  assert.equal(supportsCapability({}, CAPABILITIES.SIREN), false);
});

test('supportsCapability treats a version of 0 as unsupported', () => {
  assert.equal(supportsCapability({ battery: { ver: 0 } }, CAPABILITIES.BATTERY), false);
});

test('parseAiSupport honours the per-type support flag of recent firmwares', () => {
  // From firmware 3.0.0.494 a type is reported with `support: 0` when the camera
  // lists it without being able to detect it — creating a feature for it would
  // put a sensor on the dashboard that never fires.
  const aiState = {
    channel: 0,
    people: { alarm_state: 0, support: 1 },
    vehicle: { alarm_state: 0, support: 1 },
    face: { alarm_state: 0, support: 0 },
  };
  assert.deepEqual(parseAiSupport(aiState).sort(), ['people', 'vehicle']);
});

test('parseAiSupport keeps the plain-number shape of older firmwares', () => {
  // Before 3.0.0.494 each type is a bare 0/1 with no support flag: its presence
  // is the only signal available.
  assert.deepEqual(parseAiSupport({ channel: 0, people: 0, dog_cat: 1 }).sort(), [
    'dog_cat',
    'people',
  ]);
});

test('parseAiSupport tolerates a missing answer', () => {
  assert.deepEqual(parseAiSupport(null), []);
  assert.deepEqual(parseAiSupport({ channel: 0 }), []);
});

test('aiStateOf reads a firing detection in both shapes', () => {
  assert.equal(aiStateOf({ people: 1 }, 'people'), true);
  assert.equal(aiStateOf({ people: 0 }, 'people'), false);
  assert.equal(aiStateOf({ people: { alarm_state: 1, support: 1 } }, 'people'), true);
  assert.equal(aiStateOf({ people: { alarm_state: 0, support: 1 } }, 'people'), false);
  // An unsupported type never fires, whatever its alarm_state says.
  assert.equal(aiStateOf({ people: { alarm_state: 1, support: 0 } }, 'people'), false);
  assert.equal(aiStateOf(null, 'people'), false);
});

test('resolveCapabilities combines the abilities and the AI support', () => {
  const capabilities = resolveCapabilities({
    ability: { battery: { ver: 1 }, abilityChn: [{ floodLight: { ver: 1 } }] },
    aiState: { channel: 0, people: { support: 1 }, dog_cat: { support: 1 } },
    devInfo: { model: 'Reolink Argus 3 Pro' },
  });
  assert.ok(capabilities.includes(CAPABILITIES.BATTERY));
  assert.ok(capabilities.includes(CAPABILITIES.FLOODLIGHT));
  assert.ok(capabilities.includes(CAPABILITIES.AI_PEOPLE));
  assert.ok(capabilities.includes(CAPABILITIES.AI_ANIMAL));
  assert.ok(!capabilities.includes(CAPABILITIES.SIREN));
  assert.ok(!capabilities.includes(CAPABILITIES.DOORBELL));
});

test('resolveCapabilities recognizes a doorbell by its model name', () => {
  // The ability block carries no doorbell flag, and `GetAlarm`'s visitor item
  // only appears after a first press — too late to decide the features.
  const capabilities = resolveCapabilities({
    ability: {},
    aiState: null,
    devInfo: { model: 'Reolink Video Doorbell WiFi' },
  });
  assert.ok(capabilities.includes(CAPABILITIES.DOORBELL));
});

test('resolveCapabilities returns nothing for a bare wired camera', () => {
  const capabilities = resolveCapabilities({
    ability: {},
    aiState: null,
    devInfo: { model: 'RLC-410' },
  });
  assert.deepEqual(capabilities, []);
});

test('aiTypesOf maps a capability back to every name a firmware may use', () => {
  // The animal detection is named `dog_cat` on some firmwares and `animal` on
  // others; the poll has to read whichever the camera answers with.
  assert.deepEqual(aiTypesOf(CAPABILITIES.AI_ANIMAL).sort(), ['animal', 'dog_cat']);
  assert.deepEqual(aiTypesOf(CAPABILITIES.AI_PEOPLE), ['people']);
});
