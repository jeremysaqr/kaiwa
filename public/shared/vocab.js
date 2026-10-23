/**
 * shared/vocab.js
 *
 * Normalisation, de-duplication and merging for the two persistent memory
 * pools: `recent_vocab` and `known_weaknesses`.
 *
 * Two hard rules drive this file (PART 14, 15, 17 of the spec):
 *   1. `[object Object]` must NEVER reach the UI or a saved config.
 *   2. New vocabulary/weaknesses MERGE with the existing pool. They never
 *      replace it.
 *
 * Depends only on romaji.js: runs unchanged in Node and the browser.
 */

import { containsJapanese, toRomaji } from './romaji.js';

/**
 * Twenty was a call and a half: eleven colours pushed broccoli, beef and the
 * rest out of memory, and a drill of known words is made from this list. The
 * prompt and the transcriber take only the newest few; the planner sees all
 * of it, since all of it counts as known.
 */
export const MAX_VOCAB = 60;
export const MAX_WEAKNESSES = 25;

/**
 * Individual numerals are not vocabulary.
 *
 * A single numbers lesson produces twenty of them — "rokujuu ichi — sixty-one",
 * "sanbyaku — three hundred" — which fills the review pool exactly once and
 * evicts every real word the student had learned. Worse, the tutor then reads
 * them back as things to revise, so the next lesson drills the same numbers
 * again.
 *
 * A number is generated from a rule, not remembered as an item. What is worth
 * carrying between lessons is the RANGE the student has worked in, so numerals
 * collapse into one of these.
 */
const NUMBER_BANDS = Object.freeze([
  { limit: 20, label: 'numbers 1-20' },
  { limit: 99, label: 'numbers up to 100' },
  { limit: 999, label: 'numbers in the hundreds' },
  { limit: Infinity, label: 'numbers in the thousands' },
]);

/** Times collapse too: "sanji han — 3:30" is the clock, not a word. */
const TIME_LABEL = 'telling the time';

/** English number words, so a spelled-out gloss can be valued and banded. */
const NUMBER_WORDS = Object.freeze({
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
});

/** Words that scale what came before them. */
const NUMBER_SCALES = Object.freeze({ hundred: 100, thousand: 1000, million: 1000000 });

/** Ignored while reading a spelled-out number. */
const NUMBER_FILLER = new Set(['and', 'a']);

/** Object keys that plausibly hold the headword itself. */
const WORD_KEYS = [
  'word', 'term', 'vocab', 'vocabulary', 'expression', 'phrase',
  'text', 'target', 'target_word', 'japanese', 'kanji', 'german',
  'spanish', 'french', 'item', 'lemma', 'front',
];

/** Object keys that plausibly hold a pronunciation/reading. */
const READING_KEYS = [
  'romaji', 'reading', 'romanization', 'romanisation', 'kana', 'hiragana',
  'katakana', 'pronunciation', 'phonetic', 'ipa', 'transliteration',
];

/** Object keys that plausibly hold the meaning. */
const MEANING_KEYS = [
  'meaning', 'translation', 'english', 'definition', 'gloss', 'sense',
  'en', 'back',
];

/**
 * Collapse whitespace and trim. Non-strings become ''.
 * @param {unknown} value
 * @returns {string}
 */
