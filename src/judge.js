/**
 * src/judge.js
 *
 * Was the student's answer right?
 *
 * The app decides most answers itself: the words it was waiting for are in the
 * transcript, or a different taught word is, or it is plainly a question. This
 * is for the rest — and in a real call the rest is large, because the
 * transcriber writes a beginner's Japanese in whatever script it likes. "二人です",
 * "ふたりです" and "futari desu" are the same answer; "64円" is "rokujuu yon en";
 * "三百円" is "sanbyaku en" and not the "san hyaku en" a mechanical conversion
 * gives. A text model reads all of them without effort.
 *
 * The voice model was asked to make this call first, in the same breath as
 * speaking, and could not be relied on to: given "if right say A, if wrong say
 * B" it said a third thing made of both. Here the question is asked on its
 * own, of a model with nothing else to do, and the answer is one word.
 *
 * A failure here costs a little certainty: the app falls back to letting the
 * voice model choose between two written-out turns.
 */

import { MEMORY_MODEL } from './config.js';
import { chatJson, OpenAIError } from './openai.js';

const VERDICTS = Object.freeze(['right', 'alternative', 'other', 'question', 'aside', 'wrong', 'unclear']);

/** @param {unknown} value @param {number} max */
function clean(value, max) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

/**
 * @param {{language: string, kind: string, say: string, meaning: string, also: string[],
 *          asked: string, transcript: string, taught: {say: string, meaning: string}[]}} input
 */
export function buildJudgePrompt({ language, kind, say, meaning, also, asked, transcript, taught, line = '', lineMeaning = '' }) {
  const english = kind === 'recognise';
  const scene = kind === 'scene' && Boolean(line);
  const others = (Array.isArray(taught) ? taught : [])
    .filter((item) => item && item.say && item.say !== say)
    .slice(-12)
    .map((item) => `- ${item.say} = ${item.meaning}`);

  return `A beginner is practising spoken ${language} with a tutor. Speech recognition wrote down what they said. It may be in ${language} script, in Latin letters, or a mixture, and it is approximate.

The tutor asked them ${asked}.
${english
    ? `The answer wanted is the English meaning: "${meaning}". Any wording that means the same is right, and so is saying what the phrase is for at the moment it is used ("a table for two" for a phrase that tells the host there are two of you). Saying the ${language} phrase itself back is not its meaning: that is "wrong".`
    : `The answer wanted: "${say}" (${meaning}).${also.length ? ` Just as right: ${also.map((entry) => `"${entry}"`).join(', ')}.` : ''}
It is still right with a pause or a filler, with a polite word such as desu added, with the particle o, wa or ga left out, with a long vowel written short, or with a little extra before or after.
${scene
      ? 'It is wrong if a particle has been swapped for a different one (wa where the answer has o), or if a syllable of a word is missing or changed.'
      : 'It is wrong if a particle has been swapped for a different one (wa where the answer has o), if a syllable is missing or changed, or if a word is a different word — even when the tutor had only asked them to repeat it.'}`}${scene ? `
THIS IS A ROLE-PLAY, AND THAT CHANGES THE QUESTION. The tutor, in character, had just said to them: "${line}" (${lineMeaning}). Nothing was asked for by name. The answer above is only one example of a good reply. First decide: is what they said correct ${language} that makes sense as a reply to that line? If it is, the verdict is "right" — whether it is another thing they have been taught (water when the example was beer; cash when it was card), a word they have been taught put into a request they have been taught ("tamanegi o onegaishimasu" when the example was "gyuuniku o onegaishimasu"), a fuller sentence, or the short reply people really give ("iie, daijoubu desu" to "would you like a bag?").` : ''}
${others.length ? `\nOther things they have been taught:\n${others.join('\n')}\n` : ''}
What was written down: "${transcript}"

Return JSON: {"heard": "", "verdict": "", "other": ""}

"heard" comes first: what they said, written in Latin letters the way a learner would read it (Hepburn romaji for ${language}; English left as English), twelve words at most, leaving out fillers such as um, uh and etto. Write exactly what is there — do not tidy it into the answer wanted.
The recogniser sometimes writes ${language} sounds as English-looking words ("Gen keen de" is "genkin de"; "Hassan yen" is "hassen en") or in another script altogether, such as Korean hangul ("카드で" is "kaado de"; "그지 주픈" is "kuji jupun"). Read those by their sound and write the ${language} they stand for.

"verdict", decided from "heard", is one of:
- "right": what they said is the answer wanted, or just as right. Compare by sound, not by spelling or script: read any kanji or kana aloud first ("二人です" is "futari desu", "64円" is "rokujuu yon en"). Different spacing or a different romanisation of the same sounds is right.
- "alternative": different words from the answer wanted, but a native speaker would naturally say them at this moment to mean the same thing ("fukuro wa kekkou desu" or "fukuro wa daijoubu desu" for "fukuro wa irimasen"). Only when you are sure it is natural ${language}; a near miss is "wrong".
- "other": ${scene
    ? 'they said one of the things they have been taught, and it does NOT answer the line said to them ("excuse me" to "how many people?"). A taught phrase that DOES answer it is "right", never "other".'
    : 'they said a different one of the other things they have been taught instead.'} Put that item, exactly as listed, in "other".
- "question": they spoke to the tutor in English to ask something, instead of answering. A sentence in ${language}, even one that is itself a question, is an attempt at the answer: judge it as right, other or wrong.${english ? ' An English sentence that gives the meaning is an answer too, however it is phrased ("can I have some water?" for a phrase that asks for water).' : ''}
- "aside": they said something to the tutor in English that is neither a question nor an attempt — a remark, a reaction, thinking aloud ("oh good, that's the one I'll need").
- "wrong": they tried, in ${language}, and what they said is a different word, or has a word or a whole syllable missing or changed. One vowel or consonant a little off in a recogniser's transcript of a beginner (genki de for genkin de; hassan en for hassen en; an for han) is the recogniser's doing as often as theirs: that is "right". A sentence in English is never "wrong": it is "question" or "aside".
- "unclear": noise, nothing, or no way to tell.

"other" is "" unless the verdict is "other".

Return only the JSON object.`;
}

