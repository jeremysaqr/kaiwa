/**
 * src/planner.js
 *
 * Writes the material for one part of a lesson, ahead of time.
 *
 * The voice model is small and is busy talking. Asked to choose its own
 * material mid-conversation it taught "kono wa ramen resutoran desu", "oki"
 * for okay, and "platformu" for a station platform — and defended the last one
 * when the student questioned it. Where it had been handed the words (food,
 * numbers), every one was right.
 *
 * So it is no longer asked to choose. A text model does it here, once per part,
 * with no latency pressure and with the language's reference in front of it:
 * four things worth being able to say, what each means, and a short role-play
 * that needs them. The app turns that into a script (shared/script.js) and the
 * voice model reads it out.
 *
 * A failure here costs nothing but the script: the tutor falls back to its
 * general teaching rules, as it worked before plans existed.
 */

import { MEMORY_MODEL, PLAN_MODEL } from './config.js';
import { chatJson, OpenAIError } from './openai.js';
import { fold, requestParts, sanitizePlan } from '../public/shared/script.js';
import { containsJapanese, toRomaji } from '../public/shared/romaji.js';
import { isJapanese } from '../public/shared/profile.js';
import { MAX_VOCAB } from '../public/shared/vocab.js';

/** New items in a part, by how much the student can already carry. */
function itemCount(level) {
  if (/absolute/i.test(level)) return 3;
  if (/^beginner$/i.test(level)) return 4;
  return 5;
}

/**
 * Long vowels the planner wrote short, put back from the word's own writing.
 *
 * "piman" was taught, said and saved for ピーマン. Where a word is written in
 * katakana with a long-vowel mark, how it is said is not in doubt: the mark is
 * a doubled vowel ("piiman", "raamen", "koohii").
 *
 * @param {string} script the phrase as normally written
 * @returns {[string, string][]} pairs of the short spelling and the right one
 */
export function longVowelFixes(script) {
  const out = [];
  for (const run of String(script || '').match(/[ァ-ヺー]{2,}/g) || []) {
    if (!run.includes('ー')) continue;
    const full = fold(toRomaji(run)).replace(/ /g, '');
    const short = full.replace(/([aiueo])\1+/g, '$1');
    if (full && short && full !== short && /^[a-z]+$/.test(full)) out.push([short, full]);
  }
  return out;
}

/** @param {unknown} list @param {number} max */
function lines(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((entry) => (typeof entry === 'string' ? entry : entry && entry.say ? `${entry.say} = ${entry.meaning}` : ''))
    .map((entry) => entry.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-max);
}

/**
 * The reference sections that bear on this lesson: everything the lesson or
 * any of its parts declares, plus whatever the student's chosen subject maps
 * to. Unlike the tutor's prompt this is not capped at two — the planner has
 * the time and the context to read all of it.
 *
 * @param {Record<string, any>} skill
 * @param {Record<string, any>} state
 * @param {Record<string, string>} reference
 * @param {Record<string, string[]>} topics
 * @returns {string[]}
 */
export function relevantReference(skill, state, reference = {}, topics = {}) {
  const wanted = [];
  const add = (key) => {
    if (typeof key === 'string' && reference[key] && !wanted.includes(key)) wanted.push(key);
  };
  const phase = (skill?.phases || []).find((entry) => entry.id === state?.phase);
  for (const key of phase?.reference || []) add(key);
  for (const key of skill?.reference || []) add(key);
  for (const value of Object.values(state?.runtime_inputs || {})) {
    const subject = ` ${String(Array.isArray(value) ? value.join(' ') : value ?? '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim()} `;
    if (subject.trim().length < 2) continue;
    for (const [section, words] of Object.entries(topics || {})) {
      if (Array.isArray(words) && words.some((word) => subject.includes(` ${word} `))) add(section);
    }
  }
  return wanted.map((key) => reference[key]);
}

/**
 * @param {{language: string, level: string, skill: Record<string, any>, phase: Record<string, any>,
 *          mode: string, subject: string, facts: string[], taught: any[], known: string[]}} input
 */
