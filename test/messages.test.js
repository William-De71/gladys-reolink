import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGES,
  CAMERA_NOTES,
  testOk,
  testFailed,
  presetList,
  refreshResult,
} from '../src/messages.js';

const LANGUAGES = ['en', 'fr', 'de', 'es'];

/**
 * Check that a message carries every language of Gladys, none of them empty.
 * @param {string} name - What is being checked, for the failure message.
 * @param {object} message - The multi-language message.
 */
function assertTranslated(name, message) {
  assert.deepEqual(Object.keys(message).sort(), [...LANGUAGES].sort(), `${name}: languages`);
  for (const language of LANGUAGES) {
    assert.ok(message[language].trim().length > 0, `${name}.${language} is empty`);
  }
}

test('every user-facing message exists in the four languages of Gladys', () => {
  for (const [name, message] of Object.entries({ ...MESSAGES, ...CAMERA_NOTES })) {
    assertTranslated(name, message);
  }
  assertTranslated('testOk', testOk(1, { en: 'a', fr: 'a', de: 'a', es: 'a' }));
  assertTranslated('testFailed', testFailed('REOLINK_TIMEOUT'));
  assertTranslated('refreshResult', refreshResult(1, []));
  assertTranslated('refreshResult', refreshResult(1, ['Garage']));
  assertTranslated('presetList', presetList([{ name: 'Gate', presets: [] }]));
});

test('the preset list names each preset with its number', () => {
  const message = presetList([
    { name: 'Gate', presets: [{ id: 2, name: 'Door' }] },
    { name: 'Yard', presets: null, error: 'REOLINK_TIMEOUT' },
  ]);
  assert.equal(message.en, 'Saved presets — Gate: 2 = Door | Yard: unreadable (REOLINK_TIMEOUT)');
  assert.match(message.de, /^Gespeicherte Positionen — Gate: 2 = Door/);
});
