/**
 * shared/lesson-activation.js
 *
 * Deciding whether something the student said was a request to start a lesson.
 *
 * The hard requirement (PART 20, PART 21, PART 56):
 *
 *     "I ate at a restaurant yesterday."       -> nothing happens
 *     "Let's do the Restaurant Roleplay lesson." -> activate
 *     "Can we practice restaurants?"            -> ask for confirmation
 *
 * So a bare topic word is never enough. Activation needs BOTH a phrase that
 * frames the utterance as a request to start an activity, AND a reference to a
 * specific Skill — or an authored trigger phrase that supplies both at once.
 *
 * This module is the deterministic, testable half of activation. The Realtime
 * model is the other half: it calls `start_lesson` when it judges intent
 * conversationally. Both routes end at the same `activateLesson(skillId)`
 * (PART 22), and activation is idempotent, so the two can never double-start
 * the same lesson.
 *
 * Dependency-free: runs unchanged in Node and the browser.
 */

/** @typedef {'activate'|'confirm'|'none'} ActivationIntent */

/**
 * Phrases that frame an utterance as "I want to start doing something".
 * Deliberately about intent, never about topic.
 */
const REQUEST_FRAMES = [
  /\blet'?s\s+(?:do|start|begin|try|run|practi[cs]e|work\s+on|go\s+through)\b/,
  /\bcan\s+we\s+(?:do|start|begin|try|run|practi[cs]e|work\s+on|go\s+through)\b/,
  /\bcould\s+we\s+(?:do|start|begin|try|run|practi[cs]e|work\s+on)\b/,
  /\b(?:i'?d|i\s+would)\s+like\s+to\s+(?:do|start|begin|try|practi[cs]e|work\s+on)\b/,
  /\bi\s+(?:want|wanna)\s+to?\s*(?:do|start|begin|try|practi[cs]e|work\s+on)\b/,
  /\b(?:shall|should)\s+we\s+(?:do|start|begin|try|practi[cs]e)\b/,
  /\bhow\s+about\s+(?:we\s+)?(?:do|try|practi[cs]e)\b/,
  /\b(?:start|begin|run)\s+(?:the|a|an)\b[^.?!]*\b(?:lesson|exercise|roleplay|role\s*play|drill|practice)\b/,
  /\bteach\s+me\b/,
  /\bgive\s+me\s+(?:a|an|the)\b[^.?!]*\b(?:lesson|exercise|drill)\b/,
];

/** Words that mark the request as being about a structured activity. */
const ACTIVITY_WORDS = /\b(?:lesson|lessons|exercise|roleplay|role\s*play|drill|module|practice|activity|scenario)\b/;

/**
 * Contexts in which a lesson name is being talked ABOUT rather than asked for:
 * a refusal, a memory, or a plan for another day. Any of these vetoes
 * activation outright, however clear the rest of the sentence looks.
 *
 * This is what separates "let's do the restaurant lesson" from "that restaurant
 * lesson last week was fun" and "I don't want to do the restaurant roleplay".
 */
const BLOCKERS = [
  /\b(?:do\s?n'?t|does\s?n'?t|did\s?n'?t|do\s+not|cannot|can'?t|won'?t|would\s+rather\s+not)\b/,
  /\bnever\b/,
  /\bnot\s+(?:now|today|right\s+now|yet)\b/,
  /\b(?:yesterday|last\s+(?:week|time|night|month)|the\s+other\s+day|ago)\b/,
  /\b(?:we|i|you)\s+(?:did|had|took|tried|finished|already)\b/,
  /\b(?:tomorrow|next\s+(?:time|week)|another\s+day|some\s+other\s+time|later\s+on)\b/,
  /\bmaybe\b/,
  /\b(?:was|were)\s+(?:really\s+|very\s+)?(?:fun|hard|good|easy|difficult|boring)\b/,
  /\b(?:my|his|her|their)\s+(?:friend|brother|sister|wife|husband|son|daughter|colleague)\b/,
];

/** Phrases that mean "stop the lesson" (PART 23). */
const ACTIVITY_NOUN = '(?:lesson|exercise|roleplay|role\\s*play|drill|activity)';

/** The stop verb has to be the thing being asked for, at the end of a clause. */
const STOP_FRAMES = [
  new RegExp(
    `\\b(?:let'?s|can\\s+we|could\\s+we|please|i\\s+want\\s+to|i'?d\\s+like\\s+to|we\\s+should)?\\s*` +
      `\\b(?:stop|end|quit|cancel|abandon)\\s+(?:the|this)\\s+${ACTIVITY_NOUN}\\s*(?:$|[.,!?]|\\s+(?:now|please|here))`,
  ),
  /\b(?:let'?s|can\s+we|could\s+we)\s+just\s+(?:chat|talk|have\s+a\s+conversation)\b/,
  /\b(?:i\s+)?don'?t\s+want\s+to\s+(?:do|continue)\s+(?:this|the)\s+(?:exercise|lesson|roleplay|role\s*play|activity|anymore)\b/,
  /\b(?:go\s+back|return|back)\s+to\s+(?:normal|regular|just|ordinary)\s+(?:conversation|chatting|talking)\b/,
  /\bforget\s+(?:the|this)\s+lesson\b/,
  /\bno\s+more\s+(?:lesson|exercise|drill)s?\s*(?:$|[.,!?]|\s+(?:for\s+)?(?:now|today|please))/,
];

/**
 * Plain agreement. Used only to answer a question the tutor has just asked —
 * "would you like the Restaurant Roleplay lesson?" — never on its own.
 */
const AFFIRMATIONS = [
  /^(?:yes|yeah|yep|yup|sure|ok(?:ay)?|alright|please|definitely|absolutely|sounds good|go on|why not)\b/,
  /^(?:let'?s|lets)\s+(?:do|go|start|try)\b/,
  /^(?:i'?d|i\s+would)\s+like\s+(?:that|to)\b/,
  /\bthat\s+(?:one|sounds\s+good)\b/,
];

/** Plain refusal, so a "no" clears the suggestion instead of hanging about. */
const NEGATIONS = [
  /^(?:no|nope|nah|not\s+(?:now|really|today)|maybe\s+later|another\s+time)\b/,
  /^(?:i'?d|i\s+would)\s+rather\s+not\b/,
];

/** Normalise for matching: lowercase, strip punctuation, collapse whitespace. */
export function normalizeUtterance(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s'?!.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Escape a phrase for use inside a RegExp. */
function escape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whole-phrase containment: "train station" matches inside a sentence, but
 * "train" does not match "training".
 * @param {string} haystack already normalised
 * @param {string} needle
 */
function containsPhrase(haystack, needle) {
  const phrase = normalizeUtterance(needle);
  if (!phrase) return false;
  const pattern = new RegExp(`(?:^|\\s)${escape(phrase).replace(/\\?\s+/g, '\\s+')}(?:$|\\s|[?!.])`);
  return pattern.test(haystack);
}

/**
 * Is this utterance talking about a lesson rather than asking for one?
 * @param {string} utterance
 * @returns {boolean}
 */
export function hasBlocker(utterance) {
  const text = normalizeUtterance(utterance);
  return BLOCKERS.some((pattern) => pattern.test(text));
}

/** @param {string} utterance @returns {boolean} */
export function hasRequestFrame(utterance) {
  const text = normalizeUtterance(utterance);
  return REQUEST_FRAMES.some((pattern) => pattern.test(text));
}

/**
 * Does this utterance ask to stop the current lesson?
 * @param {string} utterance
 * @returns {boolean}
 */
export function isDeactivationRequest(utterance) {
  const text = normalizeUtterance(utterance);
  // "I had to cancel the lesson at school" is a story, not a request.
  if (BLOCKERS.some((pattern) => pattern.test(text))) {
    // ...except the refusal blockers, which are exactly how a student says stop.
    const refusing = /\b(?:do\s?n'?t|do\s+not|no\s+more|not\s+(?:now|today))\b/.test(text);
    if (!refusing) return false;
  }
  return STOP_FRAMES.some((pattern) => pattern.test(text));
}

/**
 * Is this utterance a plain yes to something just offered?
 * @param {string} utterance
 * @returns {boolean}
 */
export function isAffirmation(utterance) {
  const text = normalizeUtterance(utterance);
  if (!text || text.split(' ').length > 6) return false;
  return AFFIRMATIONS.some((pattern) => pattern.test(text));
}

/**
 * Is this utterance a plain no?
 * @param {string} utterance
 * @returns {boolean}
 */
export function isRefusal(utterance) {
  const text = normalizeUtterance(utterance);
  if (!text || text.split(' ').length > 6) return false;
  return NEGATIONS.some((pattern) => pattern.test(text));
}

/**
 * Resolve a reference the model or the UI supplied — an id, a name, or an
 * alias — to a registered Skill.
 *
 * This is the shared resolver both activation routes use, so the model saying
 * "Restaurant Roleplay" and the UI passing "restaurant" land on the same Skill.
 *
 * @param {string} reference
 * @param {Record<string, any>[]} skills
 * @returns {Record<string, any>|null}
 */
export function resolveSkillReference(reference, skills) {
  const list = Array.isArray(skills) ? skills : [];
  const raw = String(reference ?? '').trim();
  if (!raw) return null;

  // 1. Exact id.
  const byId = list.find((skill) => skill.id === raw);
  if (byId) return byId;

  const text = normalizeUtterance(raw);
  if (!text) return null;

  // 2. Exact name, or the id written with spaces instead of underscores.
  const byName = list.find(
    (skill) => normalizeUtterance(skill.name) === text || normalizeUtterance(skill.id.replace(/_/g, ' ')) === text,
  );
  if (byName) return byName;

  // 3. Exact trigger or alias.
  const byPhrase = list.find((skill) =>
    [...skill.activation.voice_triggers, ...skill.activation.voice_aliases].some(
      (phrase) => normalizeUtterance(phrase) === text,
    ),
  );
  if (byPhrase) return byPhrase;

  // 4. The reference contains a Skill's full name. Longest name wins so
  //    "Numbers, Time & Money" beats a Skill merely called "Numbers".
  const containing = list
    .filter((skill) => containsPhrase(text, skill.name))
    .sort((a, b) => b.name.length - a.name.length);
  return containing[0] || null;
}

/** Words that are part of asking, not part of the subject asked about. */
const TOPIC_NOISE = new Set([
  'i', 'we', 'you', 'want', 'wanna', 'would', 'like', 'need', 'to', 'lets', "let's", 'can', 'could', 'please', 'do', 'talk',
  'about', 'learn', 'study', 'practice', 'practise', 'work', 'on', 'go', 'over', 'teach', 'tell', 'me', 'us', 'some', 'more',
  'new', 'the', 'a', 'an', 'my', 'japanese', 'german', 'specifically', 'especially', 'for', 'of', 'in', 'with', 'related',
  'such', 'as', 'mainly', 'mostly', 'just', 'really', 'today', 'now', 'ok', 'okay', 'yes', 'yeah', 'so', 'and', 'd', 'id',
  "i'd", 'how', 'say', 'know', 'get', 'start', 'begin', 'try', 'help', 'build', 'drill', 'kind', 'kinds', 'things', 'stuff',
]);

/**
 * Is the student asking for words on a subject — and which subject?
 *
 * "I want to talk about vocabulary, specifically vegetables." Outside a
 * lesson, that used to start nothing: the tutor was left to improvise a
 * vocabulary lesson, with no reference in front of it and nothing checking
 * what it said. It names both the lesson (the one that asks for a subject) and
 * the subject, so the lesson can simply begin.
 *
 * @param {string} utterance
 * @param {Record<string, any>[]} skills
 * @returns {{skillId: string, inputId: string, topic: string}|null}
 */
export function topicRequest(utterance, skills) {
  const list = Array.isArray(skills) ? skills : [];
  const text = normalizeUtterance(utterance).replace(/[.?!]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || BLOCKERS.some((pattern) => pattern.test(text))) return null;
  // The lesson that takes a subject: one required piece of text, asked of the student.
  const skill = list.find((entry) => (entry.runtime_inputs || []).some((input) => input.type === 'text' && input.required));
  if (!skill) return null;
  const input = skill.runtime_inputs.find((entry) => entry.type === 'text' && entry.required);
  const wants = REQUEST_FRAMES.some((pattern) => pattern.test(text)) ||
    /\b(?:i\s+(?:want|wanna|need)|i'?d\s+like|i\s+would\s+like|let'?s|can\s+we|could\s+we|teach\s+me|tell\s+me|help\s+me)\b/.test(text);
  if (!wants) return null;
  const noise = (word) => TOPIC_NOISE.has(word) || /^(vocabulary|vocab|words?|phrases?|lesson|builder)$/.test(word);
  // What is left once the asking is taken off both ends: "animals and colors".
  const tidy = (words) => {
    const kept = words.split(' ').filter(Boolean);
    while (kept.length && noise(kept[0])) kept.shift();
    while (kept.length && noise(kept[kept.length - 1])) kept.pop();
    return kept.slice(0, 8).join(' ');
  };
  // A sentence about how to practise is not a subject: "I want you to give me
  // an English word, single word, not sentences" became a lesson on "single
  // word not sentences just a single word". Nor is asking for a drill.
  if (drillRequest(text)) return null;
  const aboutFormat = (topic) => {
    const words = topic.split(' ').filter(Boolean);
    return words.length > 0 && words.filter((word) => FORMAT_WORDS.has(word)).length * 2 >= words.length;
  };
  const cue = /\b(vocabulary|vocab|words?|phrases?)\b/.exec(text);
  if (cue) {
    // "… vocabulary, specifically vegetables" — or "food words".
    const after = tidy(text.slice(cue.index + cue[0].length));
    const topic = after || tidy(text.slice(0, cue.index));
    if (aboutFormat(topic)) return null;
    return { skillId: skill.id, inputId: input.id, topic };
  }
  // "Teach me all the basic colors." No word for words, but a subject to learn:
  // said outside a lesson, the tutor improvised colours for thirteen minutes
  // and ended in a drill that named the same colour three times running.
  const learn = [...text.matchAll(/\b(?:teach\s+me|(?:want|wanna|need|like)\s+to\s+learn|let'?s\s+learn)\b/g)].pop();
  if (!learn) return null;
  const rest = text.slice(learn.index + learn[0].length).trim();
  // "Teach me how to say hello" is a question for the tutor, not a lesson.
  if (!rest || /^(?:how|what|why|when|where|which|who|to|if|about\s+how)\b/.test(rest)) return null;
  const topic = tidy(rest);
  if (!topic || topic.split(' ').length > 5 || /^(?:something|anything|everything|it|that|this|more)$/.test(topic) || aboutFormat(topic)) return null;
  // "Teach me numbers" belongs to the lesson about numbers.
  const elsewhere = list.some((entry) => entry !== skill &&
    [entry.name, ...entry.activation.voice_triggers, ...entry.activation.voice_aliases].some((phrase) => containsPhrase(topic, phrase)));
  return elsewhere ? null : { skillId: skill.id, inputId: input.id, topic };
}

/**
 * Classify a student utterance.
 *
 * @param {string} utterance the completed transcript of one student turn
 * @param {Record<string, any>[]} skills the registered Skills
 * @returns {{intent: ActivationIntent, skillId: string, skillName: string, matched: string, reason: string}}
 */
export function classifyActivationIntent(utterance, skills) {
  const list = Array.isArray(skills) ? skills : [];
  const text = normalizeUtterance(utterance);
  const none = { intent: /** @type {ActivationIntent} */ ('none'), skillId: '', skillName: '', matched: '', reason: '' };
  if (!text || list.length === 0) return none;

  // --- 1. Veto. A lesson being discussed, remembered, refused or deferred is
  //        not a lesson being requested, no matter what phrases it contains.
  //        This is what keeps "I don't want to do the restaurant roleplay" and
  //        "that restaurant lesson last week was fun" inert (PART 56).
  if (BLOCKERS.some((pattern) => pattern.test(text))) return none;

  const framed = REQUEST_FRAMES.some((pattern) => pattern.test(text));

  /**
   * A bare answer counts as a request too: asked "which lesson?", a student
   * replies "the restaurant lesson", with no verb anywhere. The utterance has
   * to be essentially nothing but the phrase for this to hold.
   * @param {string} phrase
   */
  const isBareRequest = (phrase) => {
    const stripped = text.replace(/^(?:ok(?:ay)?|yes|yeah|sure|right)[,\s]+/, '').replace(/[.?!]+$/, '');
    const target = normalizeUtterance(phrase);
    const bare = stripped.replace(/^(?:the|a|an)\s+/, '').replace(/[,\s]+please$/, '');
    return bare === target || bare === `${target} lesson` || bare === `do ${target}`;
  };

  /** @param {Record<string, any>} skill @param {string} matched @param {string} reason */
  const decide = (skill, matched, reason, ambiguous) => {
    const behavior = skill.activation.confirmation_behavior;
    const wantsConfirmation =
      behavior === 'always_confirm' || (ambiguous && behavior !== 'never_confirm');
    return {
      intent: /** @type {ActivationIntent} */ (wantsConfirmation ? 'confirm' : 'activate'),
      skillId: skill.id,
      skillName: skill.name,
      matched,
      reason,
    };
  };

  // --- 2. An authored trigger phrase, inside an actual request. The trigger
  //        identifies the lesson; the frame establishes that one is wanted.
  //        Neither is sufficient alone.
  for (const skill of list) {
    for (const trigger of skill.activation.voice_triggers) {
      if (!containsPhrase(text, trigger)) continue;
      if (framed || isBareRequest(trigger)) {
        return decide(skill, trigger, 'explicit trigger phrase in a request', false);
      }
      // A trigger phrase with no request around it — "is the numbers lesson
      // hard?" — is a mention. Say nothing rather than guess.
      return none;
    }
  }

  // --- 3. Without a request frame, nothing else can activate either.
  if (!framed) return none;

  const mentionsActivity = ACTIVITY_WORDS.test(text);

  // --- 4. A request frame plus the Skill's actual name is strong evidence.
  const named = list
    .filter((skill) => containsPhrase(text, skill.name))
    .sort((a, b) => b.name.length - a.name.length)[0];
  if (named) {
    return decide(named, named.name, 'request frame and lesson name', false);
  }

  // --- 5. A request frame plus a loose alias is ambiguous. Confirm rather
  //        than guess (PART 21) — unless the Skill opted out of confirmation
  //        and the student clearly asked for an activity.
  for (const skill of list) {
    for (const alias of skill.activation.voice_aliases) {
      if (!containsPhrase(text, alias)) continue;
      const ambiguous = !(skill.activation.confirmation_behavior === 'never_confirm' && mentionsActivity);
      return decide(skill, alias, 'request frame and ambiguous alias', ambiguous);
    }
  }

  return none;
}

/** Asking to be drilled, in any of the ways it was asked for on 14 Oct. */
const DRILL_ASKS = [
  /\b(?:drill|quiz|test)(?:ing)? me\b/,
  /\b(?:want|like|do|have|need|try) (?:a|another|some|more) (?:drill|quiz)/,
  /\bkeep (?:drilling|quizzing|testing)\b/,
  /\bmore drills?\b/,
  /\bone[ -]word prompts?\b/,
  // "Give me a single English color and I tell you the Japanese name."
  /\bgive me (?:a|an|one) (?:single )?english (?:word|colou?r|one)\b/,
  /\b(?:single|one) (?:english )?word\b[^.?!]{0,60}\b(?:in japanese|japanese (?:word|name)|i(?:'ll| will)? (?:tell|give|say))/,
];

/** "Don't drill me", "no more drills": refusing one is not asking for one. */
const DRILL_REFUSED = /\b(?:do\s?n'?t|do not|stop|no more|not now|never)\b[^.?!]{0,15}\b(?:drill|quiz|test)/;

/** Words about how to drill rather than what: "one word prompts", "single English word". */
const FORMAT_WORDS = new Set([
  'word', 'words', 'single', 'one', 'sentence', 'sentences', 'prompt', 'prompts', 'english', 'japanese', 'drill', 'drills',
  'quiz', 'answer', 'answers', 'question', 'questions', 'name', 'names', 'just', 'not', 'only', 'a', 'an', 'the', 'each', 'at',
  'time', 'me', 'you', 'please',
]);

/**
 * Is the student asking to be drilled on words — and on what?
 *
 * "Drill me on the basic colors." "I want a drill." "Keep drilling me." Said
 * on 14 Oct, these got a Vocabulary Builder lesson of new colours, then a
 * lesson whose subject was "single word not sentences just a single word",
 * then a teach line. A drill is English in, one word back, from what the
 * student already has. Checked before every other reading of what they said.
 *
 * @param {string} utterance
 * @returns {{topic: string}|null} `topic` is "" when none was named
 */
export function drillRequest(utterance) {
  const text = normalizeUtterance(utterance);
  if (!text || DRILL_REFUSED.test(text)) return null;
  const asked = DRILL_ASKS.find((pattern) => pattern.test(text));
  if (!asked) return null;
  // "… on the basic colors", "… about food". (Not "for": "the Japanese name for that color" is no subject.)
  const named = /\b(?:on|about)\s+(?:all\s+)?(?:of\s+)?(?:the|my|some|those|these)?\s*([a-z][a-z' -]{1,40}?)(?=[.,!?]|\s+(?:in english|in japanese|again|please|and|so|where|now)\b|$)/.exec(text);
  const words = named ? named[1].trim().split(/\s+/) : [];
  // What is left once words about the drill itself are taken out.
  const subject = words.filter((word) => !FORMAT_WORDS.has(word));
  return { topic: subject.length && subject.length >= words.length / 2 ? subject.join(' ') : '' };
}

/**
 * The answer to the call's opening question — "What would you like to be able
 * to say?" — when it is just a subject: "About colors", "colors please".
 * That was the first thing said on 14 Oct, and it started nothing.
 *
 * @param {string} utterance
 * @param {Record<string, any>[]} skills
 * @returns {{skillId: string, inputId: string, topic: string}|null}
 */
export function openingTopic(utterance, skills) {
  const list = Array.isArray(skills) ? skills : [];
  const text = normalizeUtterance(utterance).replace(/[.!]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text || /\?/.test(text) || BLOCKERS.some((pattern) => pattern.test(text))) return null;
  // Not sure, anything, you choose, hello: none of those is a subject.
  if (/\b(?:not sure|no idea|don'?t know|anything|whatever|you (?:choose|pick|decide)|surprise me|hello|hi|hey|good (?:morning|evening|afternoon)|thanks?|yes|no|nothing|again|more|ready|start|go|continue|sure|wait|sorry|pardon|repeat)\b/.test(text)) return null;
  const words = text.replace(/^(?:um+|uh+|well|maybe|probably|i guess|i think)\s+/, '').replace(/^(?:about|on)\s+/, '').replace(/\s+please$/, '').replace(/^(?:the|some)\s+/, '').split(' ').filter(Boolean);
  if (!words.length || words.length > 4 || !words.every((word) => /^[a-z'-]+$/.test(word))) return null;
  const topic = words.join(' ');
  if (FORMAT_WORDS.has(topic) || TOPIC_NOISE.has(topic)) return null;
  const skill = list.find((entry) => (entry.runtime_inputs || []).some((input) => input.type === 'text' && input.required));
  if (!skill) return null;
  // "Restaurants" has a lesson of its own.
  if (list.some((entry) => entry !== skill &&
    [entry.name, ...entry.activation.voice_triggers, ...entry.activation.voice_aliases].some((phrase) => containsPhrase(topic, phrase)))) return null;
  const input = skill.runtime_inputs.find((entry) => entry.type === 'text' && entry.required);
  return { skillId: skill.id, inputId: input.id, topic };
}