export function buildPlanPrompt({ language, level, skill, phase, mode, subject, facts, taught, known, requests = [], scenes = [] }) {
  const roleplay = mode === 'roleplay';
  const count = roleplay ? 0 : itemCount(level);
  const sceneLines = roleplay ? 5 : 3;
  // How much of a role-play the part has (see lesson-schema.js).
  const rolePlay = roleplay ? 'full' : phase.role_play || 'full';
  const used = rolePlay !== 'full' ? [] : (Array.isArray(scenes) ? scenes : [])
    .map((entry) => String(entry || '').replace(/\s+/g, ' ').trim().slice(0, 160))
    .filter(Boolean)
    .slice(-12);
  const script = isJapanese(language)
    ? 'Hepburn romaji only — no kanji, hiragana or katakana — with long vowels written out (ookii, raamen, menyuu, piiman).'
    : `${language}, spelled normally.`;

  const taughtLines = lines(taught, 30);
  // All of it: planPhase marks an item known if it is anywhere in the list,
  // so the planner is shown every word the code will treat as known.
  const knownLines = lines(known, MAX_VOCAB);
  const asked = (Array.isArray(requests) ? requests : [])
    .map((entry) => String(entry || '').replace(/\s+/g, ' ').trim().slice(0, 200))
    .filter(Boolean)
    .slice(-4);

  const sceneFull = `scene
- A short role-play that needs the items. "setup" is one sentence the tutor says to the student, in English, to set the scene, in the first person: "I'm the waiter at a ramen shop and you have just walked in."
- ${roleplay ? `Exactly ${sceneLines} lines.` : `Three lines, or four if every one is something that person really says. A line you are not certain of is left out — two good lines are better than three with one invented.`} "tutor" is what the person the tutor is playing says to the student, in ${language}: a question or remark that calls for an answer. Where FACTS gives what staff say, use those lines as written. Short enough for a "${level}" student to catch. It is never one of the student's own items. "meaning" is its English.
- "expect" is what the student should answer, in ${language}: exactly one of this part's items, or something from ALREADY TAUGHT, written exactly as it appears there. Never something they have not been given, and never a fact only they could know (their age, their room number).
- The answer has to make sense as a reply to the tutor's line: a yes-or-no question is not answered with a bare noun, and a greeting such as "welcome" is not something a customer answers.
- A line may state a price or a time instead of asking something ("sen nihyaku en desu" — it is 1200 yen): the student is asked what they heard and then answers it ("kore o kudasai"). Its "meaning" gives the figure in digits, and the figure is a different one from any item.
- The tutor's line never contains its own answer, in either language. Telling the student "your number is 78" and asking them to say 78 is an echo, not a role-play.
- When the items are single words, each tutor line is an open question that any of them could answer — "nani ni nasaimasu ka" (what will you have?), "hoka ni gochuumon wa gozaimasu ka" (anything else?) — never a remark, and never a line that names one of the items.
- A narrow question comes before an open one. "onomimono wa" (something to drink?) is asked first and "gochuumon wa" (your order?) after it: an open question can be answered with anything the student knows, and a narrow one asked afterwards may then ask for what they have just said.
- Staff lines are what staff really say to a customer. A waiter does not ask "what do you want to eat?" in the plain form; a clerk states a price, the customer does not.
- The lines follow one another as one real exchange would, in order, and the student's answers do not contradict each other (they do not order a beer and then get asked what they want to drink). Each line gets a different answer, and between them the lines use as many of this part's items as they can. No two lines are the same question.
- "reply" is what the same person says back once the student has answered: a short, natural acknowledgement that fits whichever sensible answer was given ("kashikomarimashita", "kochira e douzo", "shoushou omachi kudasai"). "reply_meaning" is its English ("certainly", "this way, please", "one moment, please"). It is never one of the student's items.
- "tutor" and "expect" are written the same way as "say": ${script}`;
  const sceneRules = rolePlay === 'none'
    ? `scene
- This part has no role-play. Return "scene": { "setup": "", "lines": [] }.`
    : rolePlay === 'single'
      ? `scene
- One exchange, not a conversation. "setup" is one sentence the tutor says to the student, in English, to set the scene, in the first person: "I'm the waiter at a restaurant and you are ready to order."
- Exactly one line. "tutor" is the open question that person would really ask at that moment, in ${language}, which ANY of this part's items — or anything ALREADY TAUGHT — would answer: for food and drink, "nani ni nasaimasu ka" (what will you have?). "meaning" is its English, ending in a question mark.
- Never a yes-or-no question, never "anything else?", never "which would you like?", and never a line that names one of the items or contains its own answer.
- "expect" is what the student could answer, in ${language}: exactly one of this part's items, or something from ALREADY TAUGHT, written exactly as it appears there.
- "reply" is what the same person says back once the student has answered: a short, natural acknowledgement that fits whichever answer was given ("kashikomarimashita"). "reply_meaning" is its English ("certainly"). It is never one of the student's items.
- "tutor" and "expect" are written the same way as "say": ${script}`
      : sceneFull;

  return `You write the material for one part of a spoken ${language} lesson.

A voice tutor will teach exactly what you write to a student whose level is "${level}". The student will say these things to real people, so every item must be correct, natural ${language} that a native speaker would really use in this situation. A wrong word here is taught as right.

LESSON: ${skill.name} — ${skill.description}
THIS PART: ${phase.name} — ${phase.purpose}
${phase.instructions.length ? `What this part should cover:\n${phase.instructions.map((line) => `- ${line}`).join('\n')}\n` : ''}${subject ? `\nTHE STUDENT ASKED TO WORK ON: ${subject}\n` : ''}${asked.length ? `\nDURING THE CALL THE STUDENT SAID — their own words, newest last:\n${asked.map((line) => `- "${line}"`).join('\n')}\nWherever this part allows it, choose items that give them what they asked for. If they asked how to say something that fits this part, it is the first item.\n` : ''}${facts.length ? `\nFACTS — verified ${language}. Take words and phrases from here whenever they fit, exactly as written. Do not contradict them.\n\n${facts.join('\n\n')}\n` : ''}
ALREADY TAUGHT IN THIS LESSON — do not teach these again. Use them freely in the role-play.
${taughtLines.length ? taughtLines.map((line) => `- ${line}`).join('\n') : '(nothing yet)'}

THE STUDENT ALREADY KNOWS, from earlier calls:
${knownLines.length ? knownLines.map((line) => `- ${line}`).join('\n') : '(nothing on file)'}
${used.length ? `\nALREADY SAID TO THE STUDENT IN THIS LESSON'S ROLE-PLAYS — this role-play does not open on any of these, and uses at most one of them:\n${used.map((line) => `- ${line}`).join('\n')}\n` : ''}
Return JSON in exactly this shape:

{
  "items": [ { "say": "", "script": "", "meaning": "", "use": "", "reply": "", "reply_meaning": "", "note": "", "known": false } ],
  "scene": { "setup": "", "lines": [ { "tutor": "", "meaning": "", "expect": "", "reply": "", "reply_meaning": "" } ] }
}

WHO SAYS WHAT
- "items" are the STUDENT's lines: things the student says to someone.
- "scene.lines[].tutor" are the OTHER person's lines: what the waiter, clerk or receptionist says to the student. Staff do not ask for the menu, the bill or a ticket — the customer does — so those never appear as a tutor line.
- Each tutor line is something the student has to reply to, and "expect" is that reply.

RULES

items
${roleplay
    ? '- Return an empty list. This part teaches nothing new; it uses what was already taught.'
    : `- Exactly ${count} items. Each is one thing worth being able to say: a word, or a short phrase said in one breath — six words at most.
- Every item is something the STUDENT says. What other people say TO the student — a waiter's question, a clerk's reply — is not an item. It belongs in the role-play, as a "tutor" line.
- Things a visitor actually says. Not sentences that describe objects ("this is a table", "this is a menu").
- If THE STUDENT ASKED TO WORK ON something, every item falls inside it, in the terms they used. If they named more than one kind of thing, alternate between the kinds, so that each kind appears in the first two items.
- Where two wordings are equally normal ("... o kudasai" and "... o onegaishimasu"), pick one and use it for every item in this part — the one ALREADY TAUGHT uses, if it uses one.
- When several items are the same request with a different thing asked for ("biiru o kudasai", "omizu o kudasai"), put them one after another and write each "meaning" as the thing and then "please" ("a beer, please", "water, please"). The student is taught the first one whole and makes the others from the word, so the first one's "note" says what the asking part does ("O kudasai is how you ask for something.").
- No item whose ${language} is the same word as its English ("tomato" for tomato): it teaches nothing.
- When an item is a number, a price or a time, its "meaning" is the figure: "47", "600 yen", "3:10".
- Complete and sayable as written. No placeholders such as X or "...": put a real word in ("negi nuki de onegaishimasu", not "X nuki de onegaishimasu").
- Order them so the first is the most useful, and later ones build on earlier ones where they can.
- Nothing from ALREADY TAUGHT IN THIS LESSON, in the same words or different ones.
- "known" is true when THE STUDENT ALREADY KNOWS lists that phrase, or lists a range that covers it ("numbers up to 100" covers 47). A known item is asked for instead of taught. If everything this part should cover is already known, return only two items, both marked known, and no scene lines: a quick check is the right lesson for it.`}
- "say": ${script}
- "script": the same phrase as it is normally written in ${language} (for Japanese: kanji and kana, as on a sign or in a text message — "二人です"). The student never sees it; it is how the app recognises their answer.
- "meaning": plain English, a few words — what the speaker means by it. Lower case unless it is a name.
- "use": the moment the student would say it, as one short English sentence addressed to them: "You want the waiter to come over." "You want to pay by card." It names what they want plainly — never "this", "that" or "it" — and points to this item and no other in this part. "" for a bare word, a number, a price or a time, where no moment singles it out. No two items share a "use".
- "reply": when the item has a "use", what the person they say it to would say straight back, in ${language}: short, natural and certain ("hai, shoushou omachi kudasai" when called over; "kashikomarimashita" to an order; "hai, douzo" when asked for something). "reply_meaning" is its English ("yes, one moment please"; "certainly"; "here you are"). Both "" when there is no "use", or when you are not certain what would be said. When the item asks a price or a time, the reply states one, in words, built from the FACTS ("sen nihyaku en desu"), and its "reply_meaning" is the figure alone ("1200 yen", "3:30"): the student is asked what they heard, so use a figure a "${level}" student can catch.
- "note": one short true sentence the tutor will say out loud after the meaning, under twelve words. Either what would otherwise trip them up ("The h becomes b.") or what makes it stick — what its parts mean ("gyuu is cow, niku is meat."). Only what you are certain of, and never an instruction to the tutor or a label such as "loanword". Otherwise "".
- When the subject is a family of words that share a part (kinds of meat ending in niku), say what the shared part means in the first item's note.
- A note stands on its own: it names the word it is about, and does not assume anything the student has not been told on this call. A note about a sound change gives the whole word ("Roku and hyaku squeeze together: roppyaku."), never a fragment ("it becomes ppyaku"). It does not say the meaning again.

${sceneRules}

Before you return, reread every "say", "tutor" and "expect": each word must be a real ${language} word in its standard spelling. Fix or replace any that is not.

Return only the JSON object.`;
}

/**
 * Have the plan's Japanese checked by a model with nothing else to do.
 *
 * Deliberately one-sided: only what is called wrong is removed, and a failure
 * to check removes nothing — the plan is used as it stands. What is already
 * in the language's own reference is not put to it at all: the first version
 * struck out "nanmei-sama desu ka", which is the reference's own line.
 *
 * @param {{language: string, level: string, plan: ReturnType<typeof sanitizePlan>, ask: (messages: any[]) => Promise<any>}} input
 * @returns {Promise<{items: Set<string>, lines: Set<string>, replies: Set<string>}>}
 */
export async function proofread({ language, level, plan, ask, vetted = () => false }) {
  const none = { items: new Set(), lines: new Set(), replies: new Set(), notes: new Set() };
  /** @type {{kind: string, text: string, meaning: string, who: string}[]} */
  const all = [];
  const entries = { push: (entry) => { if (!vetted(entry.text)) all.push(entry); } };
  for (const item of plan.items) {
    // Numbers, prices and times are built by rule from the reference, and a
    // proofreader asked about them struck out "yonhyaku en".
    if (/^\d/.test(item.meaning.trim())) continue;
    entries.push({ kind: 'items', text: item.say, meaning: item.meaning, who: 'the visitor' });
    // A note is said aloud as fact: "Irai means 'want'" taught a word that is
    // not the one in "iranai desu" (iru, need).
    if (item.note) {
      entries.push({
        kind: 'notes', text: item.note, meaning: `a true explanation, in English, of "${item.say}" (${item.meaning}) — every word in it as it is used there`,
        who: 'the tutor, to the learner',
      });
    }
    if (item.reply) {
      entries.push({
        kind: 'replies', text: item.reply, meaning: item.replyMeaning,
        who: `the person the visitor has just said "${item.say}" to, in reply`,
      });
    }
  }
  for (const line of plan.scene.lines) {
    // The pair is judged together: nobody is handed a menu and then asks for it.
    entries.push({
      kind: 'lines', text: line.tutor, meaning: line.meaning,
      who: `the other person in the scene, to the visitor, who is expected to answer "${line.expect}"`,
    });
    if (line.reply) {
      entries.push({
        kind: 'replies', text: line.reply, meaning: line.replyMeaning,
        who: `the other person in the scene, after the visitor has answered "${line.expect}"`,
      });
    }
  }
  if (!all.length) return none;
  try {
    const answer = await ask(buildProofPrompt({ language, level, setup: plan.scene.setup, entries: all }));
    const bad = Array.isArray(answer?.wrong) ? answer.wrong : [];
    const out = { items: new Set(), lines: new Set(), replies: new Set(), notes: new Set() };
    for (const number of bad) {
      const entry = all[Number(number) - 1];
      if (entry) out[entry.kind].add(fold(entry.text));
    }
    return out;
  } catch {
    return none;
  }
}

/** @param {{language: string, level: string, setup: string, entries: {text: string, meaning: string, who: string}[]}} input */
export function buildProofPrompt({ language, level, setup, entries }) {
  const romanised = isJapanese(language) ? ' They are written in Hepburn romaji with long vowels written out (ookii, raamen).' : '';
  return [
    {
      role: 'system',
      content: `You are a careful native ${language} proofreader. These lines are about to be taught to a "${level}" learner, or said to them in a role-play, so a wrong one will be learned as right.${romanised}
${setup ? `The scene: ${setup}\n` : ''}
${entries.map((entry, index) => `${index + 1}. "${entry.text}" — meant as: ${entry.meaning} — said by ${entry.who}`).join('\n')}

A line is WRONG if any word in it is not a real ${language} word or is misspelled, if the grammar is wrong, if it does not mean what it is meant as, or if the person named would not really say it at that point (a waiter asking the customer what they recommend, or what is in the dish; staff handing over a menu and the visitor then asking for the menu; a line asking for something the visitor's answer to an earlier line has already given, such as "and to drink?" straight after they ordered a beer; a line that asks again what an earlier line asked, such as "your order?" after "what will you have?"; a yes-or-no question whose expected answer is not a yes or a no; a reply that does not follow from what was just said; a made-up polite form). A line that is correct and natural is fine, even if another wording exists or it is more polite than strictly needed. Mark a line wrong only when you are sure.

Return JSON: {"wrong": [numbers of the wrong lines]} — an empty list if all are fine. Return only the JSON object.`,
    },
    { role: 'user', content: 'Check them.' },
  ];
}

/** The most a drill asks for in one go. */
const DRILL_MAX = 15;

/**
 * Prompt for choosing which of the student's own words a drill is on.
 * @param {{language: string, subject: string, words: {say: string, meaning: string}[]}} input
 */
export function buildDrillPrompt({ language, subject, words }) {
  return `A student of ${language} wants to be drilled on: ${subject}

These are the words they already have, numbered:
${words.map((item, index) => `${index + 1}. ${item.say} = ${item.meaning}`).join('\n')}

Return JSON: {"pick": []}

"pick" is the numbers of every word above that falls inside what they asked to be drilled on, in the terms they used. Only numbers from the list. If none fit, an empty list.

Return only the JSON object.`;
}

/**
 * The material for a drill: words the student already has, never new ones.
 *
 * A model only chooses, by number, which of the candidates fit the subject.
 * Anything it returns that is not one of those numbers is ignored, so it
 * cannot add a word. With no subject, the newest words are drilled.
 *
 * @param {{language?: string, subject?: string, candidates?: any[], model?: string}} input
 */
export async function planDrill({ language = 'the target language', subject = '', candidates = [], model = '' }) {
  const words = [];
  const seen = new Set();
  for (const entry of Array.isArray(candidates) ? candidates : []) {
    const say = String(entry?.say || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const meaning = String(entry?.meaning || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const key = fold(say);
    if (!say || !meaning || !key || seen.has(key)) continue;
    seen.add(key);
    words.push({ say, meaning, script: String(entry?.script || '').trim().slice(0, 40), known: true });
  }
  const plan = (items) => ({ ok: true, plan: { items, scene: { lines: [] }, drill: true }, error: null });
  const topic = String(subject || '').trim();
  if (!words.length) return plan([]);
  if (!topic) return plan(words.slice(-DRILL_MAX));
  try {
    const answer = await chatJson({
      model: model || MEMORY_MODEL,
      temperature: 0,
      maxTokens: 200,
      timeoutMs: 15000,
      messages: [
        { role: 'system', content: buildDrillPrompt({ language, subject: topic, words }) },
        { role: 'user', content: 'Which of these fit?' },
      ],
    });
    const picked = [...new Set((Array.isArray(answer?.pick) ? answer.pick : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value >= 1 && value <= words.length))];
    return plan(picked.slice(0, DRILL_MAX).map((value) => words[value - 1]));
  } catch (error) {
    return { ok: false, plan: null, error: error instanceof OpenAIError ? error.message : 'The drill could not be put together.' };
  }
}

/**
 * Plan one part of a lesson.
 *
 * @param {{skill: Record<string, any>, state?: Record<string, any>, phaseId?: string, language?: string,
 *          level?: string, reference?: Record<string, string>, topics?: Record<string, string[]>,
 *          taught?: any[], known?: string[]}} input
 * @returns {Promise<{ok: boolean, plan: ReturnType<typeof sanitizePlan>|null, error: string|null}>}
 */
export async function planPhase({
  skill,
  state = {},
  phaseId = '',
  language = 'the target language',
  level = 'Beginner',
  reference = {},
  topics = {},
  taught = [],
  known = [],
  requests = [],
  scenes = [],
  candidates = [],
  model = '',
}) {
  if (!skill || typeof skill !== 'object') return { ok: false, plan: null, error: 'No lesson is running.' };
  const phase = (skill.phases || []).find((entry) => entry.id === (phaseId || state.phase));
  if (!phase) return { ok: false, plan: null, error: 'That part of the lesson does not exist.' };

  const mode = phase.mode || 'teach';
  if (mode === 'talk' || mode === 'review') return { ok: true, plan: null, error: null };

  const subject = Object.values(state.runtime_inputs || {})
    .map((value) => (Array.isArray(value) ? value.join(', ') : String(value ?? '')))
    .map((value) => value.trim())
    .filter(Boolean)
    .join('; ');
  if (mode === 'drill') return planDrill({ language, subject, candidates, model });

  const facts = relevantReference(skill, { ...state, phase: phase.id }, reference, topics);
  const messages = [
    {
      role: 'system',
      content: buildPlanPrompt({
        language,
        level,
        skill,
        phase,
        mode,
        subject,
        facts,
        taught,
        known,
        requests,
        scenes,
      }),
    },
    { role: 'user', content: 'Write the material for this part.' },
  ];

  // The planner's model can be set separately from the bookkeeping model: this
  // is the one place a stronger model changes what the student is taught. If
  // the account cannot use it, the bookkeeping model does the job instead.
  const preferred = model || PLAN_MODEL || MEMORY_MODEL;
  const ask = (name) => chatJson({ model: name, temperature: 0.3, maxTokens: 900, timeoutMs: 25000, messages });

  try {
    let answer;
    try {
      answer = await ask(preferred);
    } catch (error) {
      const refused = error instanceof OpenAIError && [400, 403, 404].includes(error.status);
      if (!refused || preferred === MEMORY_MODEL) throw error;
      answer = await ask(MEMORY_MODEL);
    }

    // Anything that came back in a script the student cannot read is dropped,
    // not converted. Converting kanji to romaji mechanically gets word
    // boundaries and readings wrong often enough to produce lines like
    // "nani kao sagashidesuka" — which would then be taught.
    const unreadable = (text) => isJapanese(language) && containsJapanese(String(text || ''));
    const readable = answer && typeof answer === 'object' ? { ...answer } : {};
    readable.items = (Array.isArray(readable.items) ? readable.items : []).filter(
      (item) => item && !unreadable(item.say),
    );
    if (readable.scene && typeof readable.scene === 'object') {
      readable.scene = {
        ...readable.scene,
        lines: (Array.isArray(readable.scene.lines) ? readable.scene.lines : []).filter(
          (line) => line && !unreadable(line.tutor) && !unreadable(line.expect),
        ),
      };
    }
    const plan = sanitizePlan(readable);
    // A long vowel the planner wrote short ("piman" for ピーマン) is put right
    // everywhere the word appears, before it is taught, said or saved.
    if (isJapanese(language)) {
      const fixes = plan.items.flatMap((item) => longVowelFixes(item.script));
      const respell = (text) => fixes.reduce((out, [short, full]) => out.replace(new RegExp(`\\b${short}\\b`, 'gi'), full), String(text || ''));
      if (fixes.length) {
        for (const item of plan.items) {
          item.say = respell(item.say);
          item.reply = respell(item.reply);
          item.note = respell(item.note);
        }
        for (const line of plan.scene.lines) {
          line.tutor = respell(line.tutor);
          line.expect = respell(line.expect);
          line.reply = respell(line.reply);
        }
      }
    }
    // A role-play line that is really one of the student's own phrases, or one
    // with nothing for the student to answer, would have the tutor reading the
    // student's part. Drop those rather than teach from them.
    const taughtSay = new Set(lines(taught, 60).map((line) => fold(line.split(' = ')[0])));
    const taughtMeaning = new Set(lines(taught, 60).map((line) => fold(line.split(' = ')[1] || '')).filter(Boolean));
    const knownText = (Array.isArray(known) ? known : []).map((entry) => ` ${fold(String(entry))} `);

    // Nothing with a placeholder in it, and nothing this lesson already taught.
    plan.items = plan.items.filter((item) => {
      if (/\bX\b|\.\.\.|…/.test(item.say)) return false;
      // "tomato" means tomato.
      if (fold(item.say) === fold(item.meaning)) return false;
      return !taughtSay.has(fold(item.say)) && !taughtMeaning.has(fold(item.meaning));
    });
    for (const item of plan.items) {
      // A label is not something to say out loud, and a situation that gives
      // the phrase away is not a question.
      if (/\b(loan ?word|normal word|common word|formal|informal)\b/i.test(item.note) && item.note.split(' ').length <= 4) item.note = '';
      if (/^(never|do not|don't|avoid|always)\b/i.test(item.note) || /\benglish\b[^.]*\b(not used|is not)\b/i.test(item.note) || /\bpronounc/i.test(item.note)) item.note = '';
      // "Tamanegi means onion; tama is ball, negi is green onion." The first
      // half has just been said.
      const restated = new RegExp(`^\\W*${fold(item.say).replace(/ /g, '\\W+')}\\W+(means|is)\\W+${fold(item.meaning).replace(/ /g, '\\W+')}\\W*`, 'i');
      item.note = item.note.replace(restated, '').trim();
      if (item.note) item.note = `${item.note.charAt(0).toUpperCase()}${item.note.slice(1)}`;
      if (!item.use || unreadable(item.reply) || !item.replyMeaning) { item.reply = ''; item.replyMeaning = ''; }
      // A note that only says the meaning again ("Futari means two people")
      // is a second sentence with nothing in it.
      const given = new Set(`${fold(item.say)} ${fold(item.meaning)} means mean is the a an for word normal usual common this it`.split(' '));
      if (item.note && fold(item.note).split(' ').every((word) => given.has(word))) item.note = '';
      // "You want to ask if a dish has this meat" was asked for beef, and
      // again for chicken. A situation that points at nothing is not one.
      if (/\b(this|that|these|those|it)\b/i.test(item.use)) item.use = '';
      // Nor does one that leans on what came before it: "You want to buy the
      // thing you asked about" was put to a student in a later part, where
      // nothing had been asked about.
      if (/\b(asked about|you just|just (?:said|asked|ordered|heard|seen)|earlier|a moment ago)\b/i.test(item.use)) item.use = '';
      // A figure is asked for as a figure: "You are told the price of an item.
      // What do you say?" was put for three different prices.
      if (/^\d/.test(item.meaning.trim())) item.use = '';
    }
    // And a situation that two items share singles out neither.
    const uses = new Map();
    for (const item of plan.items) if (item.use) uses.set(fold(item.use), (uses.get(fold(item.use)) || 0) + 1);
    for (const item of plan.items) if (item.use && uses.get(fold(item.use)) > 1) item.use = '';
    // "Known" has to be earned: the phrase is on file for this student, or it
    // is a number and a range of numbers is.
    const knowsNumbers = knownText.some((entry) => /\bnumbers?\b/.test(entry));
    for (const item of plan.items) {
      // On file as itself, or as part of something longer that is: "sanbyaku
      // en" for a student whose record has "sanbyaku gojuu en".
      const words = fold(item.say).split(' ');
      // A figure is on file when each word of it is, wherever and however
      // spaced: "kyuuhyaku gojuu en" for a record with "kyuu hyaku en" and
      // "sanbyaku gojuu en". Hundreds were taught as new, with a note on what
      // hyaku means, to a student who had them.
      const figure = /^\d/.test(item.meaning.trim());
      const everything = knownText.join(' ').replace(/ /g, '');
      const onFile = knownText.some((entry) => entry.includes(` ${fold(item.say)} `) || words.every((word) => entry.includes(` ${word} `))) ||
        (figure && words.every((word) => word.length >= 2 && everything.includes(word)));
      const coveredNumber = knowsNumbers && /^\d[\d,]*$/.test(item.meaning.trim()) && Number(item.meaning.replace(/,/g, '')) <= 100;
      // On file is on file, whether or not the planner noticed: a student whose
      // record says "numbers up to 100" was opened on "yonjuu nana means 47".
      item.known = onFile || coveredNumber;
    }
    // A note that explains a word the student has on file explains nothing:
    // "Yon is four. Hyaku is hundred." was said to one who had both.
    const fileWords = new Set(knownText.join(' ').split(' ').filter(Boolean));
    for (const item of plan.items) {
      if (!item.note) continue;
      const clauses = item.note.replace(/[.!\s]+$/, '').split(/\s*[,;.]\s+/).filter(Boolean);
      const fresh = clauses.filter((clause) => {
        const head = /^(\S+) (?:is|means)\b/i.exec(clause.trim());
        return !(head && fileWords.has(fold(head[1])));
      });
      if (fresh.length !== clauses.length) item.note = fresh.length ? `${fresh.join('. ')}.` : '';
    }
    // One way of asking, kept to: a request already taught as "… o
    // onegaishimasu" is not followed by "… o kudasai" taught as if it were
    // new. Either is right; with one, the student builds the next request
    // from the last ("Ask for a beer, the way you asked for the menu").
    const frame = [...lines(taught, 60)].reverse().map((line) => requestParts(line.split(' = ')[0])?.frame).find(Boolean);
    if (frame) {
      const reframe = (say) => {
        const parts = requestParts(say);
        return parts && parts.frame !== frame ? String(say).replace(/(kudasai|onegaishimasu)([.!]?)$/i, `${frame}$2`) : say;
      };
      for (const item of plan.items) {
        const changed = reframe(item.say);
        if (changed === item.say) continue;
        for (const line of plan.scene.lines) if (fold(line.expect) === fold(item.say)) line.expect = changed;
        item.say = changed;
        item.script = String(item.script || '').replace(/ください$/, 'お願いします').replace(/下さい$/, 'お願いします');
        if (frame === 'kudasai') item.script = String(item.script).replace(/お願いします$/, 'ください');
        if (/\b(kudasai|onegaishimasu)\b/i.test(item.note)) item.note = '';
      }
    }
    // Everything here is already known: a quick check of two is the whole part.
    if (plan.items.length && plan.items.every((item) => item.known)) {
      plan.items = plan.items.slice(0, 2);
      plan.scene.lines = [];
    }

    // A role-play line is kept only if the student has been given its answer:
    // the reply must be one of this part's items or something already taught.
    // Anything else has the tutor marking them wrong against words they were
    // never handed — which is what "that is not the answer I'm looking for"
    // was, said to a student about their own age.
    const own = new Set([...plan.items.map((item) => fold(item.say)), ...taughtSay]);
    // What is said back to one of their phrases is already in the part: a
    // role-play whose only line was "gohyaku en desu" repeated the step before.
    const saidBack = new Set(plan.items.map((item) => fold(item.reply)).filter(Boolean));
    const figures = new Set(plan.items.filter((item) => /^\d/.test(item.meaning.trim())).map((item) => fold(item.say)));
    const proposed = plan.scene.lines.map((line) => line.tutor);
    const keepLine = (line) =>
        line.expect && own.has(fold(line.expect)) && !own.has(fold(line.tutor)) && !saidBack.has(fold(line.tutor)) &&
        !/\bX\b/.test(`${line.tutor} ${line.expect}`) &&
        // The line must not hand over its own answer, and "welcome" on its
        // own is not something a customer replies to.
        !` ${fold(line.tutor)} `.includes(` ${fold(line.expect)} `) &&
        // Nor may the other person say one of the student's own phrases: a
        // cashier was given "kaado de onegaishimasu" to say.
        // (A price is not anybody's phrase: "sen en desu" is what a shop
        // assistant says, whether or not "sen en" is an item — and with this
        // applied to figures, a part about prices could never have a scene.)
        ![...own].some((phrase) => phrase.split(' ').length > 1 && !figures.has(phrase) && ` ${fold(line.tutor)} `.includes(` ${phrase} `)) &&
        // Nor a customer's line of any kind: a waiter does not ask for things,
        // or ask the customer what they recommend. Twice a waiter was given
        // "osusume wa nan desu ka".
        !/\bosusume wa\b|\bikura desu ka$/.test(fold(line.tutor)) &&
        !/^irasshaimase$/.test(fold(line.tutor));
    const tidyReplies = (list) => {
      for (const line of list) {
        const bad = !line.reply || !line.replyMeaning || unreadable(line.reply) || own.has(fold(line.reply));
        if (bad) { line.reply = ''; line.replyMeaning = ''; }
      }
    };
    plan.scene.lines = plan.scene.lines.filter(keepLine);
    // A role-play does not open on a line an earlier one in this lesson used,
    // and uses at most one of them. The planner is told so and does it anyway:
    // three plans in one lesson shared two of their three lines.
    // (A part with one exchange asks the one honest question, whoever asked
    // it before; a part with none has none.)
    const rolePlay = mode === 'roleplay' ? 'full' : phase.role_play || 'full';
    if (rolePlay === 'none') plan.scene.lines = [];
    const usedBefore = new Set((Array.isArray(scenes) ? scenes : []).map((entry) => fold(String(entry))));
    let reused = 0;
    plan.scene.lines = plan.scene.lines.filter((line, index) => {
      if (rolePlay !== 'full' || !usedBefore.has(fold(line.tutor))) return true;
      reused += 1;
      return index > 0 && reused <= 1;
    });
    // The same question twice is one question.
    const asked = new Set();
    plan.scene.lines = plan.scene.lines.filter((line) => (asked.has(fold(line.tutor)) ? false : Boolean(asked.add(fold(line.tutor)))));
    tidyReplies(plan.scene.lines);

    // A second pair of eyes on the Japanese. The planner writes fluently and
    // now and then invents: "go-rann", "menii", "nanika goyoi desu ka". What a
    // proofreader will not vouch for is not taught and not said.
    const reference = ` ${fold(facts.join(' '))} `;
    const doubted = await proofread({
      language,
      level,
      plan,
      vetted: (text) => fold(text).length > 3 && reference.includes(` ${fold(text)} `),
      ask: (messages) => chatJson({ model: preferred, temperature: 0, maxTokens: 300, timeoutMs: 15000, messages }),
    });
    // What was taken out, and by whom, for the session log: a part that runs
    // with no role-play should be explicable afterwards.
    plan.dropped = [
      ...proposed.filter((text) => !plan.scene.lines.some((line) => line.tutor === text)).map((text) => `rule: ${text}`),
      ...[...doubted.items].map((text) => `proofreader, item: ${text}`),
      ...[...doubted.lines].map((text) => `proofreader, line: ${text}`),
      ...[...doubted.replies].map((text) => `proofreader, reply: ${text}`),
      ...[...doubted.notes].map((text) => `proofreader, note: ${text}`),
    ];
    // A note it will not vouch for is not said; the item is still taught.
    for (const item of plan.items) if (item.note && doubted.notes.has(fold(item.note))) item.note = '';
    if (doubted.items.size) plan.items = plan.items.filter((item) => !doubted.items.has(fold(item.say)));
    if (doubted.lines.size) plan.scene.lines = plan.scene.lines.filter((line) => !doubted.lines.has(fold(line.tutor)));
    for (const entry of [...plan.scene.lines, ...plan.items]) {
      if (entry.reply && doubted.replies.has(fold(entry.reply))) { entry.reply = ''; entry.replyMeaning = ''; }
    }
    const kept = new Set(plan.items.map((item) => fold(item.say)));
    plan.scene.lines = plan.scene.lines.filter((line) => kept.has(fold(line.expect)) || taughtSay.has(fold(line.expect)));
    // (When fewer than two lines are left, the script fills the role-play out
    // itself, from the moments the part's own phrases are for: see
    // buildScript. Asking the planner again cost three seconds of silence and
    // came back with nothing usable both times it was tried.)

    const usable = mode === 'roleplay' ? plan.scene.lines.length >= 2 : plan.items.length >= 2;
    if (!usable) return { ok: false, plan: null, error: 'The planner returned too little to teach from.' };
    if (mode === 'roleplay') plan.items = [];
    return { ok: true, plan, error: null };
  } catch (error) {
    return {
      ok: false,
      plan: null,
      error: error instanceof OpenAIError ? error.message : 'The lesson planner could not run.',
    };
  }
}
