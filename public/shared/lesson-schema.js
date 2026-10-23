/**
 * shared/lesson-schema.js
 *
 * The declarative Lesson Skill schema: constants, validation, normalisation
 * and registration.
 *
 * Two rules drive this file (PART 47, PART 49 of the Lesson Skills prompt):
 *
 *   1. A malformed Skill must never crash the application. Validation always
 *      returns a report; it never throws.
 *   2. The shape is structured enough for a future graphical Lesson Editor to
 *      render forms from. Stable IDs everywhere, enumerated values where
 *      consistency matters, free text only where instructional creativity is
 *      useful.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

import { PHASE_MODES } from './script.js';

/** Bumped only when the shape changes incompatibly. */
export const SCHEMA_VERSION = 1;

/** Skill types the engine understands (PART 7). */
export const SKILL_TYPES = Object.freeze(['scenario', 'instructional', 'drill', 'review']);

/** Runtime input types a Skill may collect from the student (PART 8). */
export const RUNTIME_INPUT_TYPES = Object.freeze([
  'text', 'number', 'boolean', 'select', 'multiselect',
]);

/** How eagerly a Skill activates from a spoken request (PART 21). */
export const CONFIRMATION_BEHAVIORS = Object.freeze([
  'always_confirm', 'confirm_when_ambiguous', 'never_confirm',
]);

/** Required vs suggested vs optional content (PART 29). */
export const IMPORTANCE_LEVELS = Object.freeze(['required', 'suggested', 'optional']);

/** Where a runtime input's value came from (PART 9). */
export const INPUT_SOURCES = Object.freeze(['user', 'tutor', 'default']);

/** A slug usable as a directory name and a stable internal reference. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

// ---------------------------------------------------------------------------
// Small coercion helpers. Every one of these is total: any input yields a
// usable value, so a half-broken lesson still produces a readable report.
// ---------------------------------------------------------------------------

/** @param {unknown} value @returns {string} */
function str(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/** Multi-line free text: collapse runs of spaces but keep intentional breaks. */
function text(value) {
  if (typeof value !== 'string') return str(value);
  return value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** @param {unknown} value @returns {string[]} */
function strList(value) {
  if (typeof value === 'string') return value.trim() ? [text(value)] : [];
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const line = text(entry);
    if (line) out.push(line);
  }
  return out;
}

/** @param {unknown} value @param {boolean} fallback @returns {boolean} */
function bool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** @param {unknown} value @param {string[]} allowed @param {string} fallback */
function oneOf(value, allowed, fallback) {
  const candidate = str(value).toLowerCase();
  return allowed.includes(candidate) ? candidate : fallback;
}

/** @param {unknown} value @returns {Record<string, any>} */
function obj(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, any>} */ (value)
    : {};
}

/**
 * Turn arbitrary text into a stable id. Used only to repair entries that are
 * missing one; a Skill's own top-level id is never invented for it.
 * @param {string} source
 * @param {number} index
 * @param {string} prefix
 */
function deriveId(source, index, prefix) {
  const slug = str(source)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug && ID_PATTERN.test(slug) ? slug : `${prefix}_${index + 1}`;
}

/**
 * Collect ids, reporting duplicates and invalid ones.
 * @param {{id: string}[]} items
 * @param {string} label
 * @param {string[]} errors
 */
function assertUniqueIds(items, label, errors) {
  const seen = new Set();
  for (const item of items) {
    if (!ID_PATTERN.test(item.id)) {
      errors.push(`${label} id "${item.id}" is not a valid identifier (lowercase letters, digits and underscores).`);
      continue;
    }
    if (seen.has(item.id)) {
      errors.push(`Duplicate ${label} id "${item.id}".`);
      continue;
    }
    seen.add(item.id);
  }
  return seen;
}

// ---------------------------------------------------------------------------
// Section normalisers
// ---------------------------------------------------------------------------

/** @param {unknown} raw */
function normalizeActivation(raw) {
  const source = obj(raw);
  return {
    voice_triggers: strList(source.voice_triggers),
    voice_aliases: strList(source.voice_aliases),
    confirmation_behavior: oneOf(
      source.confirmation_behavior,
      CONFIRMATION_BEHAVIORS,
      'confirm_when_ambiguous',
    ),
  };
}

