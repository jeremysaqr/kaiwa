/**
 * shared/script.js
 *
 * A part of a lesson, as a numbered script the tutor walks one step per turn.
 *
 * Why this exists. Four test students, sixty-six turns, one verdict: the voice
 * model delivers a line well and cannot design a lesson. Told to "introduce,
 * then use, then recall", it introduced — every turn, for the whole call — and
 * recalled once, with the answer attached. Asked to choose its own material it
 * taught "kono wa ramen resutoran desu", "oki" for okay and "platformu".
 *
 * So the designing is done here, in code, where it is deterministic:
 *
 *   - WHAT to teach comes from a plan (src/planner.js), written ahead of time
 *     by a text model with the language reference in front of it.
 *   - The ORDER — teach, teach, recall the first, teach, recall the second, …
 *     then a short role-play, then "here is what you can now say" — is built
 *     here, the same way every time.
 *   - WHERE the tutor has got to is worked out from what it actually said, so
 *     the prompt can tell it, and a part ends when its script does rather than
 *     when a second model happens to notice.
 *
 * The voice model is left with the one job it does well: saying the next line.
 *
 * And it is shown only that line. The first version of this handed it the
 * whole numbered script and a note saying "you have just asked step 6". Three
 * more students found what that does to a small model: it skipped the recall
 * steps — five of eight in one session — improvised a sentence of explanation
 * after each item ("o is a polite marker"), and in the role-play marked the
 * student wrong against an "expected answer" they had never been given ("that
 * is not the answer I'm looking for" — about their own age). So the app keeps
 * the place, and each turn the tutor is told two things: what it last asked,
 * and the one line to say next.
 *
 * A third round found where that still broke. The app "unstuck" a script that
 * had not moved by assuming the next line had been said, and from then on told
 * the tutor it had asked things it never asked; "menyuu o kudasai" was marked
 * wrong because the plan said "onegaishimasu"; and a correction was left to
 * the model to phrase. So the place now moves only on the tutor's own words,
 * a line that will not be said is taken out of the script rather than assumed,
 * equally good answers are listed, and every branch — right, wrong, a
 * question, "I know this" — is written out as the words to say.
 *
 * And a fourth found the limit of that. Shown four branches and a next line,
 * the small model said its line in full four times in twenty-five: it cut
 * "X means Y. Say it." down to "X", read "RIGHT NOW" aloud, and corrected
 * "menyuu o kudasai" three times running. Deciding and speaking in one breath
 * is the part it cannot do. So the app now decides, after the student has
 * spoken and before the tutor does (`turnFor`): a right answer, a different
 * word from the same set, a question, "I don't know" and "can we move on"
 * each get one exact line to say. Only an answer the app cannot place is left
 * to the tutor's ear — and then as a choice between two written-out turns.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** How a part of a lesson is run. */
export const PHASE_MODES = Object.freeze(['teach', 'roleplay', 'review', 'talk', 'drill']);

const MAX_ITEMS = 5;
const MAX_SCENE_LINES = 6;
const MAX_REVIEW_ITEMS = 10;

