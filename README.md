# Kaiwa

**Kaiwa** (会話, Japanese for *conversation*) is a local, multi-user, multi-language
voice tutor. You talk, the tutor talks back, and what you learned is remembered between
lessons in plain JSON files on your own disk.

- Live voice tutoring over **WebRTC** using the **OpenAI Realtime API** (`gpt-realtime-2.1-mini`)
- Lesson bookkeeping handled off to the side by `gpt-4o-mini`, so the voice model
  only has to talk
- Post-lesson memory extraction and proficiency assessment using `gpt-4o-mini`
- Profiles stored as `config.json` files in a folder **you** choose
- Defaults to **German** with a tutor named **Franz** at **Absolute Beginner**
- Full Romaji-only behaviour for Japanese profiles
- **Lesson Skills**: structured, adaptive lessons defined entirely in JSON files

Kaiwa uses **your own OpenAI API key**, entered in the app the first time you open it.
The key stays with the local server on your computer. The browser never sees it.

```
Browser  ->  local Node.js backend  ->  OpenAI API
```

---

## Contents

- [Download and run](#download-and-run)
- [Your OpenAI API key](#your-openai-api-key)

Running from source instead:

1. [Install Node.js](#1-install-nodejs)
2. [Install dependencies](#2-install-dependencies)
3. [Optional: the .env file](#3-optional-the-env-file)
4. [Optional: a key in .env](#4-optional-a-key-in-env)
5. [Start the server](#5-start-the-server)
6. [Open the application](#6-open-the-application)
7. [Windows PowerShell and npm troubleshooting](#7-windows-powershell-and-npm-troubleshooting)
8. [Verify the backend health endpoint](#8-verify-the-backend-health-endpoint)
- [Using the app](#using-the-app)
- [Lessons](#lessons)
- [Writing your own lesson](#writing-your-own-lesson)
- [How memory works](#how-memory-works)
- [Lesson Comfort Level vs AI Assessed Level](#lesson-comfort-level-vs-ai-assessed-level)
- [Japanese profiles](#japanese-profiles)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)

---

## Download and run

Get the latest version from the
[Releases page](https://github.com/jeremysaqr/kaiwa/releases/latest). There is no
installer and nothing else to install: unpack the archive and run **Kaiwa**.

| Your computer | Download |
| --- | --- |
| Windows 10 / 11 | `Kaiwa-vX.Y.Z-windows-x64.zip` |
| Mac with Apple silicon (M1 and later) | `Kaiwa-vX.Y.Z-macos-arm64.tar.gz` |
| Mac with an Intel processor | `Kaiwa-vX.Y.Z-macos-x64.tar.gz` |
| Linux (most PCs) | `Kaiwa-vX.Y.Z-linux-x64.tar.gz` |
| Linux on ARM (e.g. Raspberry Pi 5) | `Kaiwa-vX.Y.Z-linux-arm64.tar.gz` |

**Windows**

1. Right-click the zip, choose **Extract All…**, and open the extracted folder.
2. Double-click **Kaiwa.exe**. Windows may show *"Windows protected your PC"*, because
   the app is not code-signed. Click **More info**, then **Run anyway**.
3. A console window opens and your browser opens Kaiwa at <http://localhost:3000>.
   Keep the console window open while you use Kaiwa. Closing it quits Kaiwa.

**macOS**

1. Double-click the `.tar.gz` to unpack it and open the folder.
2. The first time, **right-click Kaiwa → Open**, then **Open** again. macOS asks
   because the app does not come from the App Store or a registered developer. If it
   still refuses, run this once in Terminal from inside the folder:
   `xattr -d com.apple.quarantine Kaiwa`
3. A Terminal window opens and your browser opens Kaiwa. Keep the Terminal window open
   while you use it.

**Linux**

```bash
tar -xzf Kaiwa-vX.Y.Z-linux-x64.tar.gz
cd Kaiwa-vX.Y.Z-linux-x64
./Kaiwa
```

Then open <http://localhost:3000> if a browser does not open by itself.

**Use Chrome or Edge.** Kaiwa saves profiles in a folder you pick, using a browser
feature that Firefox and Safari do not have. If your default browser is one of those,
copy <http://localhost:3000> into Chrome or Edge.

Keep the `public`, `Lessons` and `Languages` folders next to the Kaiwa program: it
reads them at run time. That is also where you can add your own lessons
(see [Writing your own lesson](#writing-your-own-lesson)).

---

## Your OpenAI API key

Kaiwa talks through OpenAI's API, billed to your own OpenAI account.

1. Create a key at <https://platform.openai.com/api-keys>.
2. Open Kaiwa. The first time, it asks for the key before anything else. Paste it and
   press **Save key**. Kaiwa checks the key with OpenAI before saving it.
3. To change or remove it later, use **Settings → OpenAI API key** at the bottom of
   the sidebar.

The key is saved on your computer only, readable by your user account alone, in:

| System | Location |
| --- | --- |
| Windows | `%APPDATA%\Kaiwa\settings.json` |
| macOS | `~/Library/Application Support/Kaiwa/settings.json` |
| Linux | `~/.config/kaiwa/settings.json` |

It is kept apart from the app folder, so sharing or replacing the app never carries
your key along. The browser only ever learns *whether* a key is set and its last four
characters. Kaiwa listens on `localhost` only, so other devices on your network
cannot use it.

---

## 1. Install Node.js

You need **Node.js 20 or newer** (22 LTS recommended).

1. Go to <https://nodejs.org> and download the **LTS** Windows installer.
2. Run it and accept the defaults. Leave "Add to PATH" checked.
3. Open a **new** PowerShell or Command Prompt window and check:

```powershell
node --version
```

You should see something like `v22.x.x`. If the command is not recognised, close and
reopen the terminal — the PATH change only applies to new windows.

---

## 2. Install dependencies

Open a terminal in the project folder (the one containing `package.json`) and run:

```powershell
npm install
```

If PowerShell blocks `npm`, use `npm.cmd install` instead and see
[section 7](#7-windows-powershell-and-npm-troubleshooting).

This installs two packages: `express` (the local web server) and `dotenv` (reads
your `.env` file). Nothing is sent anywhere during install except to the npm registry.

---

## 3. Optional: the `.env` file

You only need a `.env` file to change advanced settings (the table below), or to give
the key to the server without the app. Copy the example:

```powershell
copy .env.example .env
```

`.env` is listed in `.gitignore` and must never be committed or shared.

---

## 4. Optional: a key in `.env`

The usual way to add your key is in the app ([Your OpenAI API key](#your-openai-api-key)).
A key in `.env` takes priority over one saved in the app, which suits development:

1. Sign in at <https://platform.openai.com/api-keys> and create a secret key.
2. Open `.env` in a text editor.
3. Paste the key after `OPENAI_API_KEY=` with **no quotes and no spaces**:

```
OPENAI_API_KEY=sk-your-key-here
PORT=3000
```

4. Save the file and **restart the server** — `.env` is read once at startup.

Optional settings you can uncomment in `.env`:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port the local server listens on |
| `HOST` | `127.0.0.1` | Address the server listens on. `0.0.0.0` opens it to your network, and so to anyone on it who can reach the port |
| `KAIWA_DATA_DIR` | *(see [Your OpenAI API key](#your-openai-api-key))* | Where the key saved in the app is kept |
| `KAIWA_NO_BROWSER` | *(off)* | `1` stops a release build from opening the browser at start |
| `LESSONS_DIR` | `./Lessons` | Where lesson definitions are discovered |
| `LOG_SESSIONS` | `1` | Set to `0` to stop writing session logs |
| `LOGS_DIR` | `./Logs` | Where session logs are written |
| `REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Voice model for the live lesson |
| `REALTIME_VOICE` | `marin` | Tutor voice (`marin`, `cedar`, `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`) |
| `MEMORY_MODEL` | `gpt-4o-mini` | Model used for memory extraction *and* the Lesson Director |
| `TRANSCRIBE_MODEL` | `gpt-live-transcribe` | Transcribes your own speech during the call |

The app runs without a key — you can create profiles and browse memory — but calls
and memory extraction will fail with a clear message until one is set.

Building the release executables yourself needs [Bun](https://bun.sh) as well:
`npm run build` makes one for this computer, and
`node tools/build.mjs --target <windows-x64|macos-arm64|macos-x64|linux-x64|linux-arm64>`
makes one for another platform. Each lands in `dist/` as an archive. Releases on GitHub
are built from a version tag by `.github/workflows/release.yml`.

---

## 5. Start the server

```powershell
npm start
```

You should see:

```
  Kaiwa
  Listening on   http://localhost:3000
  Health check   http://localhost:3000/api/health
  OpenAI API key saved in Kaiwa
```

For development, `npm run dev` restarts the server automatically when you edit a file.

Stop the server with `Ctrl+C`.

---

## 6. Open the application

Open <http://localhost:3000> in **Google Chrome** or **Microsoft Edge**.

> **Chrome or Edge is required.** The app stores profiles in a folder on your disk
> using the File System Access API, which Firefox and Safari do not support.

On first run the app will ask you to **Select storage folder**. Pick any folder you
like — for example `Documents\Kaiwa Data`. The app creates a `Users/`
folder inside it and remembers your choice, so you will not be asked again.

---

## 7. Windows PowerShell and npm troubleshooting

PowerShell's execution policy often blocks the `npm.ps1` script, producing:

```
npm : File C:\Program Files\nodejs\npm.ps1 cannot be loaded because running
scripts is disabled on this system.
```

**The simplest fix** — use `npm.cmd`, which is not a PowerShell script and is never
blocked:

```powershell
npm.cmd --version
npm.cmd install
npm.cmd start
```

Everything in this README works with `npm.cmd` substituted for `npm`.

**Alternative fixes:**

- Use **Command Prompt** (`cmd.exe`) instead of PowerShell — plain `npm` works there.
- Relax the policy for your own user account only (no admin rights needed):

  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```

  Answer `Y`, then close and reopen the terminal. `RemoteSigned` allows local scripts
  while still blocking unsigned downloaded ones.

**Other common Windows issues:**

| Symptom | Fix |
| --- | --- |
| `node`/`npm` not recognised | Reopen the terminal after installing Node. Still failing? Reinstall Node with "Add to PATH" checked. |
| `EADDRINUSE` on start | Port 3000 is taken. Set a different `PORT` in `.env`, or find the process with `netstat -ano \| findstr :3000` and stop it. |
| `npm install` fails behind a corporate proxy | `npm config set proxy http://your-proxy:port` and the same for `https-proxy`. |
| Terminal is in the wrong folder | `cd "C:\path\to\kaiwa"` — quote the path if it contains spaces. |

---

## 8. Verify the backend health endpoint

With the server running, open <http://localhost:3000/api/health> in your browser, or:

```powershell
curl.exe http://localhost:3000/api/health
```

A healthy server returns **HTTP 200** and:

```json
{
  "ok": true,
  "service": "kaiwa",
  "time": "2026-08-31T20:46:18.642Z",
  "apiKeyConfigured": true,
  "config": {
    "realtimeModel": "gpt-realtime-2.1-mini",
    "memoryModel": "gpt-4o-mini",
    "transcribeModel": "gpt-live-transcribe",
    "voice": "marin",
    "apiKeyConfigured": true
  }
}
```

Note that only the **boolean** `apiKeyConfigured` is returned. The key itself is
never sent to the browser, never logged, and never shown in diagnostics.

The app calls this endpoint on load with a 6-second timeout, so the **Backend**
indicator always resolves to `Connected`, `No API key` or `Error` — it never sits on
"Checking…". If it shows `Error`, press **Recheck backend** in the sidebar.

---

## Using the app

The status panel in the sidebar tells you where you stand at a glance:

| Indicator | Meaning |
| --- | --- |
| **Backend** | The local Node server is reachable and whether a key is configured |
| **Storage** | Your storage folder is connected, or needs permission again |
| **Profile** | Which user and language are active right now |
| **WebRTC** | The state of the live voice connection |
| **Microphone** | Whether your microphone is open, muted, or off |

**A typical session:**

1. Select (or create) a **User**, then a **Language**.
2. Set your **Lesson Comfort Level**. This is yours — the tutor never changes it.
3. Optionally press **Show Active Tutor Prompt** to read the exact instructions the
   tutor is about to receive.
4. Press **Start Call**. Allow microphone access when the browser asks.
5. The tutor greets you first. Just answer out loud — pauses are detected
   automatically, so there is no button to hold.
6. The transcript stays pinned to the newest message. Scroll up freely; a
   **Jump to latest** button appears and takes you back.
7. Press **End Call** in the bottom bar, which stays visible for the whole lesson.

Ending a call is immediate: the session stops, the microphone is released, and the
peer connection closes right away. Reviewing the lesson happens afterwards and never
holds the call open.

**Storage layout** created inside the folder you pick:

```
[Your folder]/
└── Users/
    ├── Alex/
    │   ├── German/
    │   │   └── config.json
    │   └── Japanese/
    │       └── config.json
    └── Sam/
        └── Spanish/
            └── config.json
```

These are ordinary JSON files. You can read, edit, back up or version them. If you
edit one by hand and make a mistake, the app tells you rather than failing silently.

---

## Why the tutor's prompt is short

The voice model is a small one, and everything in its instructions is
re-processed on every turn of the conversation. A prompt that tries to say
everything gets some of it followed and the rest quietly dropped — which looks
like a tutor that repeats itself, ignores its own rules, and forgets what it was
doing.

So the standing context is kept under a thousand tokens, and three rules keep it
there:

**Every rule has exactly one home.** "Keep your turns short" is in the base
rules, once. It is not repeated in each lesson, because a rule stated six ways
reads as six rules and gets followed like none of them.

**The tutor is told what applies right now, and nothing else.** A lesson
definition holds objectives, every phase, adaptation advice and completion
criteria. The tutor sees only the phase it is in — three lines — plus what has
actually happened: the words already settled, the ones still hard. Everything
else goes to the Director.

**Stable first, volatile last.** Every instruction update invalidates cached
input from the first changed byte, so the parts that change mid-lesson sit at the
very end.

There are no function tools. There used to be five, costing about a thousand
tokens of standing context on every turn, and the voice model never called them
once. That work moved:

```
you  <-- talks -->  Realtime tutor        (small prompt, no tools)
                          |
                    transcript
                          |
                          v
                    Lesson Director        (gpt-4o-mini, every few turns)
                          |
              objectives, vocabulary, phase
                          |
                          v
                    the app decides
```

The Director reads the last few turns and reports what happened. The app applies
it, and pushes a one-line brief to the tutor when the lesson actually moves.
The tutor is never interrupted to file paperwork, and if the Director fails the
lesson simply carries on.

`npm run test:lessons` includes a prompt budget: the base prompt must stay under
1,200 tokens, a lesson carrying no reference data under 1,450, and no lesson in
any phase may exceed 2,000. Those tests fail if the prompt starts growing again.

### The blocks worth their tokens

The budget has been raised twice, each time to buy a rule the small model will
not infer. Both came out of reading a session log.

**The ban on praise (900 → 1,000).** Left to itself the model opens almost
every turn by grading the student — in one 23-minute session, 71% of its 86
turns began with "Sugoi!", "Nice!", "Daijoubu!" or "that's great", and the
average turn ran to 31 words against a rule asking for one or two sentences. A
small model does not infer "stop complimenting me" from a brevity rule, so the
banned words are listed, the shape of a turn is stated as a rule with no third
part, and the useless phrasings — "a small tweak", "almost there" — are named
so they can be avoided. A correction must say which *kind* of thing was wrong:
the sound, the word, the particle, the order. The same section forbids
announcing a change of direction, because "now let's switch it up" followed by
the same task is worse than not changing at all.

That fix had a side effect worth recording: the model stopped saying "Sugoi!"
and started opening with "Particle:" instead — a label on every turn, including
ones where the student was right, and once just the bare word "Clock." Banning
one tic taught it another. The rule now says explicitly that when nothing was
wrong there is no label and no comment.

**Meaning, and the reversal (1,000 → 1,200).** The session after that was
smooth, well-paced, correct — and 72% of its 105 turns were "Next, say X", with
only 14% carrying any English. The student asked what something meant ten
times, once in so many words: *"I don't know what any of these things mean. I'm
saying them, but I'm not getting anything out of this."*

So: every phrase the tutor asks for comes with its meaning in the same breath,
and this is stated as not optional and not a one-off explanation. Then, once an
item is settled, the direction reverses — the tutor gives the English and the
student produces the target language, without being shown it first. Recognising
a phrase is not knowing it, and only the second direction tells you which one
the student has.

The reversal needs no new bookkeeping. The runtime already counted how many
times each item had been produced correctly, and already listed the settled ones
in the prompt — as `Done — do not ask for these again`, which stopped the echo
loop but threw the material away. Those are precisely the items ready to be
asked for backwards, so the line now reads `Ask for these from the English,
never say the Japanese first`. Same data, opposite instruction.

The Lesson Director polices it. Alongside factual errors it now returns
`unglossed` — phrases the tutor asked for without ever saying what they meant —
and the app turns that into a correction mid-call. Asking a settled phrase from
the English is explicitly *not* an omission, so the reversal does not trip it.

---

## Session logs

A voice lesson is the hardest kind of bug to chase. It is gone the moment it
happens, the transcript on screen is a rendering rather than the truth, and the
two questions that matter most are invisible: **what did the tutor actually
hear**, and **what was it actually told?**

So every call writes `Logs/<timestamp>-<id>.jsonl` — one JSON object per line,
appended as it happens, readable while the call is still running.

```powershell
npm run logs                  # the newest session, summarised
npm run logs -- --full        # every event, prompt text included
npm run logs -- --list        # what sessions exist
npm run logs -- --prompt 2    # read the 2nd instruction set in full
npm run logs -- <file>.jsonl  # a specific session
```

The summary opens with what is worth looking at, then the instructions sent,
the Director's passes, and the conversation with the nudges interleaved:

```
WORTH LOOKING AT
   ? 00:00  Prompt "initial" carries no # REFERENCE even though the language has
        numbers, time. Either this phase declares none, or the browser is running
        an older build — hard-refresh and try again.
  !! 00:41  Tutor chained two tens words — never a Japanese number: "Now try
        saying sanjuu sanjuu, the same style but with a little rhythm."

INSTRUCTIONS SENT (3)
  [1] 00:00  initial           2790 chars  reference  lesson:numbers
  [2] 04:12  lesson-changed    2841 chars  reference  lesson:larger_numbers

CONVERSATION
  00:41  TUTOR    Now try saying sanjuu sanjuu...
  00:52  YOU      san juu san juu
  01:37  nudge >  You said "sanjuu sanjuu is fine". That is wrong...
```

**What is recorded:** the full instruction text on every push and the reason for
it, every transcription in both directions, every out-of-band nudge, every
Director request and response, phase changes, session errors, and the final
memory extraction.

**The stale-build trap.** The most common cause of "it ignored its own rules" is
a browser still running the previous build — restarting the server is not enough,
the page has to be hard-refreshed. The review tool checks for exactly that: a
prompt with no reference section during a phase whose language has one.

**Privacy and size.** Everything passes through the same `redact()` the rest of
the server uses, and any field named like a credential is dropped. `Logs/` is
git-ignored, each file stops at 8 MB, and the fifty most recent sessions are
kept. Set `LOG_SESSIONS=0` in `.env` to turn the whole thing off.

---

## Hearing the student

Everything the tutor does rests on the transcription being right, and for a
beginner it often is not. In one logged session "rokujuu" came back as **블로그**
— Korean for "blog" — and the tutor replied "Rokujuu, correct." It was not
evaluating the student at all; it was pattern-matching against its own previous
turn.

The same session transcribed *"Why did you ask me to say that if it's not a
Japanese number phrase?"* perfectly. Fourteen words, flawless, seconds later, on
the same microphone. The audio was never the problem.

Two things were:

**The language hint was being dropped.** The session config sent `languages` as
an array. The field is `language`, singular, an ISO-639-1 code — so the hint was
ignored and the transcriber fell back to detecting the language itself, which is
how a beginner's Japanese came back as Korean.

**Nothing told it what to expect.** Transcription accepts a `prompt` to bias it,
and a lesson is unusually predictable: we know the language, the level, whether
the student reads romaji, the numbers the reference defines, and the vocabulary
they have practised. `shared/transcription.js` assembles that into a hint, so the
transcriber is choosing between plausible words rather than guessing from
everything it knows.

Both the hint and the config the server actually applied are written to the
session log, so `npm run logs` shows what took effect rather than what was meant
to.

The hint used to be set once, as the call began — so a lesson asked for by voice,
which had not been written by then, never had its words in it. It now follows
the lesson: each time a part is written or begins, the hint is rebuilt around
that part's words and sent to the live session (`transcription.hint` in the
log, with `updated: true`).

If transcription is still poor, `TRANSCRIBE_MODEL` in `.env` selects the model —
worth trying an alternative against the current model list.

---

## When the tutor goes quiet

`semantic_vad` does not detect silence. It judges whether the student has
finished a *thought*, and sometimes it judges wrong — the server commits the
audio, transcribes it, and then waits indefinitely for a continuation that is
never coming. On screen this is the tutor going deaf: the student spoke, the
words appeared in the transcript, and nothing answered. In one logged session it
cost 17 seconds of dead air, ended only by the student giving up and speaking
again.

Nothing in the protocol recovers from this, so the client does. When the student
stops speaking, a four-second watchdog is armed; `response.created` or the
student speaking again cancels it. If it fires, the tutor is asked for a turn
directly. Four seconds is long enough that a merely slow response is never
pre-empted — `response.created` normally arrives inside a second — and short
enough that the student has not yet concluded the app is broken.

The watchdog also clears a flag that used to get stuck. `responseActive` is set
optimistically the moment the student stops speaking, on the assumption that the
server is about to answer. When it never does, that assumption used to stand for
the rest of the call, and every turn the *app* asked for afterwards — a lesson
nudge, a correction — queued behind a response that did not exist and was
delayed by twelve seconds.

Every turn event is now logged: who asked for it, whether the server ever
created one, how it ended and why. None of this is visible on screen, and it is
the whole story when the tutor appears to hang, so `npm run logs` reports
unanswered turns directly.

---

## Language reference

A small voice model composing "sixty-one" in Japanese, while also teaching,
listening and staying in character, will sometimes get the arithmetic wrong and
say it with total confidence. Observed in real lessons: *"nijuu juu, which is
thirty"* and *"rokujuu san ichi — that's 61"*. Neither is a language failure;
both are the model improvising a rule it half-remembers.

So it does not improvise. `Languages/<Language>.json` holds the construction
rules and enough worked examples to check against:

```json
{
  "language": "Japanese",
  "reference": {
    "numbers": "Tens: 10 juu, 20 nijuu, 30 sanjuu...\n61 rokujuu ichi, 63 rokujuu san.\nA tens word ALONE is the round number. nijuu is exactly 20, never 29.\nNever chain two tens words. \"nijuu juu\" is not a number.",
    "time": "...", "money": "...", "counting": "..."
  }
}
```

Lessons stay language-agnostic. A lesson — or better, a single phase — declares
the *kind* of reference it needs, and the language file supplies the facts:

```json
"phases": [
  { "id": "prices", "name": "Prices", "reference": ["money"] }
]
```

The tutor is given only what the current phase asked for, at most two sections at
a time, and nothing at all during ordinary conversation. Add a language file and
its lessons gain reference; leave one out and nothing breaks.

### Topics, for lessons that cannot know in advance

Vocabulary Builder's subject is settled in conversation — the student says
"ingredients, meats and vegetables" — so no phase can declare what it needs. Left
to itself the tutor composed food words from memory and taught **"onion"** and
**"potato"** as the Japanese for onion and potato. (They are `tamanegi` and
`jagaimo`. `poteto` exists, but only inside dish names: `poteto sarada`.)

A language file may map subject words onto its own sections:

```json
"topics": {
  "food": ["food", "ingredient", "ingredients", "meat", "vegetable", "menu", "..."],
  "money": ["money", "price", "cost", "shopping", "..."]
}
```

Any runtime input the lesson has settled is matched against this, and a hit adds
that section — still capped at two. A greetings topic matches nothing and pays
nothing. The engine never learns what food is; a language without a `topics` map
behaves exactly as before.

The interesting part of the food section is not the word list. It is that a
blanket rule would be wrong: `tomato`, `banana`, `kyabetsu`, `piiman` and
`koohii` are loanwords that *are* the normal word, with no native alternative in
use, while `onion` and `poteto` are not. The model gets this wrong in both
directions, so the file names the exceptions explicitly rather than stating a
rule the model would have to apply.

The same facts go to the Lesson Director, so it judges the tutor against exactly
what the tutor was told. When it catches a factual slip it reports both halves —
what was said and what is correct — and the app pushes a short, authoritative
correction. A claim with no correction attached is discarded, because telling the
tutor it erred without saying how is worse than saying nothing.

---

## Lessons

By default the tutor just talks with you. A **Lesson Skill** gives it a temporary
teaching mission — a restaurant roleplay, a numbers drill — without changing who
it is or how it corrects you.

Six lessons ship with the app:

| Lesson | Type | What it is for |
| --- | --- | --- |
| Restaurant Roleplay | scenario | Being seated, ordering, handling a problem, paying |
| Train Station | scenario | Tickets, platforms, times, delays, connections |
| Numbers, Time & Money | instructional | Making numbers, prices, times and dates automatic |
| Vocabulary Builder | instructional | Five words on a topic *you* choose: met, recalled, used |
| Hotel Front Desk | scenario | Checking in, asking about the hotel, reporting a problem |
| Word Drill | drill | A quick round of words you *already have*: English in, one word back |

**Starting one.** Either pick it from **Lesson** in the sidebar, or just ask:

> "Let's do the Restaurant Roleplay lesson."

Both routes call the same `activateLesson(skillId)`, so they behave identically.

Activation deliberately needs a clear request. Saying *"I ate at a restaurant
yesterday"* starts nothing, and neither does talking about a lesson you did last
week or one you would rather not do. Saying *"Can we practise restaurants?"* gets
you a question — *"Would you like to start the Restaurant Roleplay lesson?"* —
and the lesson starts when you say yes.

**During one.** A strip above the transcript shows the lesson, the current
phase, and a rough progress figure. Progress is approximate on purpose: it comes
from objectives met and phases traversed, never from a clock.

**Moving on.** Press **Move on** in the lesson strip and the lesson advances to
its next part immediately — no negotiating with the tutor. The tutor is told at
once and changes tack on its next turn.

**How a part of a lesson runs.** Each part of a lesson is a short script, and the
app — not the voice model — decides what the tutor says next.

1. *Before the part starts*, a text model (`PLAN_MODEL`, default `gpt-4.1`) writes
   its material with the language's reference in front of it: three or four things
   worth being able to say, what each means, the moment you would say it, what the
   other person says back, and a short role-play. A second pass proofreads the
   Japanese; anything it will not vouch for is dropped. (`src/planner.js`)
2. *The app turns that into steps* (`public/shared/script.js`):
   - **teach** — `"sumimasen" means excuse me. Say it.` The note about a phrase
     comes after you have repeated it, not before.
   - **build** — once one request has been taught whole, the next is yours to make:
     `"omizu" means water. Ask for water, the way you asked for a beer.`
   - **recall** — from the moment (`You want the waiter to come over. What do you
     say?`) or from the English, and the person you said it to answers
     (`"hai, shoushou omachi kudasai" — yes, one moment please.`). A request is
     said back to you: `"omizu desu ne" — water, right?`
   - **listen** — a price or a time said to you is not translated; you are asked
     `How much is that?`. The app composes prices you have not heard from the parts
     of ones you have (`nisen yonhyaku en desu`), so it is never the same figure.
   - **role-play** — two to four exchanges. Any reply that fits is right (water
     where the plan had beer; `hai` to a yes-or-no question; two things at once),
     the waiter says back what *you* ordered, and at the end it arrives. Where the
     planner's lines are too few, the app adds moments in which you speak first.
     A part of single words has one exchange or none (`"role_play": "single"` or
     `"none"` in its lesson file): the one open question a person would ask —
     *"What will you have?"* — answered with any of the words, alone or in a
     request.
   - **quick round** — where a part asks for one (`"quick_round": true` in its
     lesson file; the vocabulary and numbers lessons do), it closes on the short
     things it taught, asked for at speed: `What is cabbage?` — *kyabetsu* —
     `What is carrot?` — *ninjin*. A right answer gets the next question and
     nothing else; a miss is told and comes round once more at the end. The
     review at the end of every lesson is one of these, and asks first for what
     was missed most.
   - **let go** — a word whose answer has had to be given twice is not asked for
     again on that call. It is said once more in the review, for you to hear
     and say (`One to hear again: …`), and named at the end as one for next time.
   - **closing line** — what you can now say and, separately, what is still to
     get. What you missed comes back early in the next part. The last part of a
     lesson says it is the last.
3. *After you speak*, the app decides the reply (`turnFor`) and asks the tutor for
   exactly that line. A right answer goes on; a wrong one is corrected by naming
   the part that differed (`It's "o", not "wa"`), with one more try; a question is
   answered in a sentence and the same thing asked again; a remark is left alone;
   `I don't know` gets the answer.
4. *When the transcript does not settle it* — the recogniser writes a beginner's
   Japanese in kana, kanji or romaji as it pleases — a text model judges the
   answer (`src/judge.js`). The same model reads a plain-English request such as
   *"can we do the shop stuff instead?"* and takes the lesson to the part it means.

What is said back to you comes with its English the first two times you hear it
and bare after that. Nothing is praised; `Hai.` means only "that was right".

**Asking for words outside a lesson.** Say *"I want to talk about vocabulary,
specifically vegetables"* or *"teach me the colors"* in ordinary conversation —
or answer the opening question with just a subject, *"About colors"* — and the
Vocabulary Builder starts on that subject at once. A sentence about how to
practise (*"single word, not sentences"*) is not taken for a subject. This matters: outside a lesson the voice model
chooses its own material with nothing checking it, and that is where it once
taught *"kore wa ni juu-san desu"* for "this is a carrot". Inside one, the words
come from the language reference and are proofread before you hear them.

**Being drilled.** Say *"Drill me on the basic colors"*, *"quiz me"*, *"I want a
drill"* or *"keep drilling me"* — in a lesson or out — and the **Word Drill**
starts: `Quick round. What is red?` — *aka* — `What is blue?`. It teaches
nothing. Its words are ones you already have: your saved vocabulary and
everything taught earlier on the call. A text model only chooses, by number,
which of them fit the subject; it cannot add a word. With no subject named, it
drills the lesson's subject, or the last one of the call, or your newest words.
Every word is asked once, in no fixed order, before any comes round again; a
miss gets `It's "aka". Next: …` and comes round once more at the end (unless it
was the very last word, when it is named instead of asked straight back). It
closes with `Drill done: 9 of 11. For next time: "haiiro" for gray. Again, or
something else?` — and *"again"* runs it again, most-missed first. With fewer
than three words on file for the subject it says so and offers to teach them
first; *"yes"* starts the Vocabulary Builder on it.

**Being heard.** On a real call your Japanese reaches the app as whatever the
speech recogniser made of it — `genkin de` has come back as "Gen keen de" and as
元気で (*genki de*); `hourensou` as "Lorenzo" and "Haorensu". Four things stand
between that and a false correction:

- *The recogniser is told what to expect, part by part.* Each time a part of a
  lesson is written or begins, its words go to the transcriber as they are
  written, as you read them, and with their English
  (`ほうれん草 (hourensou, spinach)`).
- *A letter or two out is the same word.* One letter for most things; two or
  three for a long word of vocabulary, where a vowel for a vowel or `z` for `s`
  counts half. Numbers and times get no extra room — in *shichiji* and *ichiji*
  one syllable is the whole difference.
- *Before a guess is used against you, the voice model is asked.* When the
  written version is nowhere near the answer, or there is none at all, the model
  that actually heard you is asked, outside the conversation, whether you said
  it (`script.ear` in the log). Yes, and it was right.
- *Nothing is called wrong on nothing.* If you spoke and it could not be made
  out, the tutor says `Sorry, I didn't catch that.` and asks again; a second
  time running, the lesson goes on.

What is still corrected: a different word, a swapped little word (`wa` for `o`),
a question with its `ka` left off, a missing syllable.

**Taking turns.** The session decides when a stretch of speech has ended, and it
can decide too soon: *"toumorokoshi to ramu…"* — a breath — *"…kudasai"* once
arrived as two turns and was answered twice. So the app answers a turn, not a
stretch (`public/shared/turns.js`): anything you say before the reply to the
first part can be heard is put together with it and answered once; something
that trails off (*"… to"*, *"um"*) is waited on a little longer; and a sound with
no words in it — a cough, the tutor's own voice in the microphone — is not an
answer to anything. If such a sound cut the tutor off, it says its line again.

**Going back.** Asked *"Ready for the next part?"*, any kind of no — "not ready",
"go back", "again" — takes you back through the part that has just closed: what
you had is asked for, and only what you missed is taught again. At any other
time, *"go back"* or *"I didn't want you to move on"* returns to the part you were
in before.

Two settings in `.env` change this:

| Setting | Default | Effect |
| --- | --- | --- |
| `TUTOR_TURNS` | `app` | `app`: the app chooses each reply, as above. `server`: the older behaviour — the voice model replies on its own from its standing instructions. Use it if a call ever goes quiet after you speak. |
| `PLAN_MODEL` | `gpt-4.1` | The model that writes each part's material. Falls back to `MEMORY_MODEL` if the account cannot use it. |
| `TURN_EAGERNESS` | `low` | How patient the session is about deciding you have finished speaking. `low` lets you pause to think. Set `auto` if replies feel slow to come. |
| `MIC_NOISE_REDUCTION` | *(off)* | `near_field` for a headset, `far_field` for a laptop or desk microphone. Worth trying if the tutor is cut off by sounds that are not you speaking. |

Restart `npm start` and hard-refresh the page (Ctrl+Shift+R) after changing either,
or after updating the app.

Where a part has no script — the planner failed, or `TUTOR_TURNS=server` — the
older rules below apply.

**Pacing.** Every lesson carries the same hard rules against going round in
circles: ask for the same item at most twice in a row; once the student has
produced something correctly twice it is finished for that lesson; and never say
the word you are asking the student to recall, because that is repetition, not
recall. The app counts the student's turns, so if a phase drags or the tutor
stops recording progress, the tutor is told so mid-call — by name, pointed at the
next part of the lesson — without waiting for the student to complain.

**Who moves the lesson along.** The Lesson Director watches the transcript and
decides when a part of the lesson is done. If it is unavailable — or simply has
nothing to say — the app advances the phase itself after ten of the student's
turns with no progress recorded. Either way the tutor is told, in one line, and
never has to work it out.

**Progress is not the same as activity.** Only two things count as the lesson
moving: an objective changing state, or the phase changing. Vocabulary
deliberately does not — the Director notes vocabulary on almost every pass,
because that is its job, and it says nothing about whether the lesson is
advancing.

This distinction is load-bearing. When vocabulary counted, a real 23-minute
session ran the Director 27 times, noted vocabulary on 24 of them, and changed
the phase twice in the whole call. The clock that triggers both the staleness
nudge and the automatic advance was reset every few seconds, so neither could
ever fire: the lesson sat in one phase for 63 of the student's turns, asking for
the same four words, while the progress bar froze at 39%. `npm run logs` now
reports a phase that never ends.

**And it cannot quit early.** A lesson that is not at its last phase, with
nothing recorded as achieved, cannot be finished — the app refuses it however
confidently the Director asks. A student who wants to stop is never blocked:
that is **Back to conversation**, or just saying so, both of which end the lesson
immediately.

The lesson never overrides you. Ask a question in English, ask for something
simpler or harder, skip an activity, or say *"let's just chat"* — the tutor
follows you, not the lesson. The order of authority is written into the prompt:

```
safety  >  what you ask for  >  base tutor rules  >  the lesson  >  the phase
```

**Ending one.** Say so, press **Back to conversation**, or let the tutor finish
it when the objectives are met. Finishing a lesson does **not** end the call —
the conversation carries straight on.

**What lessons do not do.** They cannot change your Lesson Comfort Level, and
they do not get their own memory. Vocabulary met in a lesson is simply
vocabulary; a difficulty seen in a lesson is simply a weakness. Both go into the
same two pools in your `config.json`, through the same end-of-call extraction.

Lesson state is temporary. Stop a lesson halfway and there is nothing to resume:
next time it starts fresh. What you learned stays, because that lives in your
profile.

---

## Writing your own lesson

Lessons live in `Lessons/`, one folder each, and are discovered at startup:

```
Lessons/
├── restaurant/
│   └── lesson.json
├── train_station/
│   └── lesson.json
└── your_new_lesson/
    └── lesson.json
```

Add a folder with a valid `lesson.json`, press **Reload lessons** in the sidebar
(or restart the server), and it appears in the selector. No JavaScript changes,
anywhere. A lesson is data, and the engine has never heard of any specific one.

The smallest thing that works:

```json
{
  "id": "market",
  "name": "At the Market",
  "type": "scenario",
  "activation": { "voice_triggers": ["market lesson", "market roleplay"] },
  "objectives": [
    { "id": "ask_price", "description": "Ask what something costs.", "required": true }
  ],
  "phases": [
    { "id": "warmup", "name": "Warm up", "purpose": "Settle in." },
    { "id": "roleplay", "name": "Roleplay", "purpose": "Run the market visit." }
  ]
}
```

The full set of fields:

| Field | What it does |
| --- | --- |
| `id` | Stable internal id. Lowercase, digits, underscores. Should match the folder name. |
| `name` | What the student sees. Change it freely; nothing references it. |
| `description` | One line, shown in the selector and given to the tutor. |
| `type` | `scenario`, `instructional`, `drill` or `review`. |
| `version`, `schema_version` | Yours, and the engine's. A future `schema_version` is refused with a clear message. |
| `activation.voice_triggers` | Unmistakable phrases. A match starts the lesson. |
| `activation.voice_aliases` | Loose phrases. A match asks for confirmation instead. |
| `activation.confirmation_behavior` | `confirm_when_ambiguous` (default), `always_confirm`, `never_confirm`. |
| `runtime_inputs` | Things to ask the student, e.g. a topic. `text`, `number`, `boolean`, `select`, `multiselect`. Temporary — never written to the profile. |
| `objectives` | `{id, description, required, weight, success_indicators}`. Drives progress and completion. |
| `teaching_philosophy` | Free text. How this lesson should feel. |
| `content` | `target_vocabulary`, `suggested_vocabulary`, `target_grammar`, `scenarios`. |
| `phases` | `{id, name, purpose, instructions, activities, entry_guidance, advancement_guidance, completion_guidance, objectives}`. |
| `adaptation` | `if_struggling` and `if_succeeding`. |
| `completion` | `criteria`, `min_required_objectives`, `announcement_guidance`. |
| `memory` | What is worth noticing for the student's ordinary memory. |

Two rules worth knowing before you write one.

**Write a framework, not a script.** Phases are guidance. The tutor may stay in
one, repeat it, skip ahead or go back whenever there is a teaching reason. If you
find yourself writing the tutor's sentences, you are writing the wrong thing.

**Never put a prompt in the JSON.** There is no `"prompt"` field and adding one
does nothing. The tutor's instructions are composed at call time from the base
tutor, your profile, the lesson, and the current phase. Press **Show Active
Tutor Prompt** mid-lesson to read exactly what the model has.

Everything is validated on load. A broken lesson costs you that one lesson: it is
named in the sidebar with the reason, and every other lesson keeps working. The
checks cover malformed JSON, a missing or duplicate id, an unknown type,
duplicate phase or objective ids, unknown runtime input types, references to
objectives that do not exist, and an incompatible schema version.

The schema is deliberately structured — stable ids everywhere, enumerated values
where consistency matters, free text only where teaching creativity helps — so a
graphical Lesson Editor can be built on it later without touching the engine.

---

## How memory works

After each lesson the transcript is sent — through the local backend — to
`gpt-4o-mini`, which returns weaknesses, vocabulary, and an assessment of the level
you demonstrated. The result is **merged** into your profile:

```
existing weaknesses + new weaknesses  ->  deduplicate  ->  save
existing vocabulary + new vocabulary  ->  normalize -> deduplicate -> save
```

Vocabulary is a persistent **review pool**, capped at the 60 most recent items, not a
lesson script. The tutor is instructed to reuse only one to three relevant items per
conversation and not to reteach words you have already shown you know.

Individual numbers never enter the pool. A single numbers lesson would otherwise
produce twenty of them — `rokujuu ichi — sixty-one`, `sanbyaku — three
hundred` — filling every slot, evicting the real words, and then feeding the same
numerals back as things to revise next lesson. A number is generated from a rule
rather than remembered as an item, so what is worth carrying between lessons is the
range you have worked in. Numerals and clock times collapse into one of five
categories:

`numbers 1-20` · `numbers up to 100` · `numbers in the hundreds` ·
`numbers in the thousands` · `telling the time`

Both bookkeeping prompts (the Lesson Director and the post-lesson extractor) are told
to return the category rather than the numbers, and `normalizeVocabList` collapses any
that slip through — including numerals already sitting in a saved profile, which are
repaired the moment it loads. Words that merely contain a number, like `hyaku en —
100 yen` or `futatsu — two (things)`, are left alone.

If extraction fails — no key, no network, a bad response — your existing memory is
returned untouched and saved as-is. A failed lesson never costs you your vocabulary.

`config.json` fields:

| Field | Written by | Notes |
| --- | --- | --- |
| `tutor_name` | You | Editable in the sidebar |
| `target_language` | The app | From the folder name |
| `user_name` | The app | From the folder name |
| `script_style` | The app | `Romaji` for Japanese, `Standard` otherwise |
| `proficiency_level` | **You only** | Your Lesson Comfort Level |
| `known_weaknesses` | AI, merged | Never replaced wholesale |
| `recent_vocab` | AI, merged | Always plain strings, max 60, numerals collapsed to ranges |
| `last_lesson_date` | The app | ISO timestamp |
| `ai_assessed_level` | AI | Advisory only |
| `assessment_history` | AI | Last 10 assessments, `{date, level}` |

Older `config.json` files are migrated automatically when opened. Missing fields are
added; nothing existing is overwritten or removed.

---

## Lesson Comfort Level vs AI Assessed Level

These are deliberately separate, and the distinction matters.

**Lesson Comfort Level** (`proficiency_level`) answers *how difficult do you want
your lessons to be?* You set it, and it stays where you put it. The AI cannot raise
it because you had a good day, or lower it because you fumbled a sentence.

The six levels are:

```
Absolute Beginner
Beginner
Beginner-Intermediate
Intermediate
Upper Intermediate
Advanced
```

**AI Assessed Level** (`ai_assessed_level`) answers *what did the student actually
demonstrate?* It is recorded after every lesson and kept in `assessment_history`.

A recommendation appears only when:

- at least **three** lessons have been assessed, and
- the most recent three consistently point the same way.

Then the memory card says something like *"You may be ready to try Beginner."* with an
**Apply Beginner** button. Nothing changes unless you press it. If the recent
assessments are mixed or sit at your current level, it simply says
*"Current level looks appropriate."* and shows no button.

Recommendations move one level at a time, in either direction, and a downward one is
always phrased as an option — *"Consider staying at X for now."* — never applied for you.

---

## Japanese profiles

When `target_language` is `Japanese`, the app switches to Romaji-only display:

- The tutor is instructed to write and speak **Romaji only** — never kanji, hiragana
  or katakana, and never the same sentence twice in two scripts.
- Your own speech is transcribed in Japanese, kept in its **original script** for
  memory extraction, and **displayed** in Romaji.

The conversion covers full hiragana and katakana, digraphs, small kana, sokuon
gemination, long vowels, Japanese punctuation, a dictionary of common lesson
vocabulary in kanji, and per-character readings for common kanji beyond it. Anything
it genuinely cannot read is shown as `[?]` rather than as Japanese script.

Roman-alphabet languages (German, Spanish, French, and so on) display normally.

---

## Project structure

```
kaiwa/
├── package.json
├── package-lock.json
├── server.js                  Express app, static files, error handling
├── LICENSE                    MIT
├── tools/build.mjs            Builds a release executable for one platform
├── .github/workflows/         Tests on every push; builds the releases from a tag
├── .env                       Optional settings (git-ignored)
├── .env.example
├── .gitignore
├── README.md
├── src/                       Server-only code
│   ├── config.js              Environment config; the key lives and dies here
│   ├── paths.js               App folder and per-user data folder, source or release
│   ├── openai.js              Timeout-aware OpenAI client, key redaction
│   ├── lessons.js             Lesson discovery and validation
│   ├── director.js            The Lesson Director, on gpt-4o-mini
│   ├── planner.js             Writes and proofreads each part's material
│   ├── judge.js               Was that answer right? Which part did they ask for?
│   ├── reference.js           Per-language facts the tutor must not improvise
│   ├── logging.js             Session logs, redacted, one JSONL per call
│   └── routes/
│       ├── health.js          GET  /api/health
│       ├── realtime.js        POST /api/realtime/session, /api/realtime/sdp
│       ├── lessons.js         GET /api/lessons, POST /api/lessons/plan, /judge, /direct
│       ├── memory.js          POST /api/memory/extract
│       └── settings.js        GET/PUT/DELETE /api/settings/api-key
├── public/
│   ├── language_tutor.html    The app shell
│   ├── styles.css
│   ├── js/                    Browser-only code
│   │   ├── app.js             Wiring: status, profiles, call lifecycle
│   │   ├── storage.js         File System Access + IndexedDB persistence
│   │   ├── realtime.js        WebRTC session and event handling
│   │   └── transcript.js      Conversation view and autoscroll
│   └── shared/                Imported by BOTH the server and the browser
│       ├── levels.js          The six comfort levels
│       ├── vocab.js           Normalisation, dedup, merging
│       ├── assessment.js      History and recommendation logic
│       ├── profile.js         Defaults and config migration
│       ├── prompt.js          The tutor prompt generator
│       ├── romaji.js          Japanese -> Romaji display conversion
│       ├── lesson-schema.js   Lesson JSON schema, validation, registration
│       ├── lesson-runtime.js  Temporary state of the running lesson
│       ├── script.js          A part as steps; the tutor's line for every answer
│       ├── conductor.js       Turn by turn: decide the reply, keep the place
│       ├── lesson-prompt.js   The Skill layer of the tutor prompt
│       ├── lesson-activation.js  Deciding what counts as "start a lesson"
│       ├── turns.js           What one turn of the student's is: joins, waits, noise
│       └── transcription.js   The hint that tells speech-to-text what to expect
├── Languages/                 Per-language reference facts
│   ├── Japanese.json
│   └── German.json
├── Lessons/                   One folder per Skill, discovered at startup
│   ├── restaurant/lesson.json
│   ├── train_station/lesson.json
│   ├── numbers_time_money/lesson.json
│   ├── vocabulary_builder/lesson.json
│   └── hotel_front_desk/lesson.json
├── tools/
│   ├── review-log.mjs         npm run logs
│   ├── log-analysis.mjs       The checks it runs
│   └── sim/                   Test students: worker, client, spend ledger, brief
├── Logs/                      Session logs (git-ignored)
└── test/
    ├── verify.mjs             Logic and integrity checks
    ├── lessons.mjs            The Lesson Skills Framework
    ├── logging.mjs            Session logging and the review tool
    ├── sim.mjs                The test harness and its spend cap
    ├── smoke-dom.mjs          Runs the real app against a DOM
    ├── smoke-flow.mjs         Drives the full user flow
    ├── smoke-call.mjs         A whole call in a real browser, the session played by the test
    └── fixtures/lessons/      Deliberately broken Skills, for the tests
```

`public/shared/` lives under `public/` on purpose: the folder path and the URL path
then agree, so `../shared/levels.js` resolves identically in Node and in the browser.
There is one implementation of every memory rule, used by both sides.

**Why the prompt preview is trustworthy:** `shared/prompt.js` is the only thing that
builds tutor instructions — with or without a lesson. **Show Active Tutor Prompt**
displays the output of that same function, passed the same lesson state, so the
preview cannot drift from what the model actually receives.

---

## Test students (the simulation harness)

`tools/sim/` runs the real tutor — the same prompt, planner, judge and lesson
code as the app — against a scripted or AI "student", in text, so a change can be
tried without a call. It never touches `Users/` or `Logs/`: a test session reads
a profile and writes only under `tools/sim/runs/`.

```powershell
npm run sim:worker        # leave running; it is the only thing that calls OpenAI
npm run sim -- start --lesson restaurant --level "Absolute Beginner"
npm run sim -- say <session> "sumimasen"
npm run sim -- end <session>
npm run sim -- plan --lesson numbers_time_money   # what the planner writes, no call
npm run sim:spend         # what testing has cost so far
```

Every call goes through a spend ledger (`tools/sim/budget.mjs`): its worst
possible cost is reserved before it is made and replaced by the real figure
afterwards, and a call that would cross the stop line is never sent. The line is
$7.50 at published prices — the meter doubles the published-price total and stops
at $15 — under a hard limit of $20. Restart the worker after updating the app, so
that it picks up the current ledger rules.

`tools/sim/STUDENT_BRIEF.md` is what a test student is told: how to behave, what
to probe, and what to report.

---

## Tests

```powershell
npm test
```

**521 checks in four suites**, all run by `npm test`. None of them calls OpenAI.

`test/verify.mjs` — 57 checks covering vocabulary normalisation and merging,
assessment history and recommendation thresholds, config migration, the default
profiles, Romaji conversion, prompt generation, and project integrity (no
placeholders, every DOM id used by `app.js` exists in the HTML, every API path the
frontend calls is defined by the backend, no API key value can reach client code).

`test/logging.mjs` — 33 checks covering session logging and the review tool: the
log is valid JSONL at every moment so a live session can be read, the API key can
never reach a file, a session id from the browser is constrained hard, and the
review checks survive a half-written log.

`test/sim.mjs` — 23 checks covering the test harness: the spend cap (a call that
would cross the stop line is refused and costs nothing; calls in flight count; a
corrupt ledger stops everything), a whole session against a mock API, and that no
test session can touch a saved profile, the app's own logs, or the key.

`test/lessons.mjs` — 408 checks covering the Lesson Skills Framework and the
scripted lesson: how a plan becomes steps, what the tutor says for each kind of
answer, corrections, the judge, role-plays, build and listening steps, composed
prices, and each defect a test student found, pinned so it cannot come back. It
began as discovery of
all five Skills, seven deliberately broken fixtures that must not take the app
down, voice activation and — just as important — the absence of false activation,
ambiguous requests producing confirmation rather than a guess, runtime inputs and
tutor-chosen topics, adaptive phase movement in all four directions, progress and
completion, lesson observations reaching the existing memory extractor, the
comfort level staying untouchable, Romaji rules surviving underneath a lesson,
and the prompt layer appearing and disappearing cleanly. A final group pins the
defects found during review, so they cannot come back: a bad lesson id must not
kill the lesson that is running, a tool result must not carry the whole lesson
definition back into the conversation, talking *about* a lesson must never start
one, and a library reload must not orphan a running lesson. A further group pins
the fixes from the first live session: the `hidden` attribute must actually hide,
a single user must be properly selected rather than merely displayed, a dragging
phase must be flagged to the tutor, and a word produced correctly twice must be
left alone. A last group covers the first real lesson: a lesson must not be
finished from its opening phase, must not stall there either, and a progress
figure of 0% for a lesson that is visibly under way reads as a broken bar, so a
started lesson reports at least 5%. And one more covers the tutor going quiet:
a lesson that has just started hands the tutor instructions it did not have when
it last spoke, so it must always get a turn to act on them, whether the lesson
was started by the tutor, by the student's own words, or from the sidebar. The
last group replays the session's own event stream offline to prove the
turn-taking holds: a turn asked for in the moment between the student falling
silent and the server announcing its reply must wait, several requests in one
window must collapse into one, and losing that race anyway must be recovered
from silently rather than printed in the student's transcript.

```powershell
npm run test:lessons   # the Lesson Skills suite on its own
```

Two deeper tests run the real application against a simulated browser. They need
`jsdom`, which is deliberately not a project dependency:

```powershell
npm install --no-save jsdom
npm run test:dom     # boots the real page and app.js; checks status indicators,
                     # controls, dialogs, and the transcript view
npm run test:flow    # drives pick folder -> select user -> select language ->
                     # migrate config -> change level, against a fake filesystem
```

And one runs a whole call in a real browser with nobody on the other end: the
page is the real one, and the test plays the Realtime session — it sends the
events a session sends (speech started, a transcript, a reply being spoken) and
reads what the page asks the session for. It is the only test of what happens
between a microphone event and a line being asked for: an answer split by a
pause, a reply taken back because you carried on, a transcript of noise, none
at all, a click, a cough that cuts the tutor off — and a drill of saved words
asked for in ordinary conversation. It needs Playwright, calls
nothing at OpenAI, and writes nothing to `Users/` or `Logs/`:

```powershell
npm install --no-save playwright
npx playwright install chromium
npm run test:call
```

What it cannot show is how the real session behaves: whether `low` eagerness
waits as long as you would like, and how well the voice model judges what it
heard. Those only show on a call.

---

## Troubleshooting

**A red bar in the transcript saying "Conversation already has an active
response in progress"**
This should no longer happen: the app queues its own turn requests behind the
tutor's, and recovers silently if the server refuses one anyway. If you do see
it, the session is out of step — end the call and start a new one.

**Backend: Error**
The Node server is not running or not reachable. Start it with `npm start`, then press
**Recheck backend**. If the port is busy, change `PORT` in `.env` and restart.

**Backend: No API key**
The server started but `.env` has no `OPENAI_API_KEY`. Add it and restart the server —
`.env` is only read at startup.

**Storage: Unsupported**
You are not in Chrome or Edge. Open <http://localhost:3000> in one of those.

**Storage: Permission Required**
Chrome asks again for folder access after a restart. Press **Regrant access** in the
sidebar. If the folder has moved or been deleted, press **Select storage folder** and
pick it again.

**The microphone is blocked**
Click the padlock in the address bar, allow the microphone for `localhost`, and start a
new call. On Windows also check Settings → Privacy & security → Microphone.

**The call fails to start**
The app tries a direct connection first and then a relay through your own server, and
reports both failures. Common causes: an invalid or unfunded API key, no internet, or
a corporate firewall blocking WebRTC. Check the server terminal for details.

**No audio from the tutor**
Some browsers block autoplay until you interact with the page. Click anywhere on the
page. Also check the tab is not muted and your output device is correct.

**Memory did not update after a lesson**
The transcript may have been too short to assess — the app says so. If extraction
failed, the message says why and your existing memory is left exactly as it was.

**Something went wrong in a lesson and I want to know why**
Run `npm run logs` straight afterwards — it works on a session still in progress.
Send the summary, or the whole file from `Logs/`, along with what you saw.

**The tutor keeps agreeing with things I did not say**
Check the transcriptions in `npm run logs` — the "YOU" lines are what it actually
heard, which for Japanese is not what the screen shows. If they are garbage, the
tutor is answering noise rather than you.

**The tutor got a number or a form wrong**
Check whether `Languages/<your language>.json` exists and has a section for it.
Only Japanese and German ship with one; add a file for another language and its
lessons pick it up on the next **Reload lessons**. The tutor is also told to
check itself when you challenge it, so saying "that doesn't look right" is worth
doing — it should correct itself plainly rather than argue.

**A lesson is missing from the selector**
Its `lesson.json` failed validation. The sidebar lists the file and the reason
underneath the lesson selector. Fix the file and press **Reload lessons** — no
restart needed. The server also prints the same reasons at startup.

**The tutor will not start a lesson when I ask**
Activation needs an unmistakable request. Try the lesson's name in full: *"Let's
do the Restaurant Roleplay lesson."* Or pick it from the sidebar. The bar is
deliberately high so that ordinary conversation about restaurants, hotels or
trains never derails into a lesson.

**A profile will not load**
`config.json` is probably not valid JSON. The app tells you which file and what the
parse error was, then offers a fresh profile. Your damaged file is not overwritten
until you save.