/** @param {unknown} raw */
function normalizeObjectives(raw, errors) {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push('"objectives" must be an array.');
    return [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const out = list.map((entry, index) => {
    const source = obj(entry);
    const description = text(source.description) || text(source.name);
    const weight = Number(source.weight);
    return {
      id: str(source.id) || deriveId(description, index, 'objective'),
      description,
      required: bool(source.required, true),
      weight: Number.isFinite(weight) && weight > 0 ? weight : 1,
      success_indicators: strList(source.success_indicators),
    };
  });
  for (const objective of out) {
    if (!objective.description) {
      errors.push(`Objective "${objective.id}" has no description.`);
    }
  }
  assertUniqueIds(out, 'objective', errors);
  return out;
}

/** @param {unknown} raw */
function normalizeRuntimeInputs(raw, errors) {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push('"runtime_inputs" must be an array.');
    return [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const out = list.map((entry, index) => {
    const source = obj(entry);
    const name = text(source.name);
    const declaredType = str(source.type).toLowerCase();
    const type = RUNTIME_INPUT_TYPES.includes(declaredType) ? declaredType : '';
    if (!type) {
      errors.push(
        `Runtime input ${index + 1} has invalid type "${str(source.type) || '(missing)'}". ` +
          `Expected one of: ${RUNTIME_INPUT_TYPES.join(', ')}.`,
      );
    }
    const options = strList(source.options);
    if ((type === 'select' || type === 'multiselect') && options.length === 0) {
      errors.push(`Runtime input "${str(source.id) || name}" is a ${type} but defines no options.`);
    }
    return {
      id: str(source.id) || deriveId(name, index, 'input'),
      name: name || str(source.id),
      type: type || 'text',
      required: bool(source.required, false),
      ask_user: bool(source.ask_user, true),
      prompt: text(source.prompt),
      allow_tutor_choice: bool(source.allow_tutor_choice, false),
      options,
      default: source.default === undefined ? null : source.default,
    };
  });
  assertUniqueIds(out, 'runtime input', errors);
  return out;
}

/** Activities and scenarios share a shape, so they share a normaliser. */
function normalizeActivityList(raw, prefix, label, errors) {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push(`"${label}" must be an array.`);
    return [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const out = list.map((entry, index) => {
    if (typeof entry === 'string') {
      return {
        id: deriveId(entry, index, prefix),
        name: text(entry),
        description: '',
        importance: 'suggested',
      };
    }
    const source = obj(entry);
    const name = text(source.name) || text(source.title);
    return {
      id: str(source.id) || deriveId(name, index, prefix),
      name,
      description: text(source.description),
      importance: oneOf(source.importance, IMPORTANCE_LEVELS, 'suggested'),
    };
  });
  assertUniqueIds(out, label.replace(/s$/, ''), errors);
  return out;
}

/** @param {unknown} raw */
function normalizeContent(raw, errors) {
  const source = obj(raw);
  return {
    suggested_vocabulary: strList(source.suggested_vocabulary),
    target_vocabulary: strList(source.target_vocabulary),
    target_grammar: strList(source.target_grammar),
    scenarios: normalizeActivityList(source.scenarios, 'scenario', 'scenarios', errors),
  };
}

/** @param {unknown} raw */
function normalizePhases(raw, errors) {
  if (raw !== undefined && !Array.isArray(raw)) {
    errors.push('"phases" must be an array.');
    return [];
  }
  const list = Array.isArray(raw) ? raw : [];
  const out = list.map((entry, index) => {
    const source = obj(entry);
    const name = text(source.name);
    return {
      id: str(source.id) || deriveId(name, index, 'phase'),
      name: name || str(source.id),
      purpose: text(source.purpose),
      instructions: strList(source.instructions),
      activities: normalizeActivityList(
        source.activities,
        'activity',
        `activities in phase ${index + 1}`,
        errors,
      ),
      entry_guidance: strList(source.entry_guidance),
      advancement_guidance: strList(source.advancement_guidance),
      completion_guidance: strList(source.completion_guidance),
      objectives: strList(source.objectives),
      reference: strList(source.reference),
      // How the part is run: taught from a script, played as a scene, reviewed
      // from memory, or simply talked through. An unknown value is "teach".
      mode: PHASE_MODES.includes(str(source.mode)) ? str(source.mode) : 'teach',
      // Close the part on a quick round — the English, the word back, the next.
      quick_round: source.quick_round === true,
      // How much of a role-play the part has: a whole exchange of several
      // lines ('full', the default), one question and its answer ('single'),
      // or none. A part of single words wants one or none.
      role_play: ['full', 'single', 'none'].includes(str(source.role_play)) ? str(source.role_play) : 'full',
    };
  });
  for (const phase of out) {
    if (!phase.name) errors.push(`Phase "${phase.id}" has no name.`);
  }
  assertUniqueIds(out, 'phase', errors);
  return out;
}

/** @param {unknown} raw */
function normalizeAdaptation(raw) {
  const source = obj(raw);
  return {
    if_struggling: strList(source.if_struggling),
    if_succeeding: strList(source.if_succeeding),
  };
}

/** @param {unknown} raw */
function normalizeProgress(raw) {
  const source = obj(raw);
  return {
    basis: strList(source.basis),
    notes: text(source.notes),
  };
}

/** @param {unknown} raw */
function normalizeCompletion(raw) {
  const source = obj(raw);
  const minimum = Number(source.min_required_objectives);
  return {
    criteria: strList(source.criteria),
    min_required_objectives: Number.isFinite(minimum) && minimum >= 0 ? Math.floor(minimum) : null,
    announcement_guidance: strList(source.announcement_guidance),
    allow_early_completion: bool(source.allow_early_completion, true),
  };
}

/** @param {unknown} raw */
function normalizeMemory(raw) {
  const source = obj(raw);
  return {
    observe: strList(source.observe),
    notes: text(source.notes),
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} ok
 * @property {Record<string, any>|null} lesson the normalised Skill, or null
 * @property {string[]} errors fatal problems — the Skill is not registered
 * @property {string[]} warnings non-fatal problems — the Skill still loads
 */

/**
 * Validate and normalise one lesson definition.
 *
 * Never throws. A Skill with any error is not registered, but the report says
 * exactly what is wrong so the UI can show it (PART 49).
 *
 * @param {unknown} raw parsed lesson.json
 * @param {{expectedId?: string, source?: string}} [context]
 * @returns {ValidationResult}
 */
export function validateLesson(raw, { expectedId = '', source = '' } = {}) {
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ok: false,
      lesson: null,
      errors: ['The lesson file does not contain a JSON object.'],
      warnings,
    };
  }

  const input = /** @type {Record<string, any>} */ (raw);

  // --- Schema version ------------------------------------------------------
  const declaredSchema = input.schema_version === undefined ? SCHEMA_VERSION : Number(input.schema_version);
  if (!Number.isFinite(declaredSchema)) {
    errors.push('"schema_version" must be a number.');
  } else if (declaredSchema > SCHEMA_VERSION) {
    errors.push(
      `This lesson declares schema_version ${declaredSchema}, but this build understands ${SCHEMA_VERSION}. Update the application.`,
    );
  }

  // --- Identity ------------------------------------------------------------
  const id = str(input.id);
  if (!id) {
    errors.push('Missing "id". Every Skill needs a stable unique id.');
  } else if (!ID_PATTERN.test(id)) {
    errors.push(`Invalid id "${id}". Use lowercase letters, digits and underscores, starting with a letter or digit.`);
  } else if (expectedId && id !== expectedId) {
    warnings.push(`The id "${id}" does not match its folder name "${expectedId}". The id wins.`);
  }

  const name = text(input.name);
  if (!name) errors.push('Missing "name". The Skill needs a human-readable name.');

  const declaredType = str(input.type).toLowerCase();
  if (!declaredType) {
    errors.push(`Missing "type". Expected one of: ${SKILL_TYPES.join(', ')}.`);
  } else if (!SKILL_TYPES.includes(declaredType)) {
    errors.push(`Invalid type "${declaredType}". Expected one of: ${SKILL_TYPES.join(', ')}.`);
  }

  // --- Sections ------------------------------------------------------------
  const objectives = normalizeObjectives(input.objectives, errors);
  const runtimeInputs = normalizeRuntimeInputs(input.runtime_inputs, errors);
  const phases = normalizePhases(input.phases, errors);
  const content = normalizeContent(input.content, errors);
  const completion = normalizeCompletion(input.completion);

  // --- Cross-references ----------------------------------------------------
  const objectiveIds = new Set(objectives.map((entry) => entry.id));
  for (const phase of phases) {
    for (const reference of phase.objectives) {
      if (!objectiveIds.has(reference)) {
        errors.push(`Phase "${phase.id}" references unknown objective "${reference}".`);
      }
    }
  }
  const requiredCount = objectives.filter((entry) => entry.required).length;
  if (
    completion.min_required_objectives !== null &&
    completion.min_required_objectives > requiredCount
  ) {
    errors.push(
      `completion.min_required_objectives is ${completion.min_required_objectives} but only ${requiredCount} required objective(s) exist.`,
    );
  }

  // --- Soft advice ---------------------------------------------------------
  if (objectives.length === 0) warnings.push('This Skill defines no objectives, so progress cannot be estimated.');
  if (phases.length === 0) warnings.push('This Skill defines no phases; the tutor will improvise structure.');

  const activation = normalizeActivation(input.activation);
  if (activation.voice_triggers.length === 0) {
    warnings.push('No voice_triggers defined, so this Skill can only be started from the UI.');
  }

  if (errors.length) {
    return { ok: false, lesson: null, errors, warnings };
  }

  const lesson = {
    schema_version: SCHEMA_VERSION,
    id,
    name,
    description: text(input.description),
    version: str(input.version) || '1.0',
    type: declaredType,
    source: str(source),
    activation,
    prerequisites: obj(input.prerequisites),
    runtime_inputs: runtimeInputs,
    objectives,
    teaching_philosophy: strList(input.teaching_philosophy),
    content,
    phases,
    // Which language reference sections this lesson needs — "numbers", "time".
    // The lesson names the KIND; Languages/<language>.json supplies the facts,
    // so the lesson itself stays language-agnostic (PART 40).
    reference: strList(input.reference),
    adaptation: normalizeAdaptation(input.adaptation),
    progress: normalizeProgress(input.progress),
    completion,
    memory: normalizeMemory(input.memory),
  };

  return { ok: true, lesson, errors, warnings };
}

/**
 * Build a registry from a set of candidate definitions.
 *
 * Invalid Skills are reported and skipped; valid ones remain available
 * (PART 49, PART 50). Duplicate ids are a fatal problem for the *second*
 * Skill only — the first one registered keeps the id.
 *
 * Which one is "first" is not left to directory order. A Skill living in the
 * folder its id names is considered before one that does not, so a stray copy
 * in a differently-named folder can never displace the real thing merely
 * because it sorts earlier in the alphabet.
 *
 * @param {{raw: unknown, expectedId?: string, source?: string}[]} candidates
 * @returns {{skills: Record<string, any>[], problems: {id: string, source: string, errors: string[]}[], warnings: {id: string, source: string, warnings: string[]}[]}}
 */
export function registerLessons(candidates) {
  /** @type {Record<string, any>[]} */
  const skills = [];
  /** @type {{id: string, source: string, errors: string[]}[]} */
  const problems = [];
  /** @type {{id: string, source: string, warnings: string[]}[]} */
  const warnings = [];
  /** @type {Map<string, string>} */
  const claimed = new Map();

  const list = Array.isArray(candidates) ? candidates : [];

  // Stable partition: folder-matches-id first, everything else after.
  const declaredId = (candidate) => {
    const raw = candidate?.raw;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? str(/** @type {any} */ (raw).id) : '';
  };
  const ordered = [
    ...list.filter((candidate) => declaredId(candidate) && declaredId(candidate) === str(candidate?.expectedId)),
    ...list.filter((candidate) => !declaredId(candidate) || declaredId(candidate) !== str(candidate?.expectedId)),
  ];

  for (const candidate of ordered) {
    const expectedId = str(candidate?.expectedId);
    const source = str(candidate?.source) || expectedId || '(unknown)';
    const result = validateLesson(candidate?.raw, { expectedId, source });

    if (!result.ok || !result.lesson) {
      problems.push({ id: expectedId, source, errors: result.errors });
      continue;
    }

    const existing = claimed.get(result.lesson.id);
    if (existing) {
      problems.push({
        id: result.lesson.id,
        source,
        errors: [`Duplicate Skill id "${result.lesson.id}" — already defined by ${existing}.`],
      });
      continue;
    }

    claimed.set(result.lesson.id, source);
    skills.push(result.lesson);
    if (result.warnings.length) {
      warnings.push({ id: result.lesson.id, source, warnings: result.warnings });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { skills, problems, warnings };
}

/**
 * The subset of a Skill the browser needs in order to list it. Kept small so
 * the selector can render before any lesson is activated.
 * @param {Record<string, any>} lesson
 */
export function lessonSummary(lesson) {
  return {
    id: lesson.id,
    name: lesson.name,
    description: lesson.description,
    type: lesson.type,
    version: lesson.version,
    objectives: lesson.objectives.length,
    phases: lesson.phases.length,
    asks_for_input: lesson.runtime_inputs.some((entry) => entry.ask_user),
  };
}