/** @param {unknown} value @param {number} max */
function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/** Comparison form: lowercase, no accents, no punctuation, single spaces. */
export function fold(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A looser comparison form, for matching what was heard against what was
 * wanted: long vowels collapsed ("menyu" is "menyuu"), "wo" read as "o".
 */
function loose(text) {
  return fold(text)
    .replace(/\bwo\b/g, 'o')
    .replace(/ou/g, 'o')
    .replace(/([aiueo])\1+/g, '$1');
}

/** Does `text` contain any of `keys`, as whole words or run together? */
function contains(text, keys) {
  const said = ` ${loose(text)} `;
  const tight = said.replace(/ /g, '');
  return keys.some((key) => {
    const want = loose(key);
    if (!want) return false;
    if (said.includes(` ${want} `)) return true;
    // "nana juu hachi" for "nanajuu hachi". Only for something long enough
    // not to turn up inside another word by accident — and only as whole
    // words of what was said: "shichiji" has "ichiji" in it, and is not it.
    const run = want.replace(/ /g, '');
    return run.length >= 6 && tight.includes(run) && runsTogether(said.trim(), run);
  });
}

/** Little words a recogniser runs into the word beside them. */
const GLUE_AFTER = ['', 'desu', 'o', 'wo', 'wa', 'ga', 'mo', 'to', 'ne', 'yo', 'da', 'kudasai', 'onegaishimasu', 'deshita', 'desuka', 'desune'];
const GLUE_BEFORE = ['', 'hai', 'to', 'e', 'ee', 'un', 'a', 'ano', 'eto'];

/**
 * Is `run` — letters with no spaces — made of whole words of `text`, give or
 * take a little word stuck on either end ("gyuunikudesu", "tonasu")?
 * @param {string} text in comparison form, single spaces
 * @param {string} run
 */
function runsTogether(text, run) {
  const words = String(text || '').split(' ').filter(Boolean);
  for (let from = 0; from < words.length; from += 1) {
    let joined = '';
    for (let to = from; to < words.length && joined.length < run.length + 16; to += 1) {
      joined += words[to];
      const at = joined.indexOf(run);
      if (at < 0) continue;
      if (GLUE_BEFORE.includes(joined.slice(0, at)) && GLUE_AFTER.includes(joined.slice(at + run.length))) return true;
    }
  }
  return false;
}

/** How much of `target` turns up in `text`: 0 to 1, by words of three letters or more. */
function overlap(text, target) {
  const said = new Set(loose(text).split(' '));
  const words = loose(target).split(' ').filter((word) => word.length >= 3);
  if (!words.length) return 0;
  return words.filter((word) => said.has(word)).length / words.length;
}

/** Words that take or drop a polite "o" with no change of meaning. */
const HONORIFIC = ['mizu', 'cha', 'hashi', 'sake', 'kaikei', 'kanjou', 'shibori', 'tearai', 'namae', 'nomimono', 'niku'];
/** Two readings of the same numeral. */
const READINGS = [['nana', 'shichi'], ['yon', 'shi'], ['kyuu', 'ku']];

/**
 * Every wording of an answer that is just as right as the one planned.
 *
 * "menyuu o kudasai" was marked wrong in a test session because the plan said
 * "menyuu o onegaishimasu", and "shichijuu hachi" because it said "nanajuu".
 * These are the differences a teacher would not even notice: either word for
 * please, a dropped particle, a polite "o", either reading of four, seven and
 * nine, a trailing "desu". The rules only fire on Japanese words, so they are
 * harmless for any other language.
 *
 * @param {string} say
 * @returns {string[]} folded forms, the planned one first
 */
export function variantKeys(say) {
  const start = fold(say);
  if (!start) return [];
  const out = new Set([start]);
  const grow = (fn) => {
    for (const key of [...out]) {
      const made = fn(key);
      for (const next of Array.isArray(made) ? made : [made]) {
        const tidy = String(next || '').replace(/\s+/g, ' ').trim();
        if (tidy) out.add(tidy);
      }
    }
  };
  grow((key) => [key.replace(/\bkudasai$/, 'onegaishimasu'), key.replace(/\bonegaishimasu$/, 'kudasai')]);
  grow((key) => key.replace(/ (?:o|wo|wa|ga) /g, ' '));
  grow((key) => key.replace(/ desu$/, ''));
  grow((key) => key.split(' ').map((word) => (word.startsWith('o') && HONORIFIC.includes(word.slice(1)) ? word.slice(1) : word)).join(' '));
  grow((key) => key.split(' ').map((word) => (HONORIFIC.includes(word) ? `o${word}` : word)).join(' '));
  // Either reading of four, seven and nine on its own; but in the tens only
  // seven has two ("nanajuu", "shichijuu") — "shijuu" and "kujuu" are not
  // what a visitor should be told is right.
  for (const [one, other] of READINGS) {
    grow((key) => [
      key.replace(new RegExp(`\\b${one}\\b`, 'g'), other),
      key.replace(new RegExp(`\\b${other}\\b`, 'g'), one),
    ]);
  }
  grow((key) => [key.replace(/\bnanajuu\b/g, 'shichijuu'), key.replace(/\bshichijuu\b/g, 'nanajuu')]);
  return [...out];
}

/**
 * The other wordings worth naming to the tutor, written as the student would
 * say them. A short list: the tutor reads it on every turn.
 * @param {string} say
 * @returns {string[]}
 */
export function alsoRight(say) {
  const text = String(say || '').trim().replace(/[.!?]+$/, '');
  if (!text) return [];
  const out = [];
  if (/\bkudasai$/i.test(text)) out.push(text.replace(/kudasai$/i, 'onegaishimasu'));
  else if (/\bonegaishimasu$/i.test(text)) out.push(text.replace(/onegaishimasu$/i, 'kudasai'));
  if (/\bnanajuu\b/i.test(text)) out.push(text.replace(/\bnanajuu\b/i, 'shichijuu'));
  else if (/\bshichijuu\b/i.test(text)) out.push(text.replace(/\bshichijuu\b/i, 'nanajuu'));
  for (const [one, other] of READINGS) {
    const first = new RegExp(`\\b${one}\\b`, 'i');
    const second = new RegExp(`\\b${other}\\b`, 'i');
    if (first.test(text)) out.push(text.replace(first, other));
    else if (second.test(text)) out.push(text.replace(second, one));
  }
  const seen = new Set([fold(text)]);
  return out.filter((entry) => {
    const key = fold(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 3);
}

/**
 * The one word that says "that was right" before going on. Not praise: a
 * student on a voice call who hears nothing at all cannot tell whether they
 * were understood.
 * @param {string} language
 */
export function ackFor(language) {
  const key = String(language || '').toLowerCase();
  if (key.startsWith('japanese')) return 'Hai.';
  if (key.startsWith('german')) return 'Ja.';
  return 'Yes.';
}

/**
 * Said once, straight after the word is first used, so that it is not a
 * mystery. (It used to be promised in the opening line — a sentence before
 * the first thing to say, about a word then heard once in twenty-six turns.)
 */
export function ackIntro(language) {
  const key = String(language || '').toLowerCase();
  if (key.startsWith('japanese')) return 'Hai — yes.';
  if (key.startsWith('german')) return 'Ja — yes.';
  return '';
}

/** Is the student asking something, rather than answering? */
export function looksLikeQuestion(text) {
  const said = String(text || '');
  if (
    /\b(what|why|how|who|when|where|which|did i|was (?:that|it)|is (?:that|it)|can (?:you|we|i)|could you|do (?:i|you)|does|explain|pardon|(?:say|repeat) (?:that|it|this)|come again|(?:once|one) more time)\b/i.test(said)
  ) return true;
  // "Again?" and "sorry?" ask for the line once more. "Ah, niku again, that
  // makes sense" does not — and was answered as if it had.
  return /\b(again|repeat|sorry|wait)\b/i.test(said) && said.trim().split(/\s+/).length <= 3;
}

/** Is the student asking to hear or do the same thing once more? */
export function asksRepeat(text) {
  const said = String(text || '').trim();
  if (!said || /\b(what does|what is|what's|why|mean|how do)\b/i.test(said)) return false;
  if (/\b(one more time|once more|(?:say|repeat|try|do|hear) (?:that|it|this)(?: one)? again|again,? please|repeat (?:that|it|please)|come again|pardon)\b/i.test(said)) return true;
  return /^\W*(again|sorry|what|repeat|huh|eh)\W*$/i.test(said);
}

/** Is the student asking to leave this material behind? */
export function wantsToMoveOn(text, told = '') {
  // What they quote back from the tutor's own line is not their request: "You
  // said or something else that fits and I gave you red. Why are you insisting
  // that I say specifically light blue?" was taken as "something else" — skip.
  if (told) text = withoutQuoted(text, told);
  // And a complaint about what the lesson is doing is answered, not acted on.
  if (/\b(?:why|you said|you told|insist(?:s|ed|ing)?|i gave you)\b/i.test(String(text || ''))) return false;
  // "I am not ready for the next part" has "next part" in it and means the
  // opposite: it took a student past the part they were asking to stay in.
  if (objectsToMoving(text) || /\b(not|never|no|don'?t|didn'?t|isn'?t|wasn'?t|can'?t)\b[^.?!]{0,40}\b(ready|next|move|moving|skip|go on|ahead)\b/i.test(String(text || ''))) return false;
  return /\b(move on|moving on|skip|too easy|go (?:straight|right|directly) to|jump (?:ahead|to)|something else|something (?:i|i'll|i will|we) (?:\w+ )?(?:actually )?use|next (?:part|topic|section|thing|one)|already (?:know|knew|did|done|learned|learnt|covered)|know (?:this|these|them|that|all of (?:this|these|them)) already|did a (?:whole )?lesson)\b/i.test(
    String(text || ''),
  );
}

/**
 * Is the student saying the lesson has gone somewhere they did not ask for, or
 * asking to go back? ("No, I did not want you to move on" was answered "Once
 * more: kaado de".)
 */
export function objectsToMoving(text) {
  return /\b(go(?:ing)? back|(?:take|bring) (?:me|us) back|back to (?:the|that|time|what)|did(?:n'?t| not) (?:want|ask|mean|say)|not what i|wrong (?:part|one|section)|(?:previous|last) (?:part|one|section)|return to|was(?:n'?t| not) (?:done|finished|ready)|you skipped|don'?t skip|do not skip|don'?t move|do not move|stay (?:on|here|with))\b/i.test(
    String(text || ''),
  );
}

/**
 * Asked "Ready for the next part?", is the student saying no?
 * @param {string} text
 */
export function declinesToGoOn(text) {
  const said = String(text || '');
  if (objectsToMoving(said)) return true;
  return /^\W*(no|nope|nah)\b|\b(not ready|not yet|not really|not quite|i(?:'m| am) not|again|once more|one more time|repeat|redo|more practice|practi[cs]e (?:that|this|it|more)|too fast|slow down|review (?:that|this|it))\b/i.test(said);
}

/** Is the student asking to do something in particular — "can we do paying"? */
export function asksForPart(text) {
  return /\b(can we|could we|let's|lets|i want|i'd (?:like|rather)|i would (?:like|rather)|get to|do the|move to|go to|(?:quiz|drill|test)(?:ing)? me|keep (?:drilling|quizzing|testing)|more drills)\b/i.test(String(text || ''));
}

/** Is the student asking for the words for something? */
export function asksHowToSay(text) {
  return /\bhow (?:do|would|can|should|could) (?:i|you|we|one) (?:\w+ )?(?:say|ask|tell|order|get)\b|\bhow to (?:say|ask)\b|\bwhat(?:'s| is) the word for\b/i.test(String(text || ''));
}

/**
 * The student's words, without any run of four or more that is also in the
 * tutor's line: what is quoted back is not what they are asking for.
 * @param {string} text @param {string} told
 */
export function withoutQuoted(text, told) {
  const words = fold(text).split(' ').filter(Boolean);
  const line = ` ${fold(told)} `;
  const keep = words.map(() => true);
  for (let from = 0; from < words.length; from += 1) {
    let to = from;
    while (to < words.length && line.includes(` ${words.slice(from, to + 1).join(' ')} `)) to += 1;
    if (to - from >= 4) for (let at = from; at < to; at += 1) keep[at] = false;
  }
  return words.filter((_, at) => keep[at]).join(' ');
}

/** Is the student saying they cannot answer? */
export function givesUp(text) {
  // "You are not supposed to tell me what it is" is the opposite of asking to
  // be told: it was answered "It's mizuiro. Say it."
  text = String(text || '').replace(/\b(?:not|never|don'?t|do not|didn'?t)\b(?:\s+[\w']+){0,5}?\s+tell me\b/gi, ' ');
  return /\b(?:(?:don'?t|do not|can'?t|cannot|couldn'?t) (?:know|remember|recall|think)|no idea|i forgot|i forget|not sure|tell me|give me (?:the answer|a hint)|what is it|what was it|what (?:do|should|am|would) i (?:say|answer|supposed to say|meant to say))\b/i.test(
    String(text || ''),
  );
}

/** Does a tutor turn ask the student for something? */
export function asksSomething(text) {
  return /\?|\b(say|repeat|try|answer|tell me)\b/i.test(String(text || ''));
}

/** Is a tutor turn nothing but "OK, moving on"? */
export function isBareOk(text) {
  return /^\W*(ok|okay)\b[\s\S]{0,24}$/i.test(String(text || '').trim()) && !/\?/.test(String(text || ''));
}

/**
 * Make a plan safe to teach from, whatever the model returned.
 *
 * @param {unknown} raw
 * @param {{transliterate?: (text: string) => string}} [options] a converter for
 *        scripts the student does not read (kana and kanji, for a romaji reader)
 * @returns {{items: {say: string, meaning: string, note: string, use: string, known: boolean}[], scene: {setup: string, lines: {tutor: string, meaning: string, expect: string, cue: string}[]}}}
 */
export function sanitizePlan(raw, { transliterate = (text) => text } = {}) {
  const source = raw && typeof raw === 'object' ? /** @type {Record<string, any>} */ (raw) : {};
  const target = (value, max) => clean(transliterate(String(value ?? '')), max);

  const seen = new Set();
  const items = [];
  for (const entry of Array.isArray(source.items) ? source.items : []) {
    if (!entry || typeof entry !== 'object') continue;
    const say = target(entry.say, 80);
    const meaning = clean(entry.meaning, 80);
    // An item with no meaning is the exact thing this whole design exists to
    // prevent: a phrase the student repeats without knowing what it says.
    if (!say || !meaning) continue;
    const key = fold(say);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    items.push({
      say,
      meaning,
      note: clean(entry.note, 80),
      use: clean(entry.use, 100),
      // How it is normally written, which is how a transcriber may write it.
      script: clean(entry.script, 80),
      // What the person they say it to says back, and what that means.
      reply: target(entry.reply, 80),
      replyMeaning: clean(entry.reply_meaning ?? entry.replyMeaning, 80),
      known: entry.known === true,
    });
    if (items.length >= MAX_ITEMS) break;
  }

  const sceneSource = source.scene && typeof source.scene === 'object' ? source.scene : {};
  const lines = [];
  for (const entry of Array.isArray(sceneSource.lines) ? sceneSource.lines : []) {
    if (!entry || typeof entry !== 'object') continue;
    const tutor = target(entry.tutor, 120);
    const meaning = clean(entry.meaning, 120);
    if (!tutor || !meaning) continue;
    lines.push({
      tutor,
      meaning,
      expect: target(entry.expect, 80),
      cue: clean(entry.cue, 80),
      // What the same person says back once they have been answered.
      reply: target(entry.reply, 80),
      replyMeaning: clean(entry.reply_meaning ?? entry.replyMeaning, 80),
    });
    if (lines.length >= MAX_SCENE_LINES) break;
  }

  return { items, scene: { setup: clean(sceneSource.setup, 160), lines } };
}

/**
 * A thing asked for, and the asking: "omizu o kudasai" is "omizu" in the frame
 * "kudasai". Only where the thing is plainly one thing — "omizu o futatsu
 * kudasai" and "kaado de onegaishimasu" are not built this way.
 * @param {string} say
 * @returns {{word: string, frame: string}|null}
 */
/**
 * Colours that are adjectives, by the noun a thing is asked for with. "akai
 * onegaishimasu" — red, please — is understood; said back, it is "aka desu
 * ne", so the right form is heard without the answer being called wrong.
 */
const COLOUR_NOUNS = Object.freeze({ akai: 'aka', aoi: 'ao', kuroi: 'kuro', shiroi: 'shiro', kiiroi: 'kiiro', chairoi: 'chairo' });

/** The word as it is said back in an order: the noun for a colour adjective. */
export function orderWord(word) {
  const text = String(word || '');
  return Object.prototype.hasOwnProperty.call(COLOUR_NOUNS, fold(text)) ? COLOUR_NOUNS[fold(text)] : text;
}

export function requestParts(say) {
  const text = String(say || '').trim().replace(/[.!?]+$/, '');
  const match = /^(\S+(?: \S+)?) (?:o|wo) (kudasai|onegaishimasu)$/i.exec(text) || /^(\S+) (kudasai|onegaishimasu)$/i.exec(text);
  if (!match) return null;
  if (/(?:^| )(?:de|ni|wa|ga|to|mo|nuki|o|wo)$/i.test(match[1])) return null;
  return { word: match[1], frame: match[2].toLowerCase() };
}

/** "water, please" is a request for "water". */
export function requestThing(meaning) {
  const match = /^(.*?)[,\s]+please[.!]?$/i.exec(String(meaning || '').trim());
  return match && match[1].trim() ? match[1].trim() : '';
}

/** A figure in a meaning — "it is 500 yen" — as what a listener should have caught. */
function figureIn(meaning) {
  const match = /\d[\d,.:]*(?:\s?(?:yen|o'clock|a\.?m\.?|p\.?m\.?))?/i.exec(String(meaning || ''));
  return match ? match[0].trim().replace(/[.,]$/, '') : '';
}

const UNITS = ['', 'ichi', 'ni', 'san', 'yon', 'go', 'roku', 'nana', 'hachi', 'kyuu'];
const HUNDREDS = ['', 'hyaku', 'nihyaku', 'sanbyaku', 'yonhyaku', 'gohyaku', 'roppyaku', 'nanahyaku', 'happyaku', 'kyuuhyaku'];
const THOUSANDS = ['', 'sen', 'nisen', 'sanzen', 'yonsen', 'gosen', 'rokusen', 'nanasen', 'hassen', 'kyuusen'];

/**
 * A whole number up to 99,999 in Japanese, as the reference writes numbers:
 * each part a word, the sound changes in place (sanbyaku, roppyaku, happyaku,
 * sanzen, hassen), yon, nana and kyuu for four, seven and nine.
 * @param {number} value
 * @returns {string} '' when it is not a number this can say
 */
export function japaneseNumber(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 1 || n > 99999) return '';
  const parts = [];
  const man = Math.floor(n / 10000);
  if (man) parts.push(`${UNITS[man]}man`);
  const thousands = Math.floor((n % 10000) / 1000);
  if (thousands) parts.push(THOUSANDS[thousands]);
  const hundreds = Math.floor((n % 1000) / 100);
  if (hundreds) parts.push(HUNDREDS[hundreds]);
  const tens = Math.floor((n % 100) / 10);
  if (tens) parts.push(tens === 1 ? 'juu' : `${UNITS[tens]}juu`);
  if (n % 10) parts.push(UNITS[n % 10]);
  return parts.join(' ');
}

/**
 * Prices that have not been said, made only from parts of prices that have:
 * with "nisen en" and "yonhyaku en" taught, "nisen yonhyaku en desu".
 * @param {{say: string, meaning: string}[]} items
 * @returns {{say: string, meaning: string}[]}
 */
export function freshPrices(items) {
  const figures = [];
  for (const item of Array.isArray(items) ? items : []) {
    const match = /^\s*([\d,]+)\s*yen\b/i.exec(String(item && item.meaning));
    if (match && /(?:^| )en$/.test(fold(item.say))) figures.push(Number(match[1].replace(/,/g, '')));
  }
  const thousands = [...new Set(figures.map((n) => Math.floor((n % 10000) / 1000)).filter(Boolean))];
  const hundreds = [...new Set(figures.map((n) => Math.floor((n % 1000) / 100)).filter(Boolean))];
  const rest = [...new Set(figures.map((n) => n % 100).filter(Boolean))];
  const made = [];
  for (const t of thousands) for (const h of hundreds) made.push(t * 1000 + h * 100);
  for (const h of hundreds) for (const r of rest) made.push(h * 100 + r);
  const seen = new Set(figures);
  const out = [];
  // The latest things taught first: they are the ones worth hearing again.
  for (const n of made.reverse()) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push({ say: `${japaneseNumber(n)} en desu`, meaning: `${n} yen` });
  }
  return out.slice(0, 6);
}

/** A note, without the parts of it that have been said already. */
function freshNote(note, said) {
  const clauses = String(note || '').replace(/[.!\s]+$/, '').split(/\s*[,;.]\s+/).filter(Boolean);
  // "De shows how you pay." and, two turns on, "De means by or with": the
  // word a clause explains is explained once, however it is put.
  const head = (clause) => {
    const match = /^(\S+) (?:is|means|shows|marks|makes)\b/i.exec(clause.trim());
    return match ? `head:${fold(match[1])}` : '';
  };
  const kept = clauses.filter((clause) => !said.has(fold(clause)) && !(head(clause) && said.has(head(clause))));
  for (const clause of clauses) {
    said.add(fold(clause));
    if (head(clause)) said.add(head(clause));
  }
  return kept.map((clause, index) => (index ? lowerFirst(clause) : clause)).join(', ');
}

/** Lower-case first letter, for a clause that now follows a comma. */
function lowerFirst(text) {
  const body = String(text || '');
  return /^[A-Z][a-z]/.test(body) ? `${body.charAt(0).toLowerCase()}${body.slice(1)}` : body;
}

/**
 * Turn a plan into the ordered steps of a part.
 *
 * The interleaving is the point: an item comes back one or two steps after it
 * was taught, while it is still warm but no longer on the tip of the tongue,
 * instead of being echoed and dropped. It comes back in two directions — the
 * English asked for in the language ("recall"), and the language asked for in
 * English ("recognise") — because a traveller has to understand what is said
 * to them as well as say things.
 *
 * @param {ReturnType<typeof sanitizePlan>|null} plan
 * @param {{mode?: string, taught?: {say: string, meaning: string}[], notes?: Set<string>}} [options]
 *        `notes` is every clause of a note already said on this call, so that
 *        "niku is meat" is said once and not once per meat
 * @returns {{kind: 'teach'|'recall'|'recognise'|'scene'|'wrap', say?: string, meaning?: string, note?: string, use?: string, tutor?: string, expect?: string, cue?: string, setup?: string, items?: string[], allKnown?: boolean}[]}
 */
export function buildScript(plan, {
  mode = 'teach', taught = [], notes = new Set(), round = false, scene: rolePlay = 'full',
  fumbled = new Map(), parked = new Set(), sure = new Set(), random = Math.random,
} = {}) {
  /** @type {any[]} */
  const steps = [];
  const earlier = Array.isArray(taught) ? taught : [];
  // How this call has gone so far, by folded phrase: how often each thing was
  // missed (`fumbled`), what was missed twice and is no longer asked for
  // (`parked`), and what they plainly have (`sure`).
  const missedTimes = (key) => (fumbled && typeof fumbled.get === 'function' ? fumbled.get(key) || 0 : 0);
  const isParked = (key) => Boolean(parked && typeof parked.has === 'function' && parked.has(key));
  const isSure = (key) => Boolean(sure && typeof sure.has === 'function' && sure.has(key));

  // A quick round: the English, the word back, the next one. "If I'm going to
  // do repetition I would prefer it's quick. I don't need two full sentences
  // as a prompt each time, and my response doesn't need to be a full sentence
  // each time." — tutor: What is cabbage? — kyabetsu. — What is carrot? — ninjin.
  /** The short thing to ask for: the word in a request, or the item itself. */
  const shortOf = (item) => {
    const parts = requestParts(item.say);
    const thing = parts ? requestThing(item.meaning) : '';
    return parts && thing ? { say: parts.word, meaning: thing, script: '' } : { say: item.say, meaning: item.meaning, script: item.script || '' };
  };
  const quickRound = (list, most) => {
    const seen = new Set();
    const out = [];
    // A word taught as itself is asked for by its own meaning ("carrot"),
    // rather than by the one it has inside a request ("a carrot").
    const own = new Set(list.filter((item) => !requestParts(item.say)).map((item) => fold(item.say)));
    for (const item of list) {
      const short = shortOf(item);
      const key = fold(short.say);
      if (requestParts(item.say) && own.has(key)) continue;
      if (!key || seen.has(key) || key.split(' ').length > 2) continue;
      seen.add(key);
      out.push({ kind: 'recall', say: short.say, meaning: short.meaning, script: short.script, quick: true });
      if (out.length >= most) break;
    }
    if (out.length) out[0].first = true;
    return out;
  };

  // A drill of words they already have: the English, the word back, the next
  // one, and nothing taught. "Drill me on the basic colors. Give me one word
  // prompts for the basic colors in English, and I will give you the Japanese
  // word" was asked for three times in one call, and answered with lessons.
  if (mode === 'drill') {
    const list = [];
    const keys = new Set();
    for (const item of plan && Array.isArray(plan.items) ? plan.items : []) {
      const key = fold(item && item.say);
      if (!key || keys.has(key) || !item.meaning) continue;
      keys.add(key);
      list.push({ item, missed: missedTimes(key), order: random() });
    }
    // Every one once, in no fixed order; on another round, the most missed first.
    list.sort((a, b) => b.missed - a.missed || a.order - b.order);
    for (const { item } of list) {
      steps.push({ kind: 'recall', say: item.say, meaning: item.meaning, script: item.script || '', quick: true });
    }
    if (steps.length) {
      steps[0].first = true;
      steps.push({ kind: 'wrap', items: list.map(({ item }) => item.meaning), drill: true });
    }
    return steps;
  }

  if (mode === 'review') {
    // What was missed most is in the review first of all, and then the most
    // recent: the last eight things taught left out the one word a student
    // had missed five times.
    const missedOf = (item) => missedTimes(fold(item.say)) + (fold(shortOf(item).say) === fold(item.say) ? 0 : missedTimes(fold(shortOf(item).say)));
    // (A word and the request made with it are one thing to review, not two:
    // counted separately, eleven things taught left room for seven words.)
    const units = new Map();
    earlier.forEach((item, index) => {
      const key = fold(shortOf(item).say);
      const had = units.get(key);
      if (!had) units.set(key, { item, index, missed: missedOf(item) });
      else {
        had.missed = Math.max(had.missed, missedOf(item));
        // The plain word is what is asked for.
        if (requestParts(had.item.say) && !requestParts(item.say)) had.item = item;
      }
    });
    const chosen = [...units.values()]
      .sort((a, b) => b.missed - a.missed || b.index - a.index)
      .slice(0, MAX_REVIEW_ITEMS)
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.item);
    // Something missed twice is not tested a third time. It is said once
    // more, for them to hear and say, and that is all that is asked of it.
    const again = [];
    const againKeys = new Set();
    for (const item of chosen) {
      const short = shortOf(item);
      const key = fold(short.say);
      if (!(isParked(key) || isParked(fold(item.say))) || againKeys.has(key)) continue;
      againKeys.add(key);
      again.push({ kind: 'teach', say: short.say, meaning: short.meaning, script: short.script, note: '', free: true });
    }
    const recent = chosen.filter((item) => !againKeys.has(fold(shortOf(item).say)));
    // Everything short goes round quickly; what is longer is asked for as before.
    const quick = quickRound(recent, MAX_REVIEW_ITEMS);
    const covered = new Set(quick.map((step) => fold(step.say)));
    steps.push(...again);
    recent.filter((item) => !covered.has(fold(shortOf(item).say))).forEach((item, index) => {
      steps.push({ kind: index % 3 === 2 ? 'recognise' : 'recall', say: item.say, meaning: item.meaning });
    });
    steps.push(...quick);
    if (steps.length) steps.push({ kind: 'wrap', items: chosen.map((item) => item.meaning), review: true });
    return steps;
  }

  const items = plan && Array.isArray(plan.items) ? plan.items : [];
  const written = plan && plan.scene && Array.isArray(plan.scene.lines) ? plan.scene.lines : [];
  // A part of single words gets one exchange, or none: the open question a
  // person would ask, answered with any of the words. Three lines written
  // around a handful of nouns were "Anything else?" as an opening, "Which
  // would you like?" with nothing offered, and "Would you like any
  // vegetables?" — "hai" — and then nothing.
  const narrow = (line) => !/\?\s*$/.test(String(line.meaning || '').trim()) ||
    /^(is|are|do|does|did|would|will|can|could|shall|may|anything|any|which)\b/i.test(String(line.meaning || '').trim()) ||
    /\b(?:anything|something|what) else\b|\bwhich\b/i.test(String(line.meaning || ''));
  const lines = rolePlay === 'none' ? [] : rolePlay === 'single' ? written.filter((line) => !narrow(line)).slice(0, 1) : written;
  const setup = plan && plan.scene ? plan.scene.setup || '' : '';

  // What each role-play answer means, so the student can be told what to say
  // rather than left to guess which of several right answers is wanted.
  const meaningOf = new Map();
  const scriptOf = new Map();
  for (const item of [...earlier, ...items]) {
    meaningOf.set(fold(item.say), item.meaning);
    scriptOf.set(fold(item.say), item.script || '');
  }
  /** Something said to them that is a price or a time: asked about, not translated. */
  const heard = (say, figure, extra = {}) => ({ kind: 'recognise', say, meaning: figure, listen: true, wordOnly: true, ...extra });

  // Prices nobody has said yet, made from the parts of the ones that have
  // been taught: what a shop actually demands is catching a figure that was
  // never memorised. (A student heard "nisen en desu" three times running,
  // the first of them from their own mouth.)
  const fresh = freshPrices([...earlier, ...items]);
  const priceFor = (say, figure) => (/yen/i.test(figure) && fresh.length ? fresh.shift() : { say, meaning: figure });

  // The role-play is put together first: what it will ask for is what the
  // steps before it need not ask for again.
  /** @type {any[]} */
  const scene = [];
  const taughtFigures = new Set(items.map((item) => String(item.meaning).replace(/[^\d]/g, '')).filter(Boolean));
  for (const line of lines) {
    const cue = line.cue || meaningOf.get(fold(line.expect)) || '';
    // A line with nothing the student has been taught to answer it with is
    // not a role-play, it is a trap.
    if (!line.expect || !cue) continue;
    // And a line that already contains its own answer ("this is your number:
    // nanajuu hachi" — answer: 78) is an echo, not a question.
    if (contains(line.tutor, variantKeys(line.expect))) continue;
    const answered = Boolean(line.reply && line.replyMeaning);
    const figure = answered ? figureIn(line.replyMeaning) : '';
    // A line that states a price ("sen nihyaku en desu") is first something to
    // catch — "How much is that?" — and then something to answer.
    let stated = /\?\s*$/.test(String(line.meaning).trim()) ? '' : figureIn(line.meaning);
    let tutor = line.tutor;
    let meaning = line.meaning;
    // (And not a price they have just been taught to say: a new one.)
    if (stated && /yen/i.test(stated) && taughtFigures.has(stated.replace(/[^\d]/g, '')) && fresh.length) {
      const other = fresh.shift();
      tutor = other.say;
      stated = other.meaning;
      meaning = `it is ${other.meaning}`;
    }
    const first = scene.length === 0;
    if (stated) scene.push(heard(tutor, stated, { opens: first, setup: first ? setup : '', stated: true }));
    scene.push({
      kind: 'scene',
      tutor,
      meaning,
      expect: line.expect,
      script: scriptOf.get(fold(line.expect)) || '',
      cue,
      reply: answered && !figure ? line.reply : '',
      replyMeaning: answered && !figure ? line.replyMeaning : '',
      scene: setup,
      opens: first && !stated,
      setup: first && !stated ? setup : '',
      ...(rolePlay === 'single' ? { single: true } : {}),
      ...(stated ? { heard: true } : {}),
      ...(figure ? { check: true } : {}),
    });
    if (figure) {
      const price = priceFor(line.reply, figure);
      scene.push(heard(price.say, price.meaning));
    }
  }
  if (mode !== 'roleplay' && rolePlay === 'full') {
    // One line is not a role-play, and a planner's lines do not always
    // survive. So the scene is filled out with the moments the part's own
    // phrases are for: the student speaks first, and the other person
    // answers. ("Arriving" has one thing a waiter asks. The rest of that
    // scene is the customer calling them over and asking for the menu.)
    const exchanges = () => scene.filter((step) => step.kind === 'scene');
    const wanted = new Set(exchanges().map((step) => fold(step.expect)));
    const moment = (item, first, extra = {}) => ({
      kind: 'scene',
      tutor: '',
      meaning: '',
      moment: item.use,
      expect: item.say,
      script: item.script || '',
      cue: item.meaning,
      reply: '',
      replyMeaning: '',
      scene: setup,
      opens: first,
      setup: first ? setup : '',
      ...extra,
    });
    const usable = (item) => Boolean(item.use && item.reply && item.replyMeaning) && !wanted.has(fold(item.say));
    // A price is asked for before it is given. Where the planner's line has a
    // shop assistant state one, and one of the part's phrases is the asking
    // of it, the asking comes first and the planner's price is its answer.
    // (Otherwise the scene ran backwards: they were told a price, bought the
    // thing, and then asked what it cost.)
    const quoted = scene.findIndex((step) => step.stated);
    const asking = items.find((item) => usable(item) && /yen/i.test(figureIn(item.replyMeaning)));
    if (quoted >= 0 && asking) {
      const opened = scene[quoted].opens;
      scene[quoted] = { ...scene[quoted], opens: false, setup: '' };
      scene.splice(quoted, 0, moment(asking, opened, { check: true }));
      wanted.add(fold(asking.say));
    }
    // (Two lines the planner wrote are a role-play already, and are left as
    // they are.)
    const enough = exchanges().length >= 2 ? 0 : 3;
    for (const item of items) {
      if (exchanges().length >= enough) break;
      if (!usable(item)) continue;
      const figure = figureIn(item.replyMeaning);
      const first = scene.length === 0;
      if (!figure) {
        scene.push(moment(item, first, { reply: item.reply, replyMeaning: item.replyMeaning }));
      } else {
        const price = priceFor(item.reply, figure);
        scene.push(moment(item, first, { check: true }));
        scene.push(heard(price.say, price.meaning));
      }
      wanted.add(fold(item.say));
    }
    // A single moment on its own is the step before it, said twice.
    if (exchanges().length === 1 && exchanges()[0].moment) scene.length = 0;
  }
  // What the role-play asks for as a moment is asked for, before it, from its
  // English: the same prompt word for word, twice in five turns, with the
  // same reply, was the drill again.
  const asMoment = new Set(scene.filter((step) => step.kind === 'scene' && step.moment).map((step) => fold(step.expect)));
  const inScene = new Set(scene.filter((step) => step.kind === 'scene').map((step) => fold(step.expect)));

  if (mode !== 'roleplay') {
    /** Asking for an item from its English, or from the moment it is used in. */
    const recallOf = (item) => {
      const plain = asMoment.has(fold(item.say));
      const answered = !plain && Boolean(item.use && item.reply && item.replyMeaning);
      const recall = {
        kind: 'recall',
        say: item.say,
        meaning: item.meaning,
        use: plain ? '' : item.use || '',
        script: item.script || '',
        // Said in a situation, the phrase gets an answer: what the other person
        // says back. That is the difference between using it and reciting it.
        reply: answered ? item.reply : '',
        replyMeaning: answered ? item.replyMeaning : '',
        known: item.known === true,
      };
      // When what comes back is a price or a time, it is not translated for
      // them: they are asked what it was. Every reply came with its English,
      // so nothing ever had to be understood by ear — and a price heard in a
      // shop has no subtitle.
      const figure = answered ? figureIn(item.replyMeaning) : '';
      if (!figure) return [recall];
      const price = priceFor(item.reply, figure);
      return [{ ...recall, reply: '', replyMeaning: '', check: true }, heard(price.say, price.meaning)];
    };
    /** Asking what an item means — or, for a price, what price was just said. */
    const recogniseOf = (item, build) => {
      if (build) return { kind: 'recognise', say: build.word, meaning: build.thing, wordOnly: true };
      if (/^\d/.test(String(item.meaning).trim())) {
        const said = /(?:^| )en$/.test(fold(item.say)) ? `${item.say} desu` : item.say;
        return heard(said, item.meaning);
      }
      return { kind: 'recognise', say: item.say, meaning: item.meaning };
    };
    // A request is taught whole once. After that the student is given the
    // word and makes the request themselves: "omizu means water. Ask for
    // water." Three sentences handed over whole and parroted back were three
    // cards. The first time in a part, they are pointed at a request they
    // have already made: "Ask for water, the way you asked for a beer."
    const asked = new Map();
    for (const item of earlier) {
      const parts = requestParts(item.say);
      if (parts) asked.set(parts.frame, { thing: requestThing(item.meaning), say: item.say, meaning: item.meaning });
    }
    const built = new Map();
    for (const item of items) {
      const parts = requestParts(item.say);
      if (!parts) continue;
      const thing = requestThing(item.meaning);
      const model = asked.get(parts.frame);
      if (thing && model && !item.known) {
        built.set(item, { word: parts.word, thing, like: built.size ? '' : model.thing || '', model: { say: model.say, meaning: model.meaning } });
      }
      asked.set(parts.frame, { thing, say: item.say, meaning: item.meaning });
    }
    // The part closes on a quick round where it is asked to and has enough
    // short things for one: this part's, with a few from earlier mixed in.
    const mine = quickRound(items, 6);
    // From earlier parts: what was missed, most-missed first, and then the
    // most recent — not what has been got right twice already ("pork" was
    // asked for eight times in one lesson), and not what was let go.
    const pool = [...earlier].reverse()
      .filter((item) => !items.some((own) => fold(own.say) === fold(item.say)))
      .filter((item) => !isParked(fold(shortOf(item).say)) && !isSure(fold(shortOf(item).say)))
      .map((item, index) => ({ item, index, missed: missedTimes(fold(shortOf(item).say)) }))
      .sort((a, b) => b.missed - a.missed || a.index - b.index)
      .map((entry) => entry.item);
    const before = quickRound(pool, 3)
      .filter((step) => !mine.some((own) => fold(own.say) === fold(step.say)))
      .slice(0, Math.max(0, 6 - mine.length));
    /** @type {any[]} */
    const mixed = [];
    for (let index = 0; index < Math.max(mine.length, before.length); index += 1) {
      if (mine[index]) mixed.push(mine[index]);
      if (before[index]) mixed.push(before[index]);
    }
    const closing = round && mixed.length >= 3 ? mixed.slice(0, 6).map((step, index) => ({ ...step, first: index === 0 })) : [];
    // Up to two things from earlier parts come back in this one: early, and
    // again near the end. Which things is decided as the part opens (see
    // LessonRuntime.applyCarry) — what was missed, not whatever came first.
    const carry = earlier.length > 0 && items.length > 1;
    const placeholder = () => ({ ...recallOf(earlier[earlier.length - 1])[0], check: false, carried: true });
    // A request made from a word this lesson has already taught, in a frame
    // it has already taught, has nothing new in it: it is asked for. ("Next:
    // using them. butaniku means pork: niku means meat" — to a student who
    // had said butaniku six times.)
    const taughtWords = new Set(earlier.map((item) => fold(item.say)));
    const settled = (item) => item.known === true || Boolean(built.get(item) && taughtWords.has(fold(built.get(item).word)));
    items.forEach((item, index) => {
      if (index === 1 && carry && !closing.length) steps.push(placeholder());
      // Something they already know is asked for, never taught again — and
      // asked for here, in its own place, so that a part does not open on
      // something carried over from another ("Next: larger numbers. How do
      // you say I'll take this?").
      if (settled(item)) steps.push(...recallOf(item));
      else {
        const build = built.get(item);
        let note = freshNote(item.note, notes);
        // A note that only says what the word is ("Kore means this one") has
        // just been said by the line itself.
        if (build && fold(note).includes(fold(build.thing))) note = '';
        steps.push({
          kind: 'teach', say: item.say, meaning: item.meaning, note, script: item.script || '',
          // Not used by the line itself: kept so that the item can come back
          // in a later part with its moment and its reply.
          use: item.use || '', reply: item.reply || '', replyMeaning: item.replyMeaning || '',
          ...(build ? { build: true, word: build.word, thing: build.thing, like: build.like, model: build.model } : {}),
        });
      }
      if (index >= 1 && !settled(items[index - 1])) {
        const before = items[index - 1];
        // Alternate the direction the earlier item comes back in. (A built
        // request comes back as its word: that is the new thing in it.)
        if (index % 2 === 0) steps.push(recogniseOf(before, built.get(before)));
        else steps.push(...recallOf(before));
      }
    });
    if (items.length) {
      // (With a quick round coming, nothing is asked for twice on the way to it.)
      if (carry && earlier.length > 1 && items.length > 2 && !closing.length) steps.push(placeholder());
      const last = items[items.length - 1];
      // The last item is asked for once more — unless the role-play is about
      // to ask for it, which is the better place.
      if (!settled(last) && !inScene.has(fold(last.say)) && !closing.length) steps.push(...recallOf(last));
    }
    scene.push(...closing);
  }

  steps.push(...scene);

  if (steps.length) {
    const learned = items.length ? items : earlier.slice(-MAX_REVIEW_ITEMS);
    steps.push({
      kind: 'wrap',
      items: learned.map((item) => item.meaning),
      // Nothing here was new to them: do not announce it as an achievement.
      allKnown: items.length > 0 && items.every((item) => item.known),
    });
  }
  return steps;
}

/** "a", "a and b", "a, b and c". */
function listOf(parts) {
  const list = parts.filter(Boolean);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/** Drop closing punctuation, so the line can supply its own. */
const bare = (text) => String(text || '').replace(/[.!?\s]+$/, '');
/** In quotation marks, keeping a question mark and nothing else at the end. */
const quoted = (text) => `"${String(text || '').replace(/[.\s]+$/, '')}"`;
/** A capital the planner put on a meaning ("Excuse me") reads oddly mid-sentence. */
const lower = (text) => {
  const body = String(text || '');
  return /^[A-Z][a-z]/.test(body) && !/^I\b/.test(body) ? `${body.charAt(0).toLowerCase()}${body.slice(1)}` : body;
};
/** As a sentence of its own: capital first, full stop last. */
const sentence = (text) => {
  const body = bare(text);
  return body ? `${body.charAt(0).toUpperCase()}${body.slice(1)}.` : '';
};

/**
 * The line the tutor says for a step — written out, not described.
 *
 * A small model told to "teach X" adds a sentence of its own about X, and that
 * sentence is where every false statement in the test sessions came from. Told
 * to say a given line, it says the line.
 *
 * @param {ReturnType<typeof buildScript>[number]} step
 * @param {string} language
 * @param {{again?: boolean, hint?: boolean}} [options] `again` gives the short
 *        form used to repeat a question after an interruption; `hint`, for a
 *        role-play line, the form that says what to answer
 * @returns {string}
 */
export function lineFor(step, language = 'the language', { again = false, hint = false } = {}) {
  if (!step) return '';
  switch (step.kind) {
    case 'teach': {
      if (step.build) {
        // The word, and then the request left to them. The note sits with the
        // word it is about; "Ask for pork" cannot be taken for anything else.
        const note = step.note && !again ? `: ${lower(bare(step.note))}` : '';
        const way = step.like && !again ? `, the way you asked for ${lower(bare(step.like))}` : '';
        // ("This one is kore" was heard as "the next one is kore".)
        return `${quoted(step.word)} means ${lower(bare(step.thing))}${note}. Ask for ${lower(bare(step.thing))}${way}.`;
      }
      // The note is not part of this line. It is said once they have repeated
      // the phrase (see `turnFor`): with it in between, "Say it" came after a
      // sentence about something else, and nobody could tell what "it" was.
      // (Something they could not get, said once more for them to hear.)
      return `${step.free && !again ? 'One to hear again: ' : ''}${quoted(step.say)} means ${lower(bare(step.meaning))}. Say it.`;
    }
    case 'recall':
      if (step.quick) {
        // ("What is carrot?" — as he put it: no article, no quotation.)
        const meaning = bare(step.meaning).replace(/^(?:a|an|the|some)\s+/i, '');
        const ask = `What is ${/[,?]/.test(meaning) ? quoted(meaning) : lower(meaning)}?`;
        return step.first && !again ? `Quick round. ${ask}` : ask;
      }
      // Asked as the moment it would be needed in, when the plan says what
      // that moment is: closer to using the phrase than translating it.
      return step.use && !again ? `${sentence(step.use)} What do you say?` : `How do you say ${quoted(step.meaning)}?`;
    case 'recognise': {
      if (!step.listen) return `What does ${quoted(step.say)} mean?`;
      // Something said to them, for them to catch: not translated, asked about.
      const figure = String(step.meaning || '');
      const question = /yen/i.test(figure) ? 'How much is that?'
        : /:|o'clock|[ap]\.?m/i.test(figure) ? 'What time is that?'
          : 'What number is that?';
      const opening = step.opens && !again ? `Let's try it for real. ${step.setup ? `${sentence(step.setup)} ` : ''}` : '';
      return `${opening}${quoted(step.say)}. ${question}`;
    }
    case 'scene': {
      // Asked the first time, the student is told what was said to them and
      // nothing else: what to answer is theirs to work out. "Answer in
      // Japanese: two people" made every role-play one more flashcard. The
      // English of the answer is the help they get if they need it.
      const opening = step.opens || step.setup ? `Let's try it for real. ${step.setup ? `${sentence(step.setup)} ` : ''}` : '';
      // A moment in which the student speaks first: nothing has been said to them.
      if (step.moment) {
        if (hint) return `In ${language}, say: ${bare(step.cue)}.`;
        return `${again ? '' : opening}${sentence(step.moment)} What do you say?`;
      }
      const english = /\?$/.test(String(step.meaning || '').trim()) ? quoted(step.meaning) : `${quoted(step.meaning)}.`;
      // What was said to them has just been asked about ("How much is that?"):
      // it is not said again, only answered.
      if (step.heard && !hint) return again ? `${quoted(step.tutor)}. What do you say back?` : 'What do you say back?';
      const said = `${quoted(step.tutor)} — that means ${english}`;
      // The help, when they need it: what to answer, in English. Where other
      // answers would do as well, it says so — "say: pork, please" was put to
      // a student who had just been asked for chicken and knew five foods.
      if (hint) return `That meant ${english} In ${language}, say: ${bare(step.cue)}${step.open ? ' — or something else that fits' : ''}.`;
      if (again) return `${said} What do you say?`;
      // Once a role-play is under way, what was said to them is the whole of
      // the turn: "What do you say?" after every line of it made a
      // conversation into an examination.
      return opening ? `${opening}${said} What do you say?` : said;
    }
    default: {
      // The last part does not ask whether they are ready for the next one:
      // "Ready for the next part?" — "Yes." — "You've finished the lesson."
      const close = step.final ? "That's the end of the lesson." : 'Ready for the next part?';
      if (step.allKnown) return `You already have these. ${close}`;
      if (step.drill) {
        // How it went, what to look at again, and what next — nothing else.
        const total = (step.items || []).length;
        const right = Number.isFinite(step.firstTry) ? step.firstTry : total;
        const again = (step.missed || []).map((item) => `${quoted(item.say)} for ${lower(bare(item.meaning))}`).join('; and ');
        return `Drill done: ${right} of ${total}.${again ? ` For next time: ${again}.` : ''} Again, or something else?`;
      }
      // A review claims nothing new: "you can now say: without bell pepper,
      // please" closed one in which eight other words had been asked for.
      const have = step.review ? (step.final ? 'Review done.' : "That's the review done.")
        : (step.items || []).length
          ? `In ${language} you can now say: ${listOf((step.items || []).map((item) => quoted(item)))}.`
          : 'That is this part done.';
      // Said plainly, rather than claimed: "you can now say two people" came
      // one turn after the student had been given the answer to it.
      const list = (step.missed || []).map((item) => `${quoted(item.say)} for ${lower(bare(item.meaning))}`).join('; and ');
      const missed = !list ? ''
        : step.final || step.review ? ` For next time: ${list}.`
          : ` Still to get: ${list}. We'll come back to ${(step.missed || []).length > 1 ? 'those' : 'that'}.`;
      return `${have}${missed} ${close}`;
    }
  }
}

/** What a step asked of the student, and what answers it. */
function askedOf(step, language) {
  switch (step.kind) {
    case 'teach':
      if (step.build) {
        return { asked: `to ask for ${lower(bare(step.thing))}, having been told that the word for it is "${step.word}"`, answer: step.say, inEnglish: false };
      }
      return { asked: `to say "${step.say}" (${step.meaning})`, answer: step.say, inEnglish: false };
    case 'recall':
      return { asked: `how to say "${step.meaning}" in ${language}`, answer: step.say, inEnglish: false };
    case 'recognise':
      return {
        asked: step.listen ? `what was just said to them in ${language}: "${step.say}"` : `what "${step.say}" means`,
        answer: step.meaning,
        inEnglish: true,
      };
    case 'scene':
      if (step.moment) return { asked: `what they would say at this moment: ${bare(step.moment)}`, answer: step.expect, inEnglish: false };
      // Not "to answer with X": nothing was asked for by name, and telling a
      // judge otherwise had it refuse water where the plan said beer.
      return { asked: `to reply, in a role-play, to "${step.tutor}" (${bare(step.meaning)})`, answer: step.expect, inEnglish: false };
    default:
      return { asked: 'whether they are ready to go on', answer: '', inEnglish: true };
  }
}

/**
 * What the tutor is shown: what it last asked, what to say in each case, and
 * the one line to say next.
 *
 * Every branch is written as words to say. Where the tutor was left to phrase
 * a correction itself it said "kyuu gives the hundreds", "toriniku means beef"
 * and "the timing is wrong".
 *
 * @param {ReturnType<typeof buildScript>} steps
 * @param {{language?: string, current?: number, misses?: number}} [options]
 *        `current` is the index of the step the tutor most recently asked, or
 *        -1. `misses` is how many turns it has taken since then without saying
 *        the next line: one is a correction or an answered question; two or
 *        more and it is simply told to say the line.
 * @returns {string}
 */
export function renderScript(steps, { language = 'the language', current = -1, misses = 0 } = {}) {
  if (!Array.isArray(steps) || !steps.length) return '';
  const lines = [];
  const next = steps[current + 1];
  const step = current >= 0 ? steps[Math.min(current, steps.length - 1)] : null;
  const ask = step ? askedOf(step, language) : null;
  const ack = ackFor(language);

  if (!step || !ask.answer || misses >= 2) {
    lines.push('Whatever they have just said, your whole next turn is the line below. Do not ask for anything else first.');
    lines.push('- If they asked a question, answer it in one sentence, then say the line below.');
  } else {
    const others = ask.inEnglish ? [] : alsoRight(ask.answer);
    const right = ask.inEnglish
      ? `- The answer is "${ask.answer}". Any wording that means the same is right.`
      : `- The answer is "${ask.answer}".${others.length ? ` Also right: ${others.map((entry) => `"${entry}"`).join(', ')}.` : ''} ` +
        'It is still right with a pause or a filler, with a polite word added, with o, wa or ga left out, or with a little extra.';
    // A wrong answer to "what does it mean" is put right and left: asking for
    // the English again teaches nothing. Anything in the language gets one
    // more go.
    const fix = ask.inEnglish ? `"${step.say}" means ${bare(ask.answer)}.` : `It's "${ask.answer}".`;

    if (misses === 1) {
      lines.push(`You asked them ${ask.asked}, and you have since corrected it or asked again.`);
      lines.push(right);
      lines.push(`- Do not ask for it again. If it is still wrong, start your turn with — ${fix} — and go straight on to the line below.`);
      lines.push(`- Otherwise say "${ack}" and then the line below.`);
      lines.push('- If they ask a question, answer it in one sentence, then say the line below.');
    } else {
      lines.push(`You last asked them ${ask.asked}.`);
      lines.push(right);
      lines.push(`- If it is right: say "${ack}" and then the line below. Nothing else.`);
      if (ask.inEnglish) {
        lines.push(`- If it is wrong, or they do not know: start your turn with — ${fix} — and go straight on to the line below.`);
      } else {
        lines.push(
          '- If it is wrong: say in a few words which word or sound was different, but only if you are sure which. ' +
            `Then say "${ask.answer}" and ask for it once more. That is the whole turn.`,
        );
        lines.push(`- If they do not know: say "${ask.answer}" and ask them to say it.`);
      }
      lines.push(`- If they ask a question instead: answer it in a sentence or two, then say again — ${lineFor(step, language, { again: true })}`);
    }
  }
  lines.push('- If they say they already know this, or ask to skip it or move on: your whole turn is — OK.');

  lines.push('');
  if (next) {
    lines.push('Your next turn, word for word:');
    lines.push(lineFor(next, language));
    if (next.kind === 'recall') {
      lines.push('');
      lines.push(`(The answer will be "${next.say}". It is not part of your turn: do not say it.)`);
    } else if (next.kind === 'scene') {
      lines.push('');
      lines.push(`(They should answer "${next.expect}". Do not say it for them.)`);
    }
  } else {
    lines.push('That was the last thing in this part. Answer them briefly and wait.');
  }

  return lines.join('\n');
}

/**
 * Which step did the tutor just perform?
 *
 * Read off what it actually said, so the app's idea of where the lesson is
 * cannot drift from the conversation. Only two answers are possible: the step
 * after the current one, or no movement — the tutor is shown one line at a
 * time, so it has nothing further ahead to jump to, and a word that happens to
 * recur later in the script is not a leap.
 *
 * @param {ReturnType<typeof buildScript>} steps
 * @param {string} tutorText
 * @param {number} current index of the step most recently asked, or -1
 * @returns {number} the matched index, or -1 when the turn matches no step
 */
export function locateStep(steps, tutorText, current = -1) {
  if (!Array.isArray(steps) || !steps.length) return -1;
  if (fold(tutorText).length < 2) return -1;
  const has = (text) => contains(tutorText, [text]);
  /** The phrase itself, or a wording of it that is just as right. */
  const hasPhrase = (text) => contains(tutorText, variantKeys(text));

  const index = current + 1;
  const step = steps[index];
  if (!step) return -1;

  // A phrase said without its meaning has not been taught: "Hai. futari desu"
  // was once counted as the line that teaches it.
  if (step.kind === 'teach') {
    // A request they are left to make themselves is taught by its word.
    if (step.build) return hasPhrase(step.word) && has(step.thing) ? index : -1;
    return hasPhrase(step.say) && has(step.meaning) ? index : -1;
  }
  // Asking from the English: the meaning (or the situation) is there and the
  // answer is not.
  if (step.kind === 'recall') {
    const asked = has(step.meaning) || (step.use ? overlap(tutorText, step.use) >= 0.7 : false);
    return asked && !hasPhrase(step.say) ? index : -1;
  }
  // Asking from the language: the phrase is there and its meaning is not.
  if (step.kind === 'recognise') return hasPhrase(step.say) && !has(step.meaning) ? index : -1;
  // The role-play line, in either language: a tutor that gives only the
  // English of its line has still asked the question.
  if (step.kind === 'scene') {
    if (step.moment) return overlap(tutorText, step.moment) >= 0.7 ? index : -1;
    return has(step.tutor) || has(step.meaning) || overlap(tutorText, step.tutor) >= 0.7 ? index : -1;
  }

  // The closing line: it says what they can now say, or asks if they are ready.
  if (/\bready\b|\byou can now say\b|\bnext (?:part|one)\b|\balready have these\b/i.test(tutorText)) return index;
  const named = (step.items || []).filter((item) => has(item)).length;
  return named >= 2 ? index : -1;
}

/**
 * Is a tutor turn about the step it last asked — a correction, a repeat, an
 * answer to a question about it — or about something else entirely?
 * @param {ReturnType<typeof buildScript>[number]|undefined} step
 * @param {string} tutorText
 */
export function mentionsStep(step, tutorText) {
  if (!step) return false;
  const phrases = [step.say, step.expect].filter(Boolean);
  if (phrases.some((phrase) => contains(tutorText, variantKeys(phrase)))) return true;
  if ([step.meaning, step.tutor, step.cue].filter(Boolean).some((text) => contains(tutorText, [text]))) return true;
  return Boolean(step.use) && overlap(tutorText, step.use) >= 0.7;
}

/**
 * Did the student's answer contain what the step was after?
 *
 * Deliberately one-sided: `true` means certainly right. `false` means "could
 * not tell" — a transcript is not the audio, and a tutor must never be told an
 * answer was wrong on the strength of one.
 *
 * @param {ReturnType<typeof buildScript>[number]|undefined} step
 * @param {string} studentText
 * @returns {boolean}
 */
export function answersStep(step, studentText) {
  if (!step) return false;
  if (step.kind === 'recognise') {
    // "500" for "500 yen": the number is what there was to catch.
    const digits = (text) => fold(String(text || '').replace(/(\d),(?=\d{3})/g, '$1')).split(' ').filter((word) => /^\d+$/.test(word)).join(' ');
    const figure = step.listen ? digits(step.meaning) : '';
    return contains(studentText, [step.meaning]) || (figure !== '' && ` ${digits(studentText)} `.includes(` ${figure} `));
  }
  const want = step.kind === 'scene' ? step.expect : step.say;
  if (contains(studentText, variantKeys(want))) return true;
  // As the transcriber may have written it: in the language's own script.
  const written = squash(step.script);
  return written.length >= 2 && squash(studentText).includes(written);
}

/** Without spaces or punctuation, for comparing text in a script that uses neither. */
function squash(text) {
  return String(text || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/**
 * Did the student answer with a different thing they have been taught?
 *
 * Asked for beef, a student said "kyabetsu" and was told "Hai." Hearing a
 * whole other taught word is safe to act on from a transcript, where a
 * mispronunciation is not.
 *
 * @param {ReturnType<typeof buildScript>[number]|undefined} step
 * @param {string} studentText
 * @param {{say: string, meaning: string}[]} items everything taught so far
 * @returns {{say: string, meaning: string}|null}
 */
export function confusedWith(step, studentText, items) {
  if (!step || step.kind === 'wrap' || answersStep(step, studentText)) return null;
  const mine = fold(step.kind === 'scene' ? step.expect : step.say);
  // Nor is a word that is part of the answer: "gyuuniku o onegaimasu", for
  // "gyuuniku o onegaishimasu", was met with "gyuuniku is beef".
  const within = ` ${mine} `;
  const others = (Array.isArray(items) ? items : []).filter(
    (item) => item && fold(item.say) !== mine && (step.kind === 'recognise' || !within.includes(` ${fold(item.say)} `)),
  );
  // Longest first, so "omizu o futatsu kudasai" is not mistaken for "omizu".
  const byLength = [...others].sort((a, b) => fold(b.say).length - fold(a.say).length);
  if (step.kind === 'recognise') {
    return byLength.find((item) => fold(item.meaning) !== fold(step.meaning) && contains(studentText, [item.meaning])) || null;
  }
  return byLength.find((item) => contains(studentText, [item.say])) || null;
}

/** First letter capital, for the start of a sentence. */
const capital = (text) => {
  const body = String(text || '');
  return body ? `${body.charAt(0).toUpperCase()}${body.slice(1)}` : '';
};

/** What was heard, without the ums. Nobody wants their hesitation read back to them. */
function withoutFillers(text) {
  return String(text || '')
    .replace(/(^|[\s,.])(?:um+|uh+|er+m?|ah+|eh+|hmm+|etto|eeto|ano+)(?=[\s,.…]|$)[,.…]*/gi, '$1')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,.…]+|[\s,…]+$/g, '')
    .trim();
}

/**
 * The correction for an answer that was tried and was not right.
 *
 * "I specifically need to know what was wrong": when one word of several is
 * the difference, the correction names it. When the whole thing is one word,
 * hearing both is the correction. And it never says "I heard X. It's X" —
 * which is what a transcript in another script once produced.
 *
 * @param {string} heard what was heard, in Latin letters
 * @param {string} answer what was wanted
 * @returns {string}
 */
export function correctionFor(heard, answer) {
  const said = withoutFillers(heard);
  const plain = `Once more: "${answer}".`;
  if (!said || fold(said) === fold(answer)) return plain;
  const mine = fold(said).split(' ');
  const wanted = fold(answer).split(' ');
  // Something long with none of the answer in it was not an attempt at it.
  if (mine.length >= 5 && !mine.some((word) => wanted.includes(word))) return plain;
  if (wanted.length > 1 && mine.length === wanted.length) {
    const different = wanted.map((word, index) => (word === mine[index] ? -1 : index)).filter((index) => index >= 0);
    if (different.length === 1) {
      const at = different[0];
      return `Not quite. It's "${wanted[at]}", not "${mine[at]}": "${answer}". Say it once more.`;
    }
  }
  // Several words against a different number of them ("roku hyaku go juu en"
  // for "roppyaku gojuu en"): the word of the answer that is nowhere in what
  // they said is the one to name.
  if (wanted.length > 1 && mine.length !== wanted.length) {
    const run = mine.join('');
    const absent = wanted.filter((word) => !run.includes(word));
    if (absent.length === 1) return `Not quite. The word is "${absent[0]}": "${answer}". Say it once more.`;
  }
  // One word against one word: say which part of it differed. By ear, two
  // near-identical words in a row are hard to tell apart.
  if (wanted.length === 1 && mine.length === 1) {
    const [a, b] = [mine[0], wanted[0]];
    let front = 0;
    while (front < a.length && front < b.length && a[front] === b[front]) front += 1;
    let back = 0;
    while (back < a.length - front && back < b.length - front && a[a.length - 1 - back] === b[b.length - 1 - back]) back += 1;
    const theirs = a.slice(front, a.length - back);
    const ours = b.slice(front, b.length - back);
    if (!theirs && ours) {
      const where = back === 0 ? 'left off' : 'left out';
      return `Not quite. You ${where} "${ours}": "${answer}". Say it once more.`;
    }
    // Only where the rest of the word was there: "It's oumo, not amu" was
    // said of "toumorokoshi", and is a correction nobody could use.
    const kept = front + back >= Math.ceil(b.length * 0.6);
    if (theirs && ours && kept && ours.length <= 3 && theirs.length <= 3) {
      // A lone letter is hard to hear: take it to the end of the word when
      // that is close, so "sou, not zou" rather than "s, not z".
      const reach = back <= 3 ? back : 0;
      const tailOurs = b.slice(front, b.length - back + reach);
      const tailTheirs = a.slice(front, a.length - back + reach);
      return `Not quite. It's "${tailOurs}", not "${tailTheirs}": "${answer}". Say it once more.`;
    }
  }
  // What was heard is read back only when it could have been an attempt at
  // the answer. "I heard Lorenzo" — for "hourensou" — is the recogniser's
  // guess read out as the student's mistake.
  const off = soundGap(said, answer);
  const reach = soundLimit(soundKey(answer).length, true);
  if (!/^[\x00-\x7f]+$/.test(said) || (mine.length !== wanted.length && off > reach)) return plain;
  return `Not quite. I heard "${bare(said)}". It's "${answer}". Say it once more.`;
}

/** What kind of reply a phrase is, as far as its ending shows. */
function shapeOf(phrase) {
  const whole = fold(phrase);
  const key = whole.replace(/ desu$/, '');
  if (/(?:^| )(?:kudasai|onegaishimasu)$/.test(key)) return 'request';
  if (/ de$/.test(key)) return 'by';
  // A bare word of vocabulary — not a set phrase that happens to end in desu.
  if (!whole.includes(' ')) return 'word';
  return '';
}

/**
 * Is what they said, in a role-play, another thing they know that is the same
 * kind of reply as the planned one?
 * @param {any} step a scene step
 * @param {string} said
 * @param {{say: string, meaning: string}[]} known
 * @returns {{say: string, meaning: string, thing?: string}|null} what they said, as a thing they know
 */
export function fitsScene(step, said, known) {
  const shape = shapeOf(step.expect);
  // (In a part's one open question, naming a thing answers it whatever the
  // plan had down as the reply.)
  if (!shape && !step.single) return null;
  const list = (Array.isArray(known) ? known : []).filter((item) => item && item.say);
  // "kaado de onegaishimasu" for "kaado de"; "tamanegi ga suki desu" for a word.
  // A word they know, put into the asking they know. "tamanegi o
  // onegaishimasu" was refused because onion had been taught as a bare word —
  // and where the plan's own answer was a bare word, a whole request was
  // accepted and then not said back, because it was taken for the word.
  if (shape === 'request' || shape === 'word' || step.single) {
    const frame = /(?:^| )(kudasai|onegaishimasu)(?: |$)/.exec(fold(said)) || /(ください|下さい|おねがいします|お願いします)/.exec(String(said));
    const asking = frame ? (/onegai|ねがい|願い/.test(frame[1]) ? 'onegaishimasu' : 'kudasai') : '';
    // Asked what they will have, with a handful of words to answer with, the
    // word alone is an answer — and so are two of them. "Tomorokoshi to
    // ramu… kudasai" was refused, and so was "piiman to tamanegi".
    const named = frame || step.single ? thingsNamed(said, list) : [];
    if (named.length) {
      const words = named.map((entry) => entry.word).join(' to ');
      const thing = listOf(named.map((entry) => lower(bare(entry.thing))));
      const planned = requestParts(step.expect);
      return {
        say: `${words} o ${asking || (planned ? planned.frame : 'kudasai')}`,
        meaning: `${thing}, please`,
        thing,
        ...(named.length > 1 ? { things: named } : {}),
      };
    }
  }
  if (!shape) return null;
  const same = list.find((item) => shapeOf(item.say) === shape && contains(said, variantKeys(item.say)));
  return same ? { say: same.say, meaning: same.meaning } : null;
}

/**
 * The things a student knows the word for that are named in what they said,
 * in the order they said them.
 *
 * Found three ways, because a recogniser writes a beginner's Japanese three
 * ways: as the romaji word, as the word in its own writing ("ほうれん草"), and
 * as something that only sounds like it ("Tomorokushi").
 *
 * @param {string} said
 * @param {{say: string, meaning: string, script?: string}[]} known
 * @returns {{word: string, thing: string}[]}
 */
export function thingsNamed(said, known) {
  const things = [];
  const seen = new Set();
  for (const item of Array.isArray(known) ? known : []) {
    if (!item || !item.say) continue;
    const parts = requestParts(item.say);
    let entry = null;
    if (parts && requestThing(item.meaning)) {
      entry = { word: parts.word, thing: requestThing(item.meaning), script: String(item.script || '').replace(/(?:を)?(?:ください|下さい|お願いします|おねがいします)[。.]?$/, '') };
    } else if (shapeOf(item.say) === 'word') {
      entry = { word: item.say, thing: bare(item.meaning), script: item.script || '' };
    }
    if (!entry || seen.has(fold(entry.word))) continue;
    // A word taught as itself gives the thing its name ("carrot", not "a carrot").
    seen.add(fold(entry.word));
    things.push(entry);
  }
  things.sort((a, b) => b.word.length - a.word.length);

  const text = ` ${loose(said)} `;
  const written = squash(said);
  // The words of it, and where each one starts.
  const tokens = [];
  const spots = [];
  for (const match of text.matchAll(/\S+/g)) {
    tokens.push(match[0]);
    spots.push(match.index);
  }
  /** @type {{at: number, end: number, entry: any}[]} */
  const found = [];
  const taken = (from, to) => found.some((hit) => from < hit.end && to > hit.at);
  // First, everything that is plainly there: as a whole word, or in its own
  // writing. Only then what merely sounds like something — and never out of
  // words that are plainly something else: "gyuunyuu o kudasai" was once
  // taken for beef, because "gyuuniku" was looked for first.
  const unfound = [];
  for (const entry of things) {
    let at = -1;
    let end = -1;
    // As a whole word, however it was spaced.
    for (const form of variantKeys(entry.word)) {
      const index = text.indexOf(` ${loose(form)} `);
      if (index >= 0) { at = index / text.length; end = (index + form.length + 1) / text.length; break; }
    }
    if (at >= 0) {
      if (!taken(at, end)) found.push({ at, end, entry });
      continue;
    }
    // In its own writing. (Placed after the Latin letters, which come first
    // in what is compared: its position is only for the order of things.)
    const own = squash(entry.script);
    if (own.length >= 2 && written.includes(own)) {
      found.push({ at: 2 + written.indexOf(own) / written.length, end: 2 + (written.indexOf(own) + own.length) / written.length, entry });
      continue;
    }
    unfound.push(entry);
  }
  // By sound, a letter or two out — one word of what they said, or two or
  // three run together ("buta niku"), never an arbitrary stretch of letters:
  // "to houren ku…" is not "toriniku".
  const candidates = [];
  for (const entry of unfound) {
    const want = soundKey(entry.word);
    if (want.length < 5) continue;
    const limit = soundLimit(want.length, true);
    for (let from = 0; from < tokens.length; from += 1) {
      for (let size = 1; size <= 3 && from + size <= tokens.length; size += 1) {
        const run = soundKey(tokens.slice(from, from + size).join(' '));
        if (!run || Math.abs(run.length - want.length) > 1) continue;
        const cost = soundDistance(run, want);
        if (cost > limit) continue;
        candidates.push({
          cost, entry,
          at: spots[from] / text.length,
          end: (spots[from + size - 1] + tokens[from + size - 1].length) / text.length,
        });
      }
    }
  }
  // The nearest first, so that a stretch of sound goes to the word it is nearest to.
  candidates.sort((a, b) => a.cost - b.cost);
  const placed = new Set();
  for (const hit of candidates) {
    if (placed.has(hit.entry) || taken(hit.at, hit.end)) continue;
    placed.add(hit.entry);
    found.push({ at: hit.at, end: hit.end, entry: hit.entry });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, 3).map((hit) => ({ word: hit.entry.word, thing: hit.entry.thing }));
}

/** The first word of a phrase, as a nudge towards recalling the rest. */
function startOf(answer) {
  return `${String(answer || '').trim().split(/\s+/)[0]}…`;
}

/** Letters only, long vowels collapsed: the form two spellings of one sound share. */
const sounds = (text) => loose(text).replace(/ /g, '');

/**
 * Is `heard` the answer with a letter or two wrong — a slip, rather than
 * something else altogether?
 * @param {string} heard
 * @param {string} answer
 */
export function nearMiss(heard, answer) {
  const a = sounds(withoutFillers(heard));
  const b = sounds(answer);
  if (!a || !b || a === b) return false;
  if (Math.abs(a.length - b.length) > 2) return false;
  // Edit distance, stopping once it is clearly more than two.
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length] <= 2;
}

/**
 * The sounds of a phrase, however a transcriber spelled them.
 *
 * On a real call the student's Japanese arrives as whatever the recogniser
 * made of it: "Gen keen de" for "genkin de", "Hassan yen" for "hassen en",
 * Korean hangul for "kuji juppun". A text model writes those back in Latin
 * letters, and this reduces Latin letters to something two spellings of one
 * sound share: English vowel spellings read as the vowels they stand for,
 * doubled letters as one, l as r.
 * @param {string} text
 */
export function soundKey(text) {
  const latin = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7f]+/g, ' ');
  return fold(withoutFillers(latin))
    .split(' ')
    .map((word) => (word === 'yen' ? 'en' : word === 'wo' ? 'o' : word)
      .replace(/eu/g, 'u')
      .replace(/ee|ea|ie/g, 'i')
      .replace(/oo/g, 'u')
      .replace(/ou|oh|ow/g, 'o')
      .replace(/ay|ei|eh/g, 'e')
      .replace(/ah/g, 'a')
      .replace(/ph/g, 'f')
      .replace(/c(?=[aou])|ck|q/g, 'k')
      .replace(/l/g, 'r'))
    .join('')
    .replace(/(.)\1+/g, '$1');
}

/**
 * Is what was heard the answer, give or take what a recogniser does to a
 * beginner's Japanese?
 *
 * The first real call on this design had ten corrections in it, and eight
 * were of things the student had said correctly: "genkin de" came back as
 * "Gen keen de" and then as "元気で" (genki de), and was corrected both times.
 * A letter of difference in a transcript is the recogniser's doing at least as
 * often as the student's, so it is given to the student. What is still a
 * mistake: a different word, a swapped particle, a missing word, a missing
 * syllable (two letters or more).
 *
 * @param {string} heard in Latin letters
 * @param {string} answer
 */
export function soundsLike(heard, answer, { wide = false } = {}) {
  const a = soundKey(heard);
  if (!a) return false;
  return variantKeys(answer).some((form) => {
    const b = soundKey(form);
    if (!b) return false;
    if (a === b) return true;
    // The last "u" of a word is barely said, and a recogniser leaves it off:
    // "Ram" for "ramu", "nas" for "nasu".
    if (b.length >= 4 && /[^aiueo]u$/.test(b) && a === b.slice(0, -1)) return true;
    // A short word is itself or it is another word: "goji" is not "kuji".
    if (b.length < 5) return false;
    // Inside something longer — as whole words of it, not as part of another
    // word: "nijuppun" is not "juppun".
    if (b.length >= 6 && a.includes(b) && soundRun(heard, b)) return true;
    // "wakarimasu" is not "wakarimasen": the ending is the meaning.
    if ((/masen$/.test(b) && /masu$/.test(a)) || (/masu$/.test(b) && /masen$/.test(a))) return false;
    const limit = soundLimit(b.length, wide);
    // The extra room is for letters heard as other letters. A syllable that
    // is not there is still not there: "gyuuni" is not "gyuuniku".
    if (Math.abs(a.length - b.length) > (b.length >= 12 ? 2 : 1)) return false;
    return soundDistance(a, b, { weighted: wide }) <= limit;
  });
}

/** Is the sound key `want` made of whole words of what was heard (see `runsTogether`)? */
function soundRun(heard, want) {
  const latin = String(heard || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\x00-\x7f]+/g, ' ');
  const words = fold(withoutFillers(latin)).split(' ').filter(Boolean);
  for (let from = 0; from < words.length; from += 1) {
    for (let to = from; to < words.length && to < from + 6; to += 1) {
      const joined = soundKey(words.slice(from, to + 1).join(' '));
      const at = joined.indexOf(want);
      if (at < 0) continue;
      if (GLUE_BEFORE.includes(joined.slice(0, at)) && GLUE_AFTER.map((word) => soundKey(word)).includes(joined.slice(at + want.length))) return true;
    }
  }
  return false;
}

/**
 * How many letters of difference a recogniser is allowed.
 *
 * One, to begin with — and that left a long word with no room at all. On the
 * third real call "hourensou" was asked for seven times and "toumorokoshi"
 * six, and what came back was "Haorensu", "Lorenzo", "kao morokoshi": a
 * twelve-letter word with its first syllable misheard is the same word. So a
 * long word of vocabulary gets more (`wide`), and a number does not: in
 * "shichiji" and "ichiji" the one syllable is the whole of the difference.
 * @param {number} length of the answer's sound key
 * @param {boolean} wide
 */
function soundLimit(length, wide) {
  if (!wide) return length >= 12 ? 2 : 1;
  if (length >= 10) return 3;
  return length >= 7 ? 2 : 1;
}

/** Sounds a recogniser writes one for the other: a voiced sound and its unvoiced twin. */
const SOUND_TWINS = new Set(['sz', 'zs', 'td', 'dt', 'kg', 'gk', 'pb', 'bp', 'fh', 'hf', 'bv', 'vb', 'mn', 'nm', 'jz', 'zj']);

/**
 * How far apart two sound keys are, in letters. Weighted, one vowel for
 * another and one twin for the other count half: "tomorokushi" is nearer to
 * "tomorokoshi" than "tomorokashi" would be to "tomoronoshi".
 * @param {string} a
 * @param {string} b
 * @param {{weighted?: boolean}} [options]
 * @returns {number}
 */
export function soundDistance(a, b, { weighted = true } = {}) {
  const x = String(a || '');
  const y = String(b || '');
  const cost = (p, q) => {
    if (p === q) return 0;
    if (!weighted) return 1;
    if (/[aiueo]/.test(p) && /[aiueo]/.test(q)) return 0.5;
    return SOUND_TWINS.has(p + q) ? 0.5 : 1;
  };
  let row = Array.from({ length: y.length + 1 }, (_, index) => index);
  for (let i = 1; i <= x.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= y.length; j += 1) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + cost(x[i - 1], y[j - 1]));
    }
    row = next;
  }
  return row[y.length];
}

/**
 * How far what was heard is from an answer, in any of its wordings.
 * @param {string} heard
 * @param {string} answer
 * @returns {number} Infinity when there is nothing to compare
 */
export function soundGap(heard, answer) {
  const a = soundKey(heard);
  if (!a) return Infinity;
  let best = Infinity;
  for (const form of variantKeys(answer)) {
    const b = soundKey(form);
    if (b) best = Math.min(best, soundDistance(a, b));
  }
  return best;
}

/** Is the meaning a number, a price or a time — where one syllable is the difference? */
export function isCount(meaning) {
  return /\d/.test(String(meaning || '')) ||
    // (Not "one": "I don't want the purple one" lost its leeway as a number,
    // and "Murasaki noはいらないです" was marked wrong twice. A figure is
    // written in digits, which the line above catches.)
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand|half past|o'clock|yen)\b/i.test(String(meaning || ''));
}

/**
 * Is what was said, in English, the meaning asked for — give or take a
 * letter? "Lab." was what came back when a student said "lamb", and it was
 * marked wrong.
 * @param {string} said
 * @param {string} meaning
 */
export function meaningNear(said, meaning) {
  if (isCount(meaning)) return false;
  const skip = new Set(['a', 'an', 'the', 'some', 'please', 'to', 'of', 'it', 'is', 'i', 'you', 'that', 'this', 'means', 'mean']);
  const wanted = fold(meaning).split(' ').filter((word) => word && !skip.has(word));
  const mine = fold(withoutFillers(said)).split(' ').filter((word) => word && !skip.has(word));
  if (!wanted.length || !mine.length || mine.length > wanted.length + 2) return false;
  const near = (a, b) => {
    if (a === b || `${a}s` === b || a === `${b}s`) return true;
    if (b.length < 4 || Math.abs(a.length - b.length) > 1 || a[0] !== b[0]) return false;
    return soundDistance(a, b, { weighted: false }) <= (b.length >= 8 ? 2 : 1);
  };
  return wanted.every((word) => mine.some((own) => near(own, word)));
}

/**
 * "Yes." "OK." "Ready." — said to something that asked for a phrase. It is
 * not an attempt at the phrase and it is not a question: the ask is made
 * again. (Put to the tutor as a question, a bare "Yes." was once answered "I
 * asked you to request pork politely in Japanese, but the actual phrase isn't
 * given here.")
 * @param {string} text
 */
export function bareYes(text) {
  const said = fold(withoutFillers(text));
  return /^(yes|yeah|yep|yup|ok|okay|sure|ready|right|alright|all right|got it|i m ready|go ahead|mm hm+|mhm+|uh huh)( (yes|yeah|ok|okay|please|sure|ready|i m ready|go ahead))?$/.test(said);
}

/** Little words whose swapping is a mistake however alike they sound. */
const PARTICLES = new Set(['o', 'wo', 'wa', 'ga', 'ni', 'de', 'to', 'mo', 'no', 'e', 'ka', 'ya']);

/**
 * Was one little word said for another, or the question word left off? That
 * is the student's slip, not the recogniser's: "kore o ikura desu ka" for
 * "kore wa ikura desu ka".
 * @param {string} heard
 * @param {string} answer
 */
function particleSlip(heard, answer) {
  const mine = fold(withoutFillers(String(heard || '').replace(/[^\x00-\x7f]+/g, ' '))).split(' ').filter(Boolean);
  const wanted = fold(answer).split(' ').filter(Boolean);
  if (wanted[wanted.length - 1] === 'ka' && mine[mine.length - 1] !== 'ka' && !/ka$/.test(mine.join(''))) return true;
  if (mine.length !== wanted.length) return false;
  const different = wanted.map((word, index) => (word === mine[index] ? -1 : index)).filter((index) => index >= 0);
  return different.length === 1 && (PARTICLES.has(wanted[different[0]]) || PARTICLES.has(mine[different[0]]));
}

/**
 * What the tutor's next turn is, decided after the student has spoken.
 *
 * Four kinds of turn come out of this:
 *   - `exact`: the words of the turn. The app could tell what happened.
 *   - `judge`: the app could not tell whether the answer was right. A text
 *     model is asked (see src/judge.js) and this is called again with its
 *     verdict; only if that fails is the choice left to the tutor's ear —
 *     between two turns that are both written out.
 *   - `question`: the student asked something. The tutor answers briefly —
 *     the one thing it composes itself — and then `after` is said as a turn
 *     of its own.
 *   - null: there is no script to follow.
 *
 * `advances` says whether the turn takes the lesson on to the next step, so
 * the app knows where it is afterwards without having to guess.
 *
 * @param {ReturnType<typeof buildScript>} steps
 * @param {{language?: string, current?: number, tries?: number, heard?: string,
 *          taught?: {say: string, meaning: string}[], verdict?: any}} [options]
 *        `current` is the step last asked (-1 for none), `tries` how many times
 *        it has already been corrected, `heard` what the student said, and
 *        `replies` how many times each thing said back to them has already
 *        been heard with its English (a Map, by folded phrase). `ordered`
 *        is what they have asked for so far in the role-play in progress.
 *        `unheard` is how many times running they have spoken on this step
 *        and nothing could be made out: nothing is called wrong on that.
 */
export function turnFor(steps, { language = 'the language', current = -1, tries = 0, heard = '', taught = [], verdict = null, replies = null, ordered = [], unheard = 0 } = {}) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const next = steps[current + 1];
  if (!next) return null;
  const nextLine = lineFor(next, language);
  const step = current >= 0 ? steps[current] : null;
  const said = String(heard || '').trim();
  const ack = ackFor(language);

  // Nothing is waiting for an answer: the part is starting.
  if (!step || step.kind === 'wrap') {
    if (said && looksLikeQuestion(said)) {
      return { mode: 'question', heard: said, asked: '', after: nextLine, advances: true };
    }
    return { mode: 'exact', line: nextLine, advances: true, reason: 'start' };
  }

  const ask = askedOf(step, language);
  const english = step.kind === 'recognise';
  const scene = step.kind === 'scene';
  // After a correction or an answer that was given to them, a new item is
  // announced as one: two glosses run together ("X means in cash. Y means no
  // bag needed. Say it.") leave "it" meaning either.
  const onward = next.kind === 'teach' ? `Next: ${nextLine}` : nextLine;
  // What a right answer gets. Repeating a phrase straight after hearing it
  // earns no comment — going on says it was fine. Producing one does: the one
  // word, or what the person they said it to would say back.
  //
  // What is said back comes with its English the first two times it is heard.
  // After that it is theirs to understand: with every reply translated every
  // time, nothing ever had to be understood by ear.
  const heardBefore = (reply) => (replies && typeof replies.get === 'function' ? replies.get(fold(reply)) || 0 : 0) >= 2;
  const reply = step.reply && step.replyMeaning && (step.kind !== 'teach' || (step.build && step.use)) ? step.reply : '';
  const japanese = ack === 'Hai.';
  /** The thing asked for, when what was said is a request for one. */
  const requested = (item) => {
    // Two things asked for at once are said back as two.
    if (japanese && item && !step.check && Array.isArray(item.things) && item.things.length) {
      return { word: item.things.map((entry) => orderWord(entry.word)).join(' to '), thing: bare(item.thing) };
    }
    const parts = japanese && item && !step.check ? requestParts(item.say) : null;
    const thing = parts ? bare(item.thing || requestThing(item.meaning)) : '';
    return parts && thing ? { word: orderWord(parts.word), thing } : null;
  };
  // A request is said back before it is acknowledged, as a waiter does. It is
  // how they know that what they chose was what was heard: "and to drink?"
  // straight after an order for water said the opposite. And it is what makes
  // one reply different from the next — "kashikomarimashita" nine times in
  // twenty-four turns had become the new "Hai."
  //
  // Like any reply, the saying-back comes with its English twice and is then
  // theirs to catch: eight of them in thirteen turns, every one translated,
  // was "Hai." in costume.
  const echoKnown = heardBefore('desu ne');
  const back = (item) => {
    const order = requested(item);
    const replyKnown = reply ? heardBefore(reply) : false;
    if (order && reply && !echoKnown && !replyKnown) {
      return `"${order.word} desu ne. ${bare(reply)}" — ${lower(order.thing)}, right? ${sentence(step.replyMeaning)}`;
    }
    // Both theirs already: one thing said, as it would be.
    if (order && reply && echoKnown && replyKnown && scene) return `"${order.word} desu ne. ${bare(reply)}".`;
    const pieces = [];
    if (order) pieces.push(echoKnown ? `"${order.word} desu ne".` : `"${order.word} desu ne" — ${lower(order.thing)}, right?`);
    // (Outside a role-play, once the reply is theirs, the order said back is
    // the whole of it.)
    if (reply && !replyKnown) pieces.push(`${quoted(reply)} — ${lower(bare(step.replyMeaning))}.`);
    else if (reply && (scene || !order)) pieces.push(`${quoted(reply)}.`);
    return pieces.join(' ');
  };
  // And when a role-play ends, what they ordered arrives. A scene that closes
  // on a tally of phrases has no outcome; one that closes on "your water and
  // your beer" was about something.
  const served = (item) => {
    // (The role-play ends at the closing line, or where a quick round begins.)
    // (One exchange is not a meal: the order is said back, and that is all.)
    if (!japanese || !scene || step.single || !(next.kind === 'wrap' || next.quick) || step.check) return '';
    // (Not when the reply is itself the handing over: "hai, douzo".)
    if (reply && /(?:^| )douzo(?: |$)/.test(fold(reply))) return '';
    const all = [...(Array.isArray(ordered) ? ordered : [])];
    const order = requested(item);
    if (order) all.push(order);
    const seen = new Set();
    const things = [];
    for (const entry of all) {
      const key = fold(entry && entry.word);
      if (!key || seen.has(key) || /^(kore|sore|are)$/.test(key)) continue;
      seen.add(key);
      things.push(entry);
    }
    if (!things.length) return '';
    const brought = things.slice(-3);
    // The order is accepted, and then — a little later — it comes: a waiter
    // does not say "certainly" and hand it over in one breath.
    const accepted = reply ? (heardBefore(reply) ? `${quoted(reply)}. ` : `${quoted(reply)} — ${lower(bare(step.replyMeaning))}. `) : '';
    return `${accepted}A little later: "omatase shimashita. ${brought.map((entry) => entry.word).join(' to ')} desu" — thank you for waiting: ${listOf(brought.map((entry) => lower(entry.thing)))}.`;
  };
  /** The whole turn for a right answer, given what was said (when that is known). */
  const rightWith = (item) => {
    const answer = served(item) || back(item);
    if (!answer) return `${ack} ${nextLine}`;
    // "Pork, right? You want to order beef." — a sentence between the two.
    const bridge = !scene && next.kind === 'recall' ? 'Now a different one. ' : '';
    return `${answer} ${bridge}${onward}`;
  };
  let right = `${ack} ${nextLine}`;
  // Repeating a phrase earns the note about it: said now, it is about a word
  // they have just had in their mouth.
  if (step.kind === 'teach' && !step.build) right = step.note ? `${sentence(step.note)} ${onward}` : nextLine;
  // What comes back is the next thing asked about: a price to catch.
  else if (step.check) right = nextLine;
  // In a role-play, a reply that was passed without its words being known:
  // nothing is said back as if it were.
  else if (scene) right = rightWith(null);
  else if (step.build || (step.kind === 'recall' && step.use)) right = rightWith({ say: step.say, meaning: step.meaning, thing: step.thing });
  // Said right only after being given it: going on is comment enough.
  if (step.kind === 'recall' && tries >= 1 && right === `${ack} ${nextLine}`) right = onward;
  // In a quick round the next question is the whole reply to a right answer.
  if (step.quick && next.quick) right = nextLine;
  // And in a drill, the closing line too: it says how it went.
  if (step.quick && next.drill) right = nextLine;
  const sceneRight = (item) => (step.check ? right : rightWith(item));
  // What is said when the answer is given to them and the lesson goes on. A
  // sentence stands between the answer and the next thing asked: "It's futari
  // desu. You want the waiter to come over. What do you say?" invited
  // "futari desu" — and so did "futari desu means two people. You want to see
  // the menu. What do you say?".
  const opening = Boolean(next.opens);
  const spacer = next.kind === 'wrap' || next.kind === 'teach' || opening ? '' : "Let's keep going. ";
  const another = !opening && (next.kind === 'recall' || next.kind === 'scene') ? 'Now a different one. ' : '';
  const told = english
    ? `"${step.say}" means ${lower(bare(ask.answer))}. ${another}${onward}`
    : `It's "${ask.answer}". ${spacer}${onward}`;
  // In a quick round a miss is told and the round goes on: no second try now.
  // (It comes round again at the end: see the conductor.)
  const quickTold = step.quick ? `It's "${ask.answer}". ${next.quick ? `Next: ${nextLine}` : onward}` : '';
  // A role-play line gets three goes: the open question, then what to answer
  // in English, then the words — and having been given them, they say them,
  // so the scene is finished rather than abandoned.
  // (Something said to them to catch is said once more before it is told.)
  const last = (english && !step.listen) || tries >= (scene ? 2 : 1);
  const given = scene && tries === 1;

  // A verdict, when there is one, came from a model that read the transcript
  // with nothing else to do. It settles what the checks below could not.
  const ruled = verdict && typeof verdict.verdict === 'string' ? verdict.verdict : '';
  // They spoke, and nothing of it could be made out — the recogniser came
  // back empty. That is not a wrong answer and is not treated as one: on the
  // third real call an empty transcript was answered "Not quite. I heard yes."
  if (!said && unheard && !ruled) {
    if (unheard >= 2) {
      const on = next.kind === 'wrap' ? nextLine : `Let's keep going. ${onward}`;
      return { mode: 'exact', line: `I'm still not catching it. ${on}`, advances: true, reason: 'unheard' };
    }
    return { mode: 'exact', line: `Sorry, I didn't catch that. ${lineFor(step, language, { again: true })}`, advances: false, reason: 'unheard' };
  }
  const known = [];
  const listed = new Set();
  for (const item of [...taught, ...taughtSoFar(steps, current)]) {
    const key = fold(item && item.say);
    if (!key || listed.has(key)) continue;
    listed.add(key);
    known.push(item);
  }
  const asking = said ? looksLikeQuestion(said) : false;
  // (A meaning is right a letter out: "Lab." is what came back for "lamb".)
  // (And not when the word they said is in the meaning of another thing they
  // know: "beef" is not "beer" a letter out to someone who has had both.)
  const otherMeaning = () => {
    const wanted = new Set(fold(step.meaning).split(' '));
    const mine = fold(withoutFillers(said)).split(' ').filter((word) => word.length >= 3 && !wanted.has(word));
    return known.some((item) => fold(item.meaning) !== fold(step.meaning) && fold(item.meaning).split(' ').some((word) => mine.includes(word)));
  };
  const matches = said
    ? answersStep(step, said) || (english && !step.listen && !asking && meaningNear(said, step.meaning) && !confusedWith(step, said, known) && !otherMeaning())
    : false;
  // The judge wrote down what it heard. If that is the answer, it is the
  // answer, whatever the verdict says: "I heard fukuro wa irimasen. It's
  // fukuro wa irimasen" was said to a student who had answered in kanji.
  // (Not when it was ruled a question: "what is the difference between
  // sumimasen and gomen?" has the answer in it and is not one.)
  const heardRight = Boolean(
    verdict && verdict.heard && ruled !== 'question' && !looksLikeQuestion(verdict.heard) && answersStep(step, verdict.heard),
  );
  // And the other way: a judge that wrote down "gyuuni" and ruled it right
  // has contradicted itself. Something a letter or two away from the answer
  // is a near miss, whatever the ruling.
  let ruling = ruled;
  // What was heard is the answer give or take a letter of transcription: it
  // is given to them, whoever judged it — unless the letter is a different
  // little word, or what they said is another thing they have been taught.
  // A long word of vocabulary gets more room than a number does: see soundLimit.
  const wide = !english && !isCount(scene ? step.cue : step.meaning);
  const close = (text) => {
    if (!text || english || particleSlip(text, ask.answer) || confusedWith(step, text, known)) return false;
    const gap = soundGap(text, ask.answer);
    const mine = fold(ask.answer);
    const others = known.filter((item) => fold(item.say) !== mine && !variantKeys(ask.answer).includes(fold(item.say)));
    if (soundsLike(text, ask.answer)) {
      // A letter out — unless that makes it exactly another thing they know
      // ("mutsu" is "muttsu", not "mittsu" a letter out). Further off than a
      // letter or two it was found inside something longer, and stands.
      return gap === 0 || gap > 2 || !others.some((item) => soundGap(text, item.say) < gap);
    }
    if (!wide || !soundsLike(text, ask.answer, { wide: true })) return false;
    // Unless it is as near to another thing they know: then it may be that.
    return !others.some((item) => soundGap(text, item.say) <= gap);
  };
  const heardClose = Boolean(
    (said && !asking && close(said)) ||
    (verdict && verdict.heard && ruled !== 'question' && ruled !== 'aside' && !looksLikeQuestion(verdict.heard) && close(verdict.heard)),
  );
  // (Further off than that — a syllable gone — a "right" from the judge is
  // still a near miss: "gyuuni" is not "gyuuniku".)
  if (ruling === 'right' && !english && !heardRight && !heardClose && verdict.heard && nearMiss(verdict.heard, ask.answer)) ruling = 'wrong';

  // Asked what a phrase means, they said the phrase. That is not its meaning,
  // whoever judged it.
  if (english && said && !matches && contains(said, variantKeys(step.say))) {
    return { mode: 'exact', line: told, advances: true, reason: 'told' };
  }

  if (ruling === 'right' || heardRight || heardClose || (matches && !asking)) {
    // Only what is known to have been said is said back: a judge may have
    // passed a reply that was not the planned one.
    // (Said as a whole request where the plan had the bare word, it is the
    // request that is said back.)
    const asRequest = scene && step.tutor && said ? fitsScene(step, said, known) : null;
    const wantedWord = fold(step.expect).split(' ')[0];
    const theirs = Boolean(asRequest && asRequest.thing) && (
      (asRequest.things || []).some((entry) => fold(entry.word).split(' ')[0] === wantedWord) ||
      variantKeys(asRequest.say).some((form) => form.startsWith(wantedWord)));
    const planned = scene && (heardRight || heardClose || (matches && !asking))
      ? (theirs ? asRequest : { say: step.expect, meaning: step.cue })
      : null;
    const mine = planned || (scene ? null : { say: step.say, meaning: step.meaning, thing: step.thing });
    return {
      mode: 'exact', line: planned ? sceneRight(planned) : right, advances: true, reason: 'right', reply,
      ordered: planned ? requested(planned) : null,
      echo: Boolean((planned || step.build || (step.kind === 'recall' && step.use)) && requested(mine)),
    };
  }
  // Something they could not get twice is said once more to be heard, and
  // whatever they then say is let go: it is not asked for again.
  if (step.free && said && !asking && !givesUp(said) && !asksRepeat(said) && !bareYes(said) && !asksHowToSay(said)) {
    return { mode: 'exact', line: right, advances: true, reason: 'right', credit: false };
  }
  // "Is that everything?" — "hai." A plain yes or no answers a yes-or-no
  // question, whatever the plan had down for it: it was marked a miss, and
  // the student told to order pork.
  if (scene && step.tutor && !asking && said && /^(is|are|do|does|did|would|will|can|could|shall|may|anything|any)\b/i.test(String(step.meaning).trim())) {
    const plainly = fold(withoutFillers(said));
    if (/^(hai|iie)( |$)/.test(plainly) || /(?:^| )(ijou desu|daijoubu desu|kekkou desu|irimasen)(?: |$)/.test(plainly)) {
      return { mode: 'exact', line: sceneRight(null), advances: true, reason: 'right', reply, credit: false };
    }
    // Said in English, by someone who has not been given the words: they are
    // given them, and the conversation goes on.
    if (japanese && /^(no|nope|yes|yeah|yep)( |$)|(?:^| )(that s all|thats all|that is all|nothing else|no thanks?|no thank you)(?: |$)/.test(plainly)) {
      const yes = /^(yes|yeah|yep)( |$)/.test(plainly) && !/(?:^| )(that s all|thats all|that is all)(?: |$)/.test(plainly);
      const words = /^(no|nope)( |$)/.test(plainly) && !/(that s all|thats all|that is all|nothing else)/.test(plainly) ? '"iie" — no' : yes ? '"hai" — yes' : '"ijou desu" — that\'s all';
      return { mode: 'exact', line: `In Japanese that's ${words}. ${sceneRight(null)}`, advances: true, reason: 'right', reply, credit: false };
    }
    // "Do you want bell pepper?" — "piiman to tamanegi." Naming what they
    // want is an answer to being asked whether they want something.
    const things = japanese ? thingsNamed(said, known) : [];
    if (things.length) {
      const item = {
        say: `${things.map((entry) => entry.word).join(' to ')} o kudasai`,
        thing: listOf(things.map((entry) => lower(bare(entry.thing)))),
        things,
      };
      return { mode: 'exact', line: sceneRight(item), advances: true, reason: 'right', reply, credit: false, ordered: requested(item), echo: Boolean(requested(item)) };
    }
  }
  // In a role-play, something else they know that is the same kind of reply
  // is a good reply: water where the plan had beer, cash where it had card.
  // (Not in a moment where they speak first: "you want the waiter to come
  // over" is answered by one thing.)
  const fit = scene && step.tutor && !asking
    ? (said && fitsScene(step, said, known)) || (verdict && verdict.heard && ruled !== 'question' ? fitsScene(step, verdict.heard, known) : null)
    : null;
  if (fit) return { mode: 'exact', line: sceneRight(fit), advances: true, reason: 'right', reply, fit, ordered: requested(fit), echo: Boolean(requested(fit)) };

  // Given the word and asked to make the request, they said the word.
  if (step.build && !asking) {
    const alone = [said, verdict && verdict.heard].some((text) => text && loose(withoutFillers(text)) === loose(step.word));
    if (alone) {
      if (last) return { mode: 'exact', line: told, advances: true, reason: 'told' };
      // Not the whole sentence, yet: the one they made before, and the gap.
      const model = step.model && step.model.say && step.model.meaning ? step.model : null;
      const line = model
        ? `That's the word. ${capital(bare(model.meaning))} was "${model.say}". So how do you ask for ${lower(bare(step.thing))}?`
        : `That's the word. To ask for it: "${ask.answer}". Say it.`;
      return { mode: 'exact', line, advances: false, reason: 'wrong' };
    }
  }

  // "Yes." "OK." — to something that asked for a phrase. Asked again, plainly.
  if (said && !matches && !ruling && bareYes(said)) {
    return { mode: 'exact', line: lineFor(step, language, { again: true }), advances: false, reason: 'echo' };
  }

  // "Can we try that one more time?" asks for the line again. Put to the
  // tutor as a question, it was answered: "You were asked to say the full
  // yen phrase you learned, without changing it."
  if (said && !matches && !ruling && asksRepeat(said)) {
    return { mode: 'exact', line: `Sure. ${lineFor(step, language, { again: true })}`, advances: false, reason: 'echo' };
  }

  // Said in other words that a native speaker would use here: right. In a
  // role-play that is simply a good answer; elsewhere they hear the one that
  // was planned as well.
  // (A meaning given in other English words is simply the meaning.)
  if (ruling === 'alternative') {
    if (scene || english) return { mode: 'exact', line: right, advances: true, reason: 'right' };
    return { mode: 'exact', line: `${ack} That works too. I had "${ask.answer}". ${onward}`, advances: true, reason: 'alternative' };
  }

  const question = () => ({
    mode: 'question', heard: said, asked: ask.asked, after: lineFor(step, language, { again: true }), advances: false,
    // So that "the menu one" and "who is speaking?" can be answered truthfully.
    scene: scene ? step.scene || 'a role-play' : '',
    taught: known.slice(-8).map((item) => `${item.say} = ${item.meaning}`),
  });
  // "I don't know how to say thank you" is a question, not a surrender.
  if (said && asksHowToSay(said) && !matches) return question();

  if (step.quick && said && givesUp(said)) {
    return { mode: 'exact', line: quickTold, advances: true, reason: 'told', requeue: true };
  }
  if (said && givesUp(said)) {
    // (Asked what something means, they are told: there is nothing to "say".
    // "It's 7:30 am. Say it." was put to a student who had not caught a time.)
    if (last || english) return { mode: 'exact', line: told, advances: true, reason: 'told' };
    // In a role-play the first help is what to answer, not the words for it.
    if (scene && !given) return { mode: 'exact', line: hintLine(), advances: false, reason: 'told' };
    return { mode: 'exact', line: `It's "${ask.answer}". Say it.`, advances: false, reason: 'told' };
  }

  if (ruling === 'question') return question();
  // A remark — "oh good, that's the one I'll need" — is not an attempt. It is
  // not corrected, and it does not use up a try; the ask is simply made again.
  if (ruling === 'aside') {
    // "Ah, I know that one." Then they are not made to say it after the
    // tutor: it comes back a step or two on, to be recalled.
    if (step.kind === 'teach' && !step.build && /\b(know|knew|remember|got|had)\b[^.?!]*\b(that|this|it|these|those|one)\b/i.test(said)) {
      return { mode: 'exact', line: `OK. ${onward}`, advances: true, reason: 'known' };
    }
    return { mode: 'exact', line: `OK. ${lineFor(step, language, { again: true })}`, advances: false, reason: 'echo' };
  }
  if (!ruling && asking) {
    // It reads like a question. But "can I have some water?" is also what
    // "omizu o kudasai" means, and "is it sumimasen?" is an answer. Where the
    // words could be the answer, somebody has to look properly.
    if (!matches && !english) return question();
    return judgeTurn();
  }

  // In a role-play more than one thing they know may be a fair reply — water
  // when the plan said beer. Whether it is one is for the judge to say, so
  // nothing is called a mix-up here before it has.
  if (scene && !ruling && said) return judgeTurn();

  // A price they did not catch is said again, once: "Not quite. It means 400
  // yen" and on to the next thing left it never heard twice.
  if (english && step.listen && !last && ['wrong', 'unclear', 'other'].includes(ruling)) {
    return { mode: 'exact', line: `Not quite. Listen again: ${lineFor(step, language, { again: true })}`, advances: false, reason: ruling };
  }

  if (step.quick && said && (['wrong', 'unclear', 'other'].includes(ruling) || confusedWith(step, said, known))) {
    return { mode: 'exact', line: quickTold, advances: true, reason: ruling || 'other', requeue: true };
  }

  // (And once it has, a reply that does not fit gets the hint below, not a
  // lecture on which word is which: in a conversation nothing was mixed up.)
  let other = said && !scene ? confusedWith(step, said, known) : null;
  if (!other && !scene && ruling === 'other' && verdict.other) {
    const named = fold(String(verdict.other).split(' = ')[0]);
    other = known.find((item) => variantKeys(item.say).includes(named)) || null;
  }
  if (other) {
    if (english) {
      // Without the other word's Japanese: it may be the very next thing asked.
      return {
        mode: 'exact', advances: true, reason: 'other',
        line: `Not quite. "${step.say}" means ${lower(bare(ask.answer))}, not ${lower(bare(other.meaning))}. ${another}${onward}`,
      };
    }
    const mix = `"${other.say}" is ${lower(bare(other.meaning))}.`;
    if (tries >= 1) return { mode: 'exact', line: `${mix} ${told}`, advances: true, reason: 'other' };
    const wanted = step.kind === 'scene' ? step.cue : step.meaning;
    // Asked to recall it, they get a start rather than the whole thing, so
    // that the second try is still a recall and not an echo.
    if (step.kind === 'recall' && String(ask.answer).trim().split(/\s+/).length >= 3) {
      return {
        mode: 'exact', advances: false, reason: 'other',
        line: `${mix} ${capital(bare(wanted))} starts "${startOf(ask.answer)}". Try again.`,
      };
    }
    return {
      mode: 'exact', advances: false, reason: 'other',
      line: `${mix} ${capital(bare(wanted))} is "${ask.answer}". Say it once more.`,
    };
  }

  // Ruled wrong, or impossible to make out: one more go, then on.
  if (ruling === 'wrong' || ruling === 'unclear' || ruling === 'other' || ruling === 'alternative') {
    if (last) {
      // A meaning that was tried and missed is told so; one that was simply
      // not known is not.
      const line = english && ruling === 'wrong' ? `Not quite. ${told}` : told;
      return { mode: 'exact', line, advances: true, reason: ruling };
    }
    // In a role-play the first help is what to answer, in English; the words
    // themselves come only if that is not enough — and with them, if what
    // they said was a different thing they know, which thing it was.
    if (given) {
      let mixed = said ? confusedWith(step, said, known) : null;
      if (!mixed && ruling === 'other' && verdict.other) {
        const named = fold(String(verdict.other).split(' = ')[0]);
        mixed = known.find((item) => variantKeys(item.say).includes(named)) || null;
      }
      const lead = mixed ? `"${mixed.say}" is ${lower(bare(mixed.meaning))}. Here it's` : "It's";
      return { mode: 'exact', line: `${lead} "${ask.answer}". Say it.`, advances: false, reason: 'told' };
    }
    // (Not "Not quite": in a conversation that reads as "you may not say that".)
    if (scene) return { mode: 'exact', line: hintLine(), advances: false, reason: ruling };
    const line = ruling === 'wrong' ? correctionFor(verdict.heard || '', ask.answer) : `Once more: "${ask.answer}".`;
    return { mode: 'exact', line, advances: false, reason: ruling };
  }

  return judgeTurn();

  // What to answer, in English — saying so when something else they know
  // would do as well.
  function hintLine() {
    const shape = shapeOf(step.expect);
    const mine = fold(step.expect);
    const open = Boolean(shape) && known.some((item) => fold(item.say) !== mine &&
      (shapeOf(item.say) === shape || (shape === 'request' && shapeOf(item.say) === 'word')));
    const yesNo = Boolean(step.tutor) && /^(is|are|do|does|did|would|will|can|could|shall|may)\b/i.test(String(step.meaning).trim());
    if (yesNo && japanese) {
      const english = /\?$/.test(String(step.meaning || '').trim()) ? quoted(step.meaning) : `${quoted(step.meaning)}.`;
      // An order is not an answer to "is that everything?".
      if (requestParts(step.expect)) return `That meant ${english} Say "hai" for yes, or "iie" for no.`;
      return `That meant ${english} In ${language}, say: ${bare(step.cue)} — or just "hai" or "iie".`;
    }
    return lineFor({ ...step, open }, language, { hint: true });
  }

  // The app cannot tell. Somebody who can is asked; failing that the tutor
  // heard it and decides — between two turns that are already written.
  function judgeTurn() {
    return {
      mode: 'judge',
      heard: said,
      asked: ask.asked,
      answer: ask.answer,
      also: english ? [] : alsoRight(ask.answer),
      english,
      // What a judge needs to know about the step.
      kind: step.kind,
      say: step.kind === 'scene' ? step.expect : step.say,
      meaning: step.kind === 'scene' ? step.cue : step.meaning,
      // In a role-play: what was said to them, which their reply has to fit.
      line: scene ? step.tutor : '',
      lineMeaning: scene ? step.meaning : '',
      right,
      wrong: last ? told : `Not quite. I heard "…". It's "${ask.answer}". Say it once more.`,
      // When this is the last try both turns go on, so the lesson does too.
      advances: last ? true : null,
    };
  }
}

/**
 * The question put to the model that heard the student, before an answer the
 * recogniser could not write down is called wrong.
 * @param {{language?: string, answer?: string, meaning?: string}} input
 */
export function earPrompt({ language = 'the language', answer = '', meaning = '' } = {}) {
  return [
    `You are checking one spoken answer in a ${language} lesson, by ear. The speaker is a beginner with an English accent.`,
    `They were asked to say: "${answer}"${meaning ? ` (${bare(meaning)})` : ''}.`,
    'Listen to the recording of what they said.',
    'Answer yes if it was that — allowing for the accent, a pause, a filler word, a vowel a little off, or a polite word added.',
    'Answer no if it was something else, or only English.',
    'Answer nothing if there was no speech in it at all: a cough, a click, a breath, background sound.',
    'Reply with one word: yes, no or nothing.',
  ].join('\n');
}

/** What that came back as: 'yes', 'no', 'nothing' (no speech at all), or '' when it said none of them. */
export function hearsYes(text) {
  const said = fold(text);
  if (/^yes\b/.test(said)) return 'yes';
  if (/^nothing\b/.test(said)) return 'nothing';
  return /^no\b/.test(said) ? 'no' : '';
}

/**
 * How the voice is to say words of the language being taught, which reach it
 * spelled in Latin letters.
 * @param {string} language
 */
export function pronunciationOf(language) {
  const key = String(language || '').toLowerCase();
  if (key.startsWith('japanese')) {
    return 'Pronunciation: this is a line from a Japanese lesson. Every Japanese word in it is written in romaji and is spoken ' +
      'as a native Japanese speaker says it, never read as an English word: the vowels are a as in "father", i as in ' +
      '"machine", u as in "flute", e as in "bed", o as in "more", each one sounded and none of them silent ("de" is ' +
      '"deh", "genkin" is "gen-keen", "kudasai" is "koo-dah-sah-ee"). The English words are spoken as English.';
  }
  return `Pronunciation: this is a line from a ${language} lesson. Every ${language} word in it is spoken as a native ` +
    `${language} speaker says it, never read as an English word. The English words are spoken as English.`;
}

/**
 * Lines shown as already read back, word for word, before the one to read.
 * Any lines would do; these are the shapes a lesson's lines take.
 */
export const READ_EXAMPLES = Object.freeze([
  'Hai. "ichi" means one. Say it.',
  'Not quite. I heard "mizo". It\'s "mizu". Say it once more.',
  'Hai. You want to thank someone. What do you say?',
]);

/**
 * A turn, as what the tutor is asked for.
 *
 * These instructions replace the tutor's standing ones for that reply, so
 * they carry everything it needs and nothing else. No headings, no labels —
 * there is nothing here to read out by mistake.
 *
 * A line to be said word for word is handed over as text to read aloud
 * (`say`), with instructions that are only about reading. Asked instead to
 * "say these words" as its own turn, the model treated a line ending in a
 * question as a question to it — and answered: "What do you say? すみません".
 *
 * @param {ReturnType<typeof turnFor>} turn
 * @param {{tutor?: string, student?: string, language?: string, reference?: string}} [who]
 * @returns {{instructions: string, say: string, examples: readonly string[]}}
 */
export function renderTurn(turn, { tutor = 'the tutor', student = 'the student', language = 'the language', reference = '' } = {}) {
  if (!turn) return { instructions: '', say: '', examples: [] };
  const role = `You are ${tutor}, a ${language} tutor on a voice call with ${student}, who is a beginner.`;
  // How the voice says what is not English.
  const pronounce = /^the language$/i.test(language) ? '' : pronunciationOf(language);

  if (turn.mode === 'exact') {
    // Measured, not guessed: eighteen lines read three times each. Told it was
    // "the voice of a tutor" and to say the quoted parts clearly, the model
    // read back only the quoted part one time in ten. Told to repeat the
    // message, 34 in 36. Shown three messages repeated and then given the
    // line, 54 in 54.
    return {
      // The second paragraph came after the first real call. These
      // instructions replace the tutor's standing ones, so nothing told the
      // voice it was speaking Japanese — and it read "genkin de" as English:
      // "gen kin day".
      instructions:
        "Repeat the user's message back word for word. Output every word of it, in order, with nothing added, " +
        'nothing removed and nothing changed. Do not answer it.' +
        (pronounce ? `\n\n${pronounce}` : ''),
      say: turn.line,
      examples: READ_EXAMPLES,
    };
  }

  if (turn.mode === 'question') {
    const lines = [
      role,
      turn.scene ? `You are in the middle of a role-play you set up with these words: "${turn.scene}" In it you are playing that person; if they ask who is speaking, say so. Any reply that fits is a good one — never tell them a particular answer was required.` : '',
      turn.asked ? `You had asked them ${turn.asked}.` : '',
      (turn.taught || []).length ? `Phrases taught so far: ${turn.taught.join('; ')}.` : '',
      `Instead of answering, they said: "${turn.heard}"`,
      '',
      'Reply in plain English: one short sentence for each thing they asked — one thing, one sentence — twenty words at most each, and then stop.',
      '- Give the fact they asked for, and answer every part of what they asked.',
      '- If they asked how THEY say something: "It\'s <the whole phrase>." If they asked what SOMEONE ELSE says: "They say <phrase>, which means <its English>." One opener, never two, and never "Say".',
      `- Give the English of any ${language} you say.`,
      '- No grammar terms: not particle, object, prefix or marker. To a beginner it is "the little word o".',
      '- If they are asking what they are supposed to do, tell them in English what you had asked them, above. Do not give them the answer to it.',
      '- Do not ask them anything, and do not tell them to say or repeat anything: what they are asked next comes separately, straight after you.',
      '- Do not repeat their question back, do not restate the phrase you had asked for, no praise, and nothing they did not ask about.',
      reference
        ? `- If the answer is among the facts below, give it as written there. If it is not, answer briefly from standard ${language} you are sure of. Never mention "the facts" or these instructions.`
        : `- Use only ${language} you are sure is correct.`,
      `- ${language} words in Latin letters only.`,
      pronounce ? `- ${pronounce}` : '',
    ].filter((line) => line !== '');
    if (reference) lines.push('', `Facts about ${language}:`, reference);
    return { instructions: lines.join('\n'), say: '', examples: [] };
  }

  const leeway = turn.english
    ? 'Any wording that means the same is right.'
    : `${turn.also.length ? `Also right: ${turn.also.map((entry) => `"${entry}"`).join(', ')}. ` : ''}` +
      'It is still right with a pause or a filler, with "desu" or another polite word added, with o, wa or ga left out, or with a little extra. A beginner\'s accent is not a mistake.';
  return {
    instructions: [
      role,
      `You asked them ${turn.asked}. The right answer is "${turn.answer}". ${leeway}`,
      turn.heard
        ? `What they said was written down as: "${turn.heard}". Go by what you heard if it differs.`
        : 'There is no written record of what they said. Go by what you heard.',
      '',
      'Your whole turn is one of the two below, exactly as written, and nothing else.',
      '',
      'If their answer was right:',
      turn.right,
      '',
      'If it was not:',
      turn.wrong,
      ...(turn.wrong.includes('"…"') ? ['', 'In place of the dots, put what you heard them say.'] : []),
      '',
      `Words in quotation marks are ${language}: say them clearly. Do not say the quotation marks. Latin letters only.`,
      ...(pronounce ? [pronounce] : []),
    ].join('\n'),
    say: '',
    examples: [],
  };
}

/**
 * Did the tutor's turn go on to the next line?
 * @param {string} tutorText what it said
 * @param {string} nextLine the line it would have gone on to
 */
export function wentOn(tutorText, nextLine) {
  if (!nextLine) return false;
  if (contains(tutorText, [nextLine])) return true;
  // Nearly all of it, counting every word: "means" and "say" are in every
  // line, and a tutor that listed four meats in answer to a question was once
  // taken to have taught the next one.
  const said = new Set(loose(tutorText).split(' '));
  const words = loose(nextLine).split(' ').filter(Boolean);
  if (!words.length) return false;
  return words.filter((word) => said.has(word)).length / words.length >= 0.85;
}

/**
 * A line was begun and cut short. What is left of it to say?
 *
 * The closing line of a part once stopped five words early, was asked for
 * again, and was said again from the top: the student heard what they could
 * now say twice over. Only the rest is asked for.
 *
 * @param {string} tutorText what was said
 * @param {string} line the line it was given
 * @returns {string} the rest of the line, or '' when what was said is not its beginning
 */
export function remainderOf(tutorText, line) {
  const said = loose(tutorText).split(' ').filter(Boolean);
  const tokens = String(line || '').split(/\s+/).filter(Boolean);
  if (said.length < 4) return '';
  let at = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const words = loose(tokens[index]).split(' ').filter(Boolean);
    for (const word of words) {
      if (at >= said.length) break;
      if (said[at] !== word) return '';
      at += 1;
    }
    if (at >= said.length) {
      const rest = tokens.slice(index + 1);
      return rest.length >= 2 ? rest.join(' ') : '';
    }
  }
  return '';
}

/**
 * Did the tutor say every quoted phrase of its line as written? "kaado de"
 * came out as "kaardo de" and passed as nearly all of the line.
 * @param {string} tutorText
 * @param {string} line
 */
export function saysPhrases(tutorText, line) {
  const quotes = String(line || '').match(/"[^"]+"/g) || [];
  return quotes.every((quote) => contains(tutorText, [quote]));
}

/**
 * Take a line out of a script because the tutor will not say it.
 *
 * The alternative that was tried — assuming it had been said and moving on —
 * had the app telling the tutor "you last asked them to say hassen en" about a
 * phrase nobody had spoken, and then quizzing the student on it. A line that
 * is removed leaves the record true: what was last asked is still what was
 * last asked. When the line taught something, everything that depended on it
 * goes too, and the closing line stops claiming it.
 *
 * @param {ReturnType<typeof buildScript>} steps changed in place
 * @param {number} index
 * @returns {ReturnType<typeof buildScript>} the steps removed
 */
export function dropStep(steps, index) {
  if (!Array.isArray(steps)) return [];
  const step = steps[index];
  if (!step || step.kind === 'wrap') return [];
  const removed = steps.splice(index, 1);
  if (step.kind === 'teach') {
    const key = fold(step.say);
    for (let at = steps.length - 1; at >= index; at -= 1) {
      const later = steps[at];
      const depends =
        ((later.kind === 'recall' || later.kind === 'recognise') && fold(later.say) === key) ||
        (later.kind === 'scene' && fold(later.expect) === key);
      if (depends) removed.push(...steps.splice(at, 1));
    }
    const wrap = steps.find((entry) => entry.kind === 'wrap');
    if (wrap && Array.isArray(wrap.items)) {
      const gone = fold(step.meaning);
      wrap.items = wrap.items.filter((item) => fold(item) !== gone);
    }
  }
  return removed;
}

/** The items a script has got past teaching, for later review and role-play. */
export function taughtSoFar(steps, current) {
  const out = [];
  const seen = new Set();
  (Array.isArray(steps) ? steps : []).forEach((step, index) => {
    if (index > current) return;
    if (step.kind !== 'teach' && step.kind !== 'recall' && step.kind !== 'recognise') return;
    if (step.wordOnly) return;
    const key = fold(step.say);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({
      say: step.say,
      meaning: step.meaning,
      script: step.script || '',
      use: step.use || '',
      reply: step.reply || '',
      replyMeaning: step.replyMeaning || '',
      known: step.known === true,
    });
  });
  return out;
}
