// -----------------------------------------------------------------------------
// What a camera can actually do.
//
// Reolink covers a very wide range with one API: a wired RLC-810A, a battery
// Argus and a video doorbell all answer the same commands, but only some of them
// have a spotlight, a siren, a battery or PTZ presets. Building the same feature
// set for all of them would put controls on the dashboard that silently do
// nothing.
//
// Two sources are combined, because neither is sufficient on its own:
//   - `GetAbility` declares what the firmware supports, per user. It is
//     authoritative for the actuators (spotlight, siren, IR, PTZ);
//   - `GetAiState` is the only way to know which AI detections a camera really
//     runs: the ability block says nothing usable about people/vehicle/animal,
//     and recent firmwares answer with a per-type `support` flag.
// -----------------------------------------------------------------------------

import { CAPABILITIES, ABILITY_KEYS, DEFAULT_CHANNEL } from './constants.js';

/**
 * Read the `ver` of one ability entry, wherever the firmware put it.
 *
 * `GetAbility` nests its answer two ways: abilities shared by the device sit at
 * the root, per-channel ones under `abilityChn[<channel>]`. Both shapes carry
 * `{ ver, permit }`, and a `ver` above 0 means "supported".
 * @param {object|null} ability - The `Ability` block.
 * @param {string} key - The ability name.
 * @param {number} [channel] - The channel to look at.
 * @returns {number} The version, 0 when the ability is absent.
 * @example
 * abilityVersion(ability, 'floodLight'); // 1
 */
export function abilityVersion(ability, key, channel = DEFAULT_CHANNEL) {
  if (!ability || typeof ability !== 'object') {
    return 0;
  }
  const perChannel = ability.abilityChn?.[channel]?.[key];
  const shared = ability[key];
  const entry = perChannel ?? shared;
  const version = Number(entry?.ver);
  return Number.isFinite(version) ? version : 0;
}

/**
 * Tell whether a camera supports one of this integration's capabilities.
 * @param {object|null} ability - The `Ability` block.
 * @param {string} capability - One of `CAPABILITIES`.
 * @param {number} [channel] - The channel to look at.
 * @returns {boolean} True when at least one matching ability is declared.
 * @example
 * supportsCapability(ability, CAPABILITIES.SIREN);
 */
export function supportsCapability(ability, capability, channel = DEFAULT_CHANNEL) {
  const keys = ABILITY_KEYS[capability] || [];
  // Firmwares disagree on the spelling and only ever announce one of them, so
  // any match counts.
  return keys.some((key) => abilityVersion(ability, key, channel) > 0);
}

/**
 * Extract the AI detection types a camera actually runs, from `GetAiState`.
 *
 * Two firmware generations answer this command, and telling them apart matters:
 * before 3.0.0.494 each type is a plain `0`/`1`, which says the type EXISTS but
 * carries no support flag; after it, each type is `{ alarm_state, support }` and
 * a `support: 0` means the camera reports the type without being able to detect
 * it. Treating the second shape like the first would create dead features on
 * every camera that lists `face` without supporting it.
 * @param {object|null} aiState - The `GetAiState` value.
 * @returns {string[]} The supported types, e.g. `['people', 'vehicle']`.
 * @example
 * parseAiSupport({ channel: 0, people: { support: 1, alarm_state: 0 } }); // ['people']
 */
export function parseAiSupport(aiState) {
  if (!aiState || typeof aiState !== 'object') {
    return [];
  }
  return Object.entries(aiState)
    .filter(([key]) => key !== 'channel')
    .filter(([, value]) => {
      if (typeof value === 'number') {
        return true;
      }
      return Number(value?.support) === 1;
    })
    .map(([key]) => key);
}

/**
 * Read one AI detection state, whichever shape the firmware uses.
 * @param {object|null} aiState - The `GetAiState` value.
 * @param {string} type - The detection type, e.g. `people`.
 * @returns {boolean} True when that detection is currently firing.
 * @example
 * aiStateOf({ people: { alarm_state: 1, support: 1 } }, 'people'); // true
 */
export function aiStateOf(aiState, type) {
  const value = aiState?.[type];
  if (typeof value === 'number') {
    return value === 1;
  }
  return Number(value?.support) === 1 && Number(value?.alarm_state) === 1;
}

/**
 * The AI types this integration turns into features, mapped to the capability
 * they carry. Reolink also reports `face`, deliberately left out: it is
 * unreliable in the field and a face detection is not a home-automation trigger
 * anyone has asked for.
 */
const AI_TYPE_CAPABILITIES = {
  people: CAPABILITIES.AI_PEOPLE,
  vehicle: CAPABILITIES.AI_VEHICLE,
  // Firmwares name the animal detection either way, never both.
  dog_cat: CAPABILITIES.AI_ANIMAL,
  animal: CAPABILITIES.AI_ANIMAL,
};

/**
 * Resolve everything a camera can do, from the two probes.
 * @param {object} probes - What the camera answered.
 * @param {object|null} probes.ability - The `GetAbility` block.
 * @param {object|null} probes.aiState - The `GetAiState` value.
 * @param {object|null} probes.devInfo - The `GetDevInfo` block.
 * @param {number} [probes.channel] - The channel to look at.
 * @returns {string[]} The capabilities, as `CAPABILITIES` values.
 * @example
 * resolveCapabilities({ ability, aiState, devInfo });
 */
export function resolveCapabilities({ ability, aiState, devInfo, channel = DEFAULT_CHANNEL }) {
  /** @type {Set<string>} */
  const capabilities = new Set();

  for (const capability of [
    CAPABILITIES.BATTERY,
    CAPABILITIES.FLOODLIGHT,
    CAPABILITIES.SIREN,
    CAPABILITIES.IR_LIGHTS,
    CAPABILITIES.PTZ_PRESETS,
  ]) {
    if (supportsCapability(ability, capability, channel)) {
      capabilities.add(capability);
    }
  }

  for (const type of parseAiSupport(aiState)) {
    const capability = AI_TYPE_CAPABILITIES[type];
    if (capability) {
      capabilities.add(capability);
    }
  }

  // A doorbell is recognized by its model name: the ability block has no flag
  // for it, and `GetAlarm`'s `visitor` item only appears once a press has been
  // recorded — too late to decide which features to create.
  const model = String(devInfo?.model || '');
  if (/doorbell/i.test(model)) {
    capabilities.add(CAPABILITIES.DOORBELL);
  }

  return [...capabilities];
}

/**
 * Map an AI capability back to the detection types that feed it.
 *
 * The reverse of the table above: a feature is one capability, but the firmware
 * may name its type either `dog_cat` or `animal`, and the poll has to read
 * whichever the camera actually uses.
 * @param {string} capability - One of the AI capabilities.
 * @returns {string[]} The matching detection types.
 * @example
 * aiTypesOf(CAPABILITIES.AI_ANIMAL); // ['dog_cat', 'animal']
 */
export function aiTypesOf(capability) {
  return Object.entries(AI_TYPE_CAPABILITIES)
    .filter(([, value]) => value === capability)
    .map(([type]) => type);
}
