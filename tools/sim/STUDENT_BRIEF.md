# Brief for a test student

You are testing a voice language tutor by BEING its student, then judging it.
The tutor is a small realtime model teaching Japanese to a beginner. You talk to
it in text through a harness; in the real app the same model speaks aloud.

## How to talk to it

Use your shell tool, from the project folder (your task says where it is and
which tool to use; allow up to 150 seconds per call). These three commands are
the ONLY things you may run:

    node tools/sim/client.mjs start <options given in your task>
    node tools/sim/client.mjs say <session> "<what you say>"
    node tools/sim/client.mjs end <session>

`start` prints a session id (like `s10040710-ab12`) and the tutor's opening.
`say` prints the tutor's reply. One `say` per tool call; wait for each reply.

Hard rules:
- Run ONE session. At most 24 `say` turns, then `end` it. Count them as you go.
- If any output says STOPPED, "spend cap", or "worker is not running": stop at
  once, do not retry, and say so in your report.
- Never read `.env`. Never call any API or URL yourself. Never start another
  process. Do not create, edit or delete any file.
- In what you say, avoid the characters `"` `$` `` ` `` `!` and backslash (they
  break the shell). Apostrophes are fine.

After the session you MAY read (not modify) these to make your proposed fixes
concrete: `public/shared/prompt.js`, `public/shared/script.js`,
`public/shared/lesson-prompt.js`, `public/shared/conductor.js`,
`src/planner.js`, `src/judge.js`, `public/shared/lesson-runtime.js`,
`Lessons/<lesson>/lesson.json`, `Languages/Japanese.json`,
and your own session's log `tools/sim/runs/<session>.jsonl` (it records the
exact instructions the tutor was given, under `"type":"prompt"`, and the
material planned for each part, under `"type":"plan"`). Use `cat`, `grep` or
`node -e` via the same tool.

How a lesson is meant to run now: each part has a short script — teach an item
with its meaning, ask for an earlier item from its English or from the moment
it is used in ("You want the waiter to come over. What do you say?"), ask what
an earlier item means, a short role-play, then a one-line "you can now say…" —
and the next part follows.

The APP now chooses the tutor's words, after you have spoken (this is new in
version five; in the log these are `script.turn` events, and the instructions
for each reply are logged as `"type":"prompt","reason":"turn"`):
- right answer -> "Hai." and the next line. (When you merely repeat a phrase
  it has just taught, there is no "Hai.": it goes straight on. "Hai." is kept
  for answers you had to recall.);
- a different taught word, "I don't know", or a wrong answer -> a written
  correction, one more try, and then the answer is given and the lesson goes on;
- a question -> the tutor answers in a sentence or two (the only part it
  composes itself) and then repeats what it had asked. These arrive as two
  messages ("message 1 of 2", "2 of 2") by design: an answer, then the ask.
  Judge whether that reads naturally; it is not a stacked prompt unless the
  FIRST message also asks you for something;
- a request to skip or move on -> the part ends and the next one starts,
  written around what you asked for.
New in version eight: when you are asked for a phrase from its moment ("You want
the waiter to come over. What do you say?") and get it right, the person you
said it to answers back ("hai, shoushou omachi kudasai" — yes, one moment
please) instead of "Hai." — so small exchanges run through the whole part, not
only at its end.

The role-play at the end of a part is meant to be a small real exchange (new in
version seven): the tutor says the other person's line and what it means, and
asks "What do you say?" — it does NOT tell you what to answer. Any reply that
fits should be accepted (water when the plan had beer; "iie, daijoubu desu" to
"would you like a bag?"), and the other person says something back
("kashikomarimashita" — certainly). If you stall or miss, the first help is
the English of the answer; only after a second miss are you given the words.
At the end of a part the tutor says what you can now say and, separately, what
is "still to get"; what you missed should come back early in the next part.

New in version ten (this is what you are here to judge):
- A request is taught whole once. After that you are given the word and asked
  to make the request yourself: "Water is "omizu". Ask for water, the way you
  asked for a beer." If you answer with the bare word you should be told so,
  not marked wrong in general.
- The note about a phrase ("O kudasai is how you ask for something.") now
  comes AFTER you have repeated it, not between the phrase and "Say it".
- In a role-play the waiter says your order back before accepting it ("omizu
  desu ne. kashikomarimashita" — water, right? Certainly.) — and it should be
  what YOU said, not what the plan expected. A word you know put into a
  request you know ("tamanegi o onegaishimasu") should be accepted. A later
  line should not ask for what you have just said.
- What is said back to you is translated the first two times you hear it and
  then said bare ("kashikomarimashita."). A price or a time said back to you is
  not translated at all: you are asked "How much is that?".
- A role-play should have two to four lines, and not open on the same line in
  every part.
- "Hai." is explained the first time it is used ("Hai. That means yes."), not
  in the opening line.
- A plain-English request for a later part ("can we do the shop stuff
  instead?") should take you there; "can we try that one more time?" should
  not move the lesson anywhere.
- A remark ("ah, niku again, that makes sense") should not be answered as if
  it were a question.
Try each of these that your lesson gives you the chance to.

New in version eleven (also yours to judge):
- A request you make is said back whether or not you are in a role-play
  ("nasu desu ne" — eggplant, right?), so each reply is about what you said;
  "kashikomarimashita" is no longer attached to every one.
- A role-play is never one line: where the planner's lines are too few, the app
  adds moments in which YOU speak first ("You want the waiter to come over.
  What do you say?") and the other person answers.
- After the first line of a role-play, the other person's line and its English
  are the whole turn — no "What do you say?" after each.
- When a role-play ends, what you ordered arrives ("omizu to biiru desu. douzo"
  — water and a beer. Here you are.) before the closing line.
- A price you have been taught comes back as a shop assistant says it ("sen en
  desu". How much is that?), and a shop assistant's line that states a price is
  asked about first and then answered ("What do you say back?").
- If you answer a "make the request" step with the bare word, the help is the
  request you made before ("A beer, please was biiru o kudasai. So how do you
  ask for water?"), not the answer.
- "Can we try that one more time" gets the line again ("Sure. ...").
- "I know that one", said when you are asked to repeat a new phrase, moves on
  without making you repeat it; it comes back to be recalled.
- One way of asking is kept through a lesson (if "... o onegaishimasu" was
  taught first, later requests use it too), so later requests are built, not
  handed over.
- "Hai — yes." the first time, unless a waiter's "hai, ..." has already been
  translated.

New in version twelve:
- An order said back ("... desu ne") is translated its first two times and is
  bare after that, in and out of a role-play.
- Prices said to you are new ones, composed by the app from parts of prices
  already taught ("nisen yonhyaku en desu"); one you miss is said once more
  before you are told.
- In a shop role-play the price is asked for before it is given.
- A plain "hai" or "iie" answers a yes-or-no line; said in English ("no, that's
  all") you are given the words and the scene goes on.
- When a role-play ends the order is accepted and then arrives: "A little
  later: "omatase shimashita. omizu to biiru desu" — thank you for waiting:
  water and a beer."
- A phrase the role-play will ask for as a moment is asked for, before it, from
  its English — not with the same moment twice.

New in version thirteen (after the owner's first real call on this design):
- An answer that is the right one give or take a letter of transcription
  ("gen keen de", "genki de" for "genkin de"; "hassan yen" for "hassen en") is
  taken as right. A swapped little word (wa for o), a missing "ka", a missing
  syllable or a different word is still corrected.
- Asked "Ready for the next part?", any kind of no ("not ready", "go back",
  "again") takes you back through the part that has just closed — what you had
  is asked for, what you missed is taught again — and never on to the next.
- "Go back" or "I did not want you to move on", at any time, returns to the
  part you were in before.

New in version fourteen (the owner: "if I'm going to do repetition I would
prefer it's quick... tutor: What is cabbage — me: kyabetsu"):
- The vocabulary lesson's second set is single words, and its parts — and
  several of the numbers lesson's — close on a quick round: "Quick round. What
  is onion?" A right answer gets only the next question; a miss gets "It's
  "tamanegi". Next: What is ..." and comes round once more at the end. One-word
  answers are all that is wanted.
- The review at the end of a lesson is a quick round.
- Outside a lesson, "I want to talk about vocabulary, specifically vegetables"
  starts the Vocabulary Builder on that subject at once.

New in version fifteen (the owner's third call: "I barely paused long enough to
think and it thought I was done"; a long word asked for seven times because the
recogniser kept writing it differently):
- A word whose answer has had to be given twice is let go: it is not asked for
  again, is said once more in the review ("One to hear again: ..."), and is
  named at the end as one for next time.
- The vocabulary lesson's role-plays are one exchange ("What will you have?")
  or none. Any of the words answers it, alone or in a request, two at once.
- "Yes." or "OK" to something that asked for a phrase gets the ask again, not a
  correction. An answer you were just given and say back is acknowledged.
- The last part of a lesson says it is the last; nobody asks if you are ready
  for a part that does not exist.
- (Turn-taking, and asking the voice model what it heard, only exist on a real
  call: the harness cannot show them.)

New in version sixteen (the owner's 14 Oct calls: "I want a drill. Give me an
English word, single word, not sentences... and I'll tell you the Japanese"):
- "Drill me on X", "quiz me", "test me", "I want a drill", "keep drilling me",
  in a lesson or out, start a Word Drill: "Quick round. What is red?" — one
  English word, one word back, from words the student ALREADY HAS (saved, or
  taught earlier on the call). Nothing is taught. Every word once, in no fixed
  order, before any comes round again; a miss gets "It's "aka". Next: What is
  ..." and comes round once more at the end. It closes with "Drill done: 9 of
  11. For next time: ... Again, or something else?" — and "again" runs it again.
- With fewer than three such words: "You don't have X on file yet. Want to learn
  them first?" — yes starts the Vocabulary Builder on X.
- With no subject named, the drill is on the lesson's subject, or the last one
  of the call, or the newest words.
- A complaint that quotes the tutor ("You said ... something else that fits ...
  why are you insisting ...") is answered, not taken as a request to move on.
  "You are not supposed to tell me" is not giving up.
- In a role-play, a word from the student's saved list fits as well as one from
  the lesson; a colour said as an adjective ("akai onegaishimasu") is accepted
  and said back as the noun ("aka desu ne").
- "About colors" as the very first answer starts the Vocabulary Builder on it.
- Nothing above was changed in what the tutor says outside a lesson or drill:
  free conversation can still improvise. Note it if it does, but the fix for it
  is routing into the app, not the tutor's wording.

When the transcript alone does not settle whether an answer was right, a text
model judges it (`script.judged` in the log). In the harness your text IS the
transcript; in a real call a speech recogniser writes it, often in Japanese
script. You may answer once or twice in kana or kanji (for example 二人です) to
check that is handled.

Judge whether that is what actually happens, and whether it is any good: does
it catch real mistakes, does it leave right answers alone — including a right
answer in other words, such as kudasai for onegaishimasu — are the judge's
verdicts fair, and does it feel like a lesson or like a flashcard machine?

## How to be the student

- Write what the student would SAY ALOUD. Japanese in romaji, as a beginner
  would pronounce it. English when confused. Short utterances.
- Stay in the persona your task gives you.
- You must probe these, naturally, across the session:
  1. Several answers that are exactly right. (Does it invent a correction?)
  2. Two or three realistic beginner mistakes. (Is the correction accurate,
     specific and brief?)
  3. One right answer said a little differently — extra word, different order
     where order is free, a hesitation like "um, san". (Does it misjudge it?)
  4. One question in English mid-exercise.
  5. If it ever asks you to say something it has not told you the meaning of,
     ask what it means — and note that it happened.
  6. When it asks whether you are ready to go on, say yes, and see whether the
     next part starts cleanly and teaches something new.

## What you are judging

The owner's complaints, since the start, are below. The bar is a tool that is
valuable and engaging WITHOUT these. He says: "I want to WANT to use this tool,
but it feels like work."

- It drills: the same kind of prompt over and over, parroting.
- It has him repeat phrases he does not know the meaning of.
- It never asks him to PRODUCE — to say something given only the English.
- Compliment fluff and long turns before the next thing to say.
- Several prompts stacked before he can answer; two asks in one turn. (The
  harness shows "message 1 of 2" when the tutor spoke twice in a row.)
- It "corrects" things he said correctly, or mislabels the mistake.
- Wrong Japanese: invented words, malformed numbers, a loanword taught where
  the native word is the normal one. YOU know Japanese — check every item it
  teaches and say if any is wrong or unnatural.
- The lesson stalls, or lurches somewhere unrelated.
- No sense of having learned anything by the end.

## Your report (your final message — this is all that comes back)

    SESSION: <id> · <lesson> · <persona> · <n> student turns
    VERDICT: 3-5 sentences. Is this constructively teaching Japanese? Would a
      real beginner want to continue, or does it feel like work? Be critical.
    SCORES (1-5, 5 best), one line each with a few words of justification:
      meaning given · one ask per turn · correction accuracy ·
      production/recall practice · variety and pacing · Japanese accuracy ·
      concision · engagement
    COULD SAY BY THE END: the things the student could genuinely now say.
    FLAWS, most serious first. For each: the tutor's exact words (quote the
      turn), why it matters, and a concrete proposed fix — wording for the
      prompt, a change to the lesson file, or a change to app logic.
    WHAT WORKED: briefly.
    TRANSCRIPT: every turn, STUDENT/TUTOR, verbatim and in order.
