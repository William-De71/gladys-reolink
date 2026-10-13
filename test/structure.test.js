// -----------------------------------------------------------------------------
// Non-regression of everything users store: the device and feature external
// ids, the fields the Discovery "Update" button compares (category, type,
// unit, min, max, step), the option values a scene sends (PTZ movements and
// preset numbers), the device params the live view and the commands read back,
// and every configuration and action key.
//
// test/fixtures/discovery.baseline.json was generated from version 1.3.0,
// before any change, with the cameras of test/helpers/samples.js. A failure
// here means existing users would have to delete and recreate a camera, or
// would lose a scene or a setting: never update the baseline without a
// documented migration. Features may be ADDED; none may change or disappear.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { buildDevice } from '../src/devices.js';
import { fakeGladys } from './helpers/fakeGladys.js';
import { SAMPLE_CAMERAS } from './helpers/samples.js';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const baseline = read('./fixtures/discovery.baseline.json');
const manifest = read('../gladys-assistant-integration.json');

const ETERNAL = [
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'step',
  'read_only',
  'has_feedback',
];

/**
 * The fields of a feature the baseline pins.
 * @param {object} feature - A built feature.
 * @returns {object} The eternal fields, plus the option values.
 */
function pick(feature) {
  const kept = Object.fromEntries(
    ETERNAL.filter((key) => feature[key] !== undefined).map((key) => [key, feature[key]]),
  );
  if (feature.supported_options) {
    kept.options = feature.supported_options.map((option) => option.value);
  }
  return kept;
}

const gladys = fakeGladys();

for (const [name, expected] of Object.entries(baseline.devices)) {
  test(`the ${name} camera keeps its ids, its params and every feature of ${baseline.generated_from}`, () => {
    const device = buildDevice(gladys, SAMPLE_CAMERAS[name]);
    assert.equal(device.external_id, expected.external_id);
    assert.equal(device.should_poll, expected.should_poll);
    assert.equal(device.poll_frequency, expected.poll_frequency);

    const params = device.params.map((param) => param.name);
    for (const param of expected.params) {
      assert.ok(params.includes(param), `param ${param}`);
    }

    const features = new Map(device.features.map((feature) => [feature.external_id, feature]));
    for (const stored of expected.features) {
      const now = features.get(stored.external_id);
      assert.ok(now, `feature ${stored.external_id} disappeared`);
      assert.deepEqual(pick(now), stored, stored.external_id);
    }
  });
}

test('every feature carries min, max, read_only and has_feedback', () => {
  for (const camera of Object.values(SAMPLE_CAMERAS)) {
    for (const feature of buildDevice(gladys, camera).features) {
      for (const field of ['min', 'max', 'read_only', 'has_feedback']) {
        assert.notEqual(feature[field], undefined, `${feature.external_id}.${field}`);
      }
    }
  }
});

test('no configuration key disappears, changes type or loses an option', () => {
  const current = new Map(manifest.config_schema.map((field) => [field.key, field]));
  for (const { key, type, options } of baseline.manifest.config_schema) {
    assert.equal(current.get(key)?.type, type, `config_schema.${key}`);
    const offered = (current.get(key)?.options ?? []).map((option) => option.value);
    for (const value of options ?? []) {
      assert.ok(offered.includes(value), `config_schema.${key}: ${value}`);
    }
  }
});

test('no configuration action disappears', () => {
  const current = (manifest.actions ?? []).map((action) => action.key);
  for (const key of baseline.manifest.actions) {
    assert.ok(current.includes(key), `actions.${key}`);
  }
});