function cleanString(value) {
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * Pull the first non-empty string value for any of `keys` from `obj`.
 * Key matching is case-insensitive.
 * @param {Record<string, unknown>} obj
 * @param {string[]} keys
 * @returns {string}
 */
function pick(obj, keys) {
  const lowered = new Map(
    Object.keys(obj).map((key) => [key.toLowerCase(), key]),
  );
  for (const candidate of keys) {
    const actual = lowered.get(candidate);
    if (actual === undefined) continue;
    const value = cleanString(obj[actual]);
    if (value) return value;
  }
  return '';
}

/**
 * Turn ANY value into a human-readable vocabulary string.
 *
 * Handles the two documented extractor shapes:
 *   "Zug (tsook)"
 *   { word: "電車", romaji: "densha", meaning: "train" }  ->  "電車 (densha) — train"
 *
 * plus arrays, nested objects, numbers, null and general garbage. The return
 * value is always a string and is '' when nothing useful could be recovered.
 *
 * @param {unknown} item
 * @returns {string}
 */
export function normalizeVocabItem(item) {
  if (item === null || item === undefined) return '';

  if (typeof item === 'string' || typeof item === 'number') {
    return cleanString(item);
  }

  if (Array.isArray(item)) {
    // e.g. ["電車", "densha", "train"]
    const parts = item.map((entry) => normalizeVocabItem(entry)).filter(Boolean);
    if (parts.length === 0) return '';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} — ${parts[1]}`;
    return `${parts[0]} (${parts[1]}) — ${parts.slice(2).join(', ')}`;
  }

  if (typeof item !== 'object') return '';

  const obj = /** @type {Record<string, unknown>} */ (item);

  const word = pick(obj, WORD_KEYS);
  const reading = pick(obj, READING_KEYS);
  const meaning = pick(obj, MEANING_KEYS);

  if (word || reading || meaning) {
    const head = word || reading;
    const showReading = reading && reading !== head;
    let out = head;
    if (showReading) out += ` (${reading})`;
    if (meaning && meaning !== head) out += `${out ? ' — ' : ''}${meaning}`;
    return cleanString(out);
  }

  // Unrecognised object shape: salvage every primitive value it holds rather
  // than ever letting String(obj) produce "[object Object]".
  const salvaged = Object.values(obj)
    .map((value) =>
      typeof value === 'object' && value !== null
        ? normalizeVocabItem(value)
        : cleanString(value),
    )
    .filter(Boolean);

  if (salvaged.length === 0) return '';
  if (salvaged.length === 1) return salvaged[0];
  return `${salvaged[0]} — ${salvaged.slice(1).join(', ')}`;
}

/**
 * The meaning half of an entry: what follows a dash, or sits in brackets.
 * "rokujuu ichi — sixty-one" -> "sixty-one";  "juu (10)" -> "10".
 * @param {string} text
 * @returns {string}
 */
function glossOf(text) {
  const dashed = text.split(/\s+[—–-]\s+/);
  if (dashed.length > 1) return dashed.slice(1).join(' ').trim();
  const bracketed = text.match(/\(([^)]*)\)\s*$/);
  if (bracketed) return bracketed[1].trim();
  return '';
}

/**
 * Read a spelled-out or digit number. Returns null when the text is not
 * purely a number, which is the common case and must stay vocabulary.
 * @param {string} text
 * @returns {number|null}
 */
function readNumber(text) {
  const clean = String(text || '').toLowerCase().replace(/[,]/g, ' ').trim();
  if (!clean) return null;

  // Plain digits: "61", "2035", "2 035".
  if (/^\d[\d\s]*$/.test(clean)) {
    const value = Number(clean.replace(/\s+/g, ''));
    return Number.isFinite(value) ? value : null;
  }

  const tokens = clean.split(/[\s-]+/).filter(Boolean);
  if (!tokens.length) return null;

  let total = 0;
  let current = 0;
  let sawNumber = false;

  for (const token of tokens) {
    if (NUMBER_FILLER.has(token)) continue;
    if (token in NUMBER_WORDS) {
      current += NUMBER_WORDS[token];
      sawNumber = true;
      continue;
    }
    if (token in NUMBER_SCALES) {
      const scale = NUMBER_SCALES[token];
      if (scale === 100) {
        current = (current || 1) * 100;
      } else {
        total += (current || 1) * scale;
        current = 0;
      }
      sawNumber = true;
      continue;
    }
    // Any real word means this is vocabulary, not a bare number.
    return null;
  }

  return sawNumber ? total + current : null;
}

/**
 * The category a vocabulary entry collapses into, or '' when it is a real word.
 * @param {string} text
 * @returns {string}
 */
export function vocabCategory(text) {
  const entry = cleanString(text);
  if (!entry) return '';

  const gloss = glossOf(entry);
  const subject = gloss || entry;

  // "3:30", "14:05" — the clock rather than a word.
  if (/^\d{1,2}\s*[:.]\s*\d{2}$/.test(subject.trim())) return TIME_LABEL;

  const value = readNumber(subject);
  if (value === null) return '';

  const band = NUMBER_BANDS.find((entry2) => Math.abs(value) <= entry2.limit);
  return band ? band.label : '';
}

/**
 * Key used for de-duplication: the headword, lowercased and stripped of
 * punctuation/spacing. "Zug (tsook)" and "Zug — train" collapse to "zug".
 * @param {string} text
 * @returns {string}
 */
export function vocabKey(text) {
  const head = text.split(/\s+[—–-]\s+|\s*\(/u)[0] || text;
  return head
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents
    .replace(/[^\p{L}\p{N}]/gu, '') // keep letters/numbers of any script
    .trim();
}

/**
 * Normalise a whole list, dropping empties and duplicates. Order preserved,
 * newest-wins for duplicates.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeVocabList(list) {
  if (!Array.isArray(list)) {
    // Tolerate a single item or a newline/comma separated blob.
    if (typeof list === 'string') {
      return normalizeVocabList(
        list.split(/\r?\n|,(?![^(]*\))/).map((part) => part.trim()),
      );
    }
    if (list && typeof list === 'object') return normalizeVocabList([list]);
    return [];
  }

  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const raw of list) {
    let text = normalizeVocabItem(raw);
    if (!text) continue;

    // Numerals and clock times become their range. Twenty of them collapse to
    // two or three entries, and the pool stays a vocabulary pool.
    const category = vocabCategory(text);
    if (category) text = category;

    const key = vocabKey(text) || text.toLowerCase();
    const existing = seen.get(key);
    // Prefer the richer rendition (more detail usually means longer).
    if (existing === undefined || text.length > existing.length) {
      seen.set(key, text);
    }
  }
  return [...seen.values()];
}

/**
 * Merge the existing persistent vocabulary pool with this session's new items.
 *
 * Existing + new -> normalize -> deduplicate -> cap at `max` most recent.
 * The existing pool is never discarded wholesale.
 *
 * @param {unknown} existing
 * @param {unknown} incoming
 * @param {number} [max=MAX_VOCAB]
 * @returns {string[]}
 */
export function mergeVocab(existing, incoming, max = MAX_VOCAB) {
  const oldList = normalizeVocabList(existing);
  const newList = normalizeVocabList(incoming);

  /** @type {Map<string, string>} */
  const merged = new Map();

  for (const text of oldList) {
    merged.set(vocabKey(text) || text.toLowerCase(), text);
  }

  for (const text of newList) {
    const key = vocabKey(text) || text.toLowerCase();
    const previous = merged.get(key);
    // Re-inserting moves the item to the end: recently practised = most recent.
    merged.delete(key);
    merged.set(key, previous && previous.length > text.length ? previous : text);
  }

  const all = [...merged.values()];
  return max > 0 && all.length > max ? all.slice(all.length - max) : all;
}

/**
 * Tidy a single weakness string: collapse whitespace, drop a trailing period,
 * capitalise the first letter.
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeWeakness(value) {
  let text = typeof value === 'string' ? cleanString(value) : normalizeVocabItem(value);
  if (!text) return '';
  text = text.replace(/\s*[.;]+$/u, '');
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Normalise a list of weaknesses, dropping empties and case-insensitive
 * duplicates.
 * @param {unknown} list
 * @returns {string[]}
 */
export function normalizeWeaknessList(list) {
  if (!Array.isArray(list)) {
    if (typeof list === 'string') {
      return normalizeWeaknessList(list.split(/\r?\n|,/));
    }
    if (list && typeof list === 'object') return normalizeWeaknessList([list]);
    return [];
  }
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const raw of list) {
    const text = normalizeWeakness(raw);
    if (!text) continue;
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (!seen.has(key)) seen.set(key, text);
  }
  return [...seen.values()];
}

/**
 * Merge existing weaknesses with newly observed ones.
 * Existing + new -> deduplicate -> cap at `max` most recent.
 *
 * @param {unknown} existing
 * @param {unknown} incoming
 * @param {number} [max=MAX_WEAKNESSES]
 * @returns {string[]}
 */
export function mergeWeaknesses(existing, incoming, max = MAX_WEAKNESSES) {
  const merged = normalizeWeaknessList([
    ...normalizeWeaknessList(existing),
    ...normalizeWeaknessList(incoming),
  ]);
  return max > 0 && merged.length > max ? merged.slice(merged.length - max) : merged;
}

/**
 * The saved vocabulary as things to ask for: "赤い (akai) — red" becomes
 * {say: "akai", script: "赤い", meaning: "red"}. A drill of the words a
 * student already has is made from these. Entries with no meaning, such as a
 * range of numbers, are left out: there is nothing to ask them by.
 *
 * @param {unknown} list
 * @returns {{say: string, script: string, meaning: string}[]}
 */
export function vocabItems(list) {
  const out = [];
  const seen = new Set();
  for (const entry of normalizeVocabList(list)) {
    let say = '';
    let script = '';
    let meaning = '';
    const written = /^(.+?)\s*\(([^()]+)\)\s*[—–-]\s*(.+)$/.exec(entry);
    const dashed = /^(.+?)\s+[—–-]\s+(.+)$/.exec(entry);
    const glossed = /^(.+?)\s*\(([^()]+)\)$/.exec(entry);
    if (written) [, script, say, meaning] = written;
    else if (dashed) [, say, meaning] = dashed;
    else if (glossed) [, say, meaning] = glossed;
    say = say.trim();
    meaning = meaning.trim();
    // Written only in the language's own script: the romaji is its reading.
    if (!script && containsJapanese(say)) {
      script = say;
      say = toRomaji(say);
      // Kanji have no reading without a dictionary; asked for by a guess, the answer would be wrong.
      if (/[?]|[^ -]/.test(say)) continue;
    }
    const key = say.toLowerCase();
    if (!say || !meaning || seen.has(key)) continue;
    seen.add(key);
    out.push({ say, script: script.trim(), meaning });
  }
  return out;
}