/**
 * Which later part of the lesson is a student asking for, if any?
 *
 * "Can we go straight to paying?" used to be matched against the parts' names
 * by their first four letters. That found "paying" — and also sent "can we
 * try that one more time?" to the part called Time, and did nothing at all
 * with "can we do the shop stuff instead?".
 *
 * @param {{language: string, transcript: string, current: {name: string, purpose: string},
 *          parts: {id: string, name: string, purpose: string}[]}} input
 */
export function buildPartPrompt({ language, transcript, current, parts, before = '' }) {
  return `A beginner is in a spoken ${language} lesson with a tutor. In the middle of it they said, in English:

"${transcript}"

They are working on: ${current.name}${current.purpose ? ` — ${current.purpose}` : ''}

The other parts of the lesson:
${parts.map((part) => `- ${part.id}: ${part.name}${part.purpose ? ` — ${part.purpose}` : ''}${part.done ? ' (already been through)' : ''}`).join('\n')}

Are they asking to stop what they are doing and work on one of the other parts instead — one still to come, or going back to one already been through?

Return JSON: {"part": ""}

"part" is the id of the one part that best matches what they asked to do — by what the part is about, not by a shared word.${before ? `
If they say the lesson moved on when they did not want it to, or ask to go back without saying where, it is the part they were in before this one: "${before}".` : ''}
It is "" when they are not asking to change what the lesson is doing: they want something said or done again, they are asking about the language or how to say something, they are answering or translating what was asked, or they are only remarking on it. If in doubt, "".

Return only the JSON object.`;
}

/** @param {any} input */
async function routeRequest(input) {
  const transcript = clean(input?.transcript, 400);
  const parts = (Array.isArray(input?.parts) ? input.parts : [])
    .map((part) => ({ id: clean(part?.id, 60), name: clean(part?.name, 80), purpose: clean(part?.purpose, 200), done: part?.done === true }))
    .filter((part) => part.id && part.name)
    .slice(0, 12);
  if (!transcript || !parts.length) return { ok: false, verdict: 'unclear', heard: '', other: '', part: '', error: 'Nothing to route.' };
  try {
    const answer = await chatJson({
      model: MEMORY_MODEL,
      temperature: 0,
      maxTokens: 40,
      timeoutMs: 6000,
      messages: [
        {
          role: 'system',
          content: buildPartPrompt({
            language: clean(input.language, 40) || 'the language',
            transcript,
            current: { name: clean(input?.current?.name, 80), purpose: clean(input?.current?.purpose, 200) },
            parts,
            before: clean(input?.before, 60),
          }),
        },
        { role: 'user', content: 'Which part, if any?' },
      ],
    });
    const part = parts.some((entry) => entry.id === answer?.part) ? answer.part : '';
    return { ok: true, verdict: part ? 'request' : 'none', heard: '', other: '', part, error: null };
  } catch (error) {
    return {
      ok: false, verdict: 'unclear', heard: '', other: '', part: '',
      error: error instanceof OpenAIError ? error.message : 'The request could not be read.',
    };
  }
}

/**
 * Judge one answer.
 *
 * @param {Parameters<typeof buildJudgePrompt>[0]} input
 * @returns {Promise<{ok: boolean, verdict: string, heard: string, other: string, error: string|null}>}
 */
export async function judgeAnswer(input) {
  // The same door serves a second question: which part they are asking for.
  if (input?.kind === 'part') return routeRequest(input);
  const say = clean(input?.say, 120);
  const transcript = clean(input?.transcript, 400);
  if (!say || !transcript) return { ok: false, verdict: 'unclear', heard: '', other: '', error: 'Nothing to judge.' };

  const prompt = buildJudgePrompt({
    language: clean(input.language, 40) || 'the language',
    kind: clean(input.kind, 20),
    say,
    meaning: clean(input.meaning, 120),
    also: (Array.isArray(input.also) ? input.also : []).map((entry) => clean(entry, 120)).filter(Boolean).slice(0, 4),
    asked: clean(input.asked, 240),
    transcript,
    taught: (Array.isArray(input.taught) ? input.taught : [])
      .map((item) => ({ say: clean(item?.say, 120), meaning: clean(item?.meaning, 120) }))
      .filter((item) => item.say),
    line: clean(input.line, 160),
    lineMeaning: clean(input.lineMeaning, 160),
  });

  try {
    const answer = await chatJson({
      model: MEMORY_MODEL,
      temperature: 0,
      maxTokens: 120,
      timeoutMs: 6000,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Judge it.' },
      ],
    });
    const verdict = VERDICTS.includes(answer?.verdict) ? answer.verdict : 'unclear';
    return { ok: true, verdict, heard: clean(answer?.heard, 120), other: clean(answer?.other, 120), error: null };
  } catch (error) {
    return {
      ok: false,
      verdict: 'unclear',
      heard: '',
      other: '',
      error: error instanceof OpenAIError ? error.message : 'The answer could not be judged.',
    };
  }
}
