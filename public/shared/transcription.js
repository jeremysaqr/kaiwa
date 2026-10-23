/**
 * shared/transcription.js
 *
 * The hint given to the speech-to-text model about what it is about to hear.
 *
 * Transcribing a beginner is the hardest case there is: the pronunciation is
 * approximate, the vocabulary is small and predictable, and a wrong guess is
 * worse than useless because the tutor then answers the guess. In one logged
 * session "rokujuu" came back as "블로그" — Korean — and the tutor cheerfully
 * confirmed it as correct.
 *
 * Predictability is the lever. We know the language, we know the student's
 * level, we know the lesson and often the exact words expected. Handing that to
 * the transcriber turns an open-ended guess into a near-multiple-choice.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** The hint is a bias, not a script; past this length it stops helping. */
const MAX_PROMPT_CHARS = 900;

/** How many remembered vocabulary items are worth naming. */
const MAX_VOCAB_HINTS = 12;

/**
 * Words that appear in the reference prose rather than being sounds a student
 * might say. Without this the hint tells the transcriber to expect "numbers".
 */
const ENGLISH_PROSE = new Set([
  'the', 'and', 'are', 'built', 'by', 'joining', 'words', 'with', 'nothing', 'between', 'them',
  'tens', 'two', 'digits', 'then', 'word', 'units', 'never', 'alone', 'exactly', 'round', 'number',
  'numbers', 'chain', 'not', 'put', 'first', 'irregular', 'is', 'was', 'say', 'said', 'says',
  'japanese', 'german', 'french', 'spanish', 'italian', 'korean', 'chinese',
  'digit', 'digits', 'joined', 'written', 'as', 'one', 'when', 'so', 'each', 'their', 'takes',
  'hours', 'minutes', 'half', 'past', 'goes', 'forward', 'next', 'hour', 'normal', 'clock',
  'thirty', 'twenty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred',
  'thousand', 'exactly', 'never', 'always',
  // "9 have second readings", "800 change sound".
  'have', 'has', 'change', 'changes', 'sound', 'sounds', 'becomes', 'become', 'uses', 'use', 'means', 'can', 'only',
]);

/** @param {unknown} value */
function clean(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/**
 * The headword of a vocabulary entry: "oishii — delicious" -> "oishii".
 * The transcriber needs the sound, not the gloss.
 * @param {string} entry
 */
function headword(entry) {
  const head = clean(entry).split(/\s+[—–-]\s+|\s*\(/)[0];
  return head.length > 40 ? '' : head;
}

/**
 * Build the transcription hint.
 *
 * @param {{profile?: Record<string, any>, skill?: Record<string, any>|null, reference?: Record<string, string>}} [context]
 * @returns {string}
 */
export function buildTranscriptionPrompt(context = {}) {
  // A default parameter only fills in `undefined`, so an explicit null — which
  // is what an empty profile looks like before one is loaded — sails past it.
  const source = context && typeof context === 'object' ? context : {};
  const profile = source.profile && typeof source.profile === 'object' ? source.profile : {};
  const skill = source.skill && typeof source.skill === 'object' ? source.skill : null;
  const reference = source.reference && typeof source.reference === 'object' ? source.reference : {};

  const language = clean(profile.target_language) || 'the target language';
  const level = clean(profile.proficiency_level) || 'Beginner';
  const romaji = clean(profile.script_style).toLowerCase() === 'romaji';

  const parts = [];

  const article = /^[aeiou]/i.test(level) ? 'An' : 'A';
  parts.push(
    `${article} ${level.toLowerCase()} student of ${language} speaking aloud in a lesson, with a ` +
      'strong English accent. They also ask questions in English. Transcribe what they actually say.',
  );

  if (romaji) {
    // The student has only ever seen romaji, so they are sounding words out
    // rather than reciting remembered ones.
    parts.push(
      `They read and study ${language} in romaji only, so their pronunciation follows the ` +
        'romaji spelling closely and may be approximate.',
    );
  }

  // Numbers are the single most common transcription failure, and the one the
  // reference data already describes. Pull the actual words out of it.
  // What the lesson is about to ask them to say, when it is known. Nothing is
  // a better guide to what the microphone is about to hear.
  // Each as it is normally written, as the student reads it, and what it
  // means: the transcriber writes Japanese in Japanese, the student may answer
  // with the English, and it is the three together that turn "Lorenzo" back
  // into "ほうれん草".
  const expected = (Array.isArray(source.expected) ? source.expected : [])
    .map((entry) => {
      if (typeof entry === 'string') return clean(entry);
      if (!entry || typeof entry !== 'object') return '';
      const say = clean(entry.say);
      const script = clean(entry.script);
      const meaning = clean(entry.meaning);
      if (!say) return '';
      const gloss = [script ? say : '', meaning.length <= 30 ? meaning : ''].filter(Boolean).join(', ');
      return `${script || say}${gloss ? ` (${gloss})` : ''}`;
    })
    .filter((entry) => entry && entry.length <= 80)
    .slice(0, 12);
  if (expected.length) parts.push(`They are about to practise: ${expected.join('; ')}.`);

  const numbers = clean(reference.numbers);
  if (numbers) {
    // The number words themselves: whatever follows a figure ("300 sanbyaku").
    // Taking every word in the section instead filled the hint with the
    // English prose around them as that prose grew.
    // Unicode-aware: an ASCII-only class turns "fünf" into "nf" and "zwölf"
    // into "zw" and "lf", which is worse than no hint at all.
    const words = [...new Set([...numbers.matchAll(/\d\s+([\p{L}]{2,})/gu)].map((match) => match[1]))]
      .filter((word) => !ENGLISH_PROSE.has(word.toLowerCase()))
      .slice(0, 40);
    if (words.length) parts.push(`Expect number words such as: ${words.join(', ')}.`);
  }

  // A lesson's target_vocabulary is deliberately written as English concepts —
  // "the tens", "the currency and its small unit" — so the tutor can render it
  // in whatever language it teaches. That is exactly the wrong thing to hand a
  // transcriber, which needs sounds. Skip it; the reference words and the
  // student's own vocabulary are the real signal.
  void skill;

  const recent = (Array.isArray(profile.recent_vocab) ? profile.recent_vocab : [])
    .map(headword)
    .filter(Boolean)
    .slice(-MAX_VOCAB_HINTS);
  if (recent.length) parts.push(`Words they have practised before: ${recent.join(', ')}.`);

  const prompt = parts.join(' ');
  return prompt.length > MAX_PROMPT_CHARS ? `${prompt.slice(0, MAX_PROMPT_CHARS)}` : prompt;
}
