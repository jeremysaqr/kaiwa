/**
 * tools/review-log.mjs
 *
 * Turn a session log into something a person — or Claude — can read.
 *
 *   npm run logs                  the newest session, summarised
 *   npm run logs -- --full        every event, including prompt text
 *   npm run logs -- --list        what sessions exist
 *   npm run logs -- --sim         the test harness's runs, not real calls
 *   npm run logs -- <file>        a specific session
 *   npm run logs -- --prompt 2    print the Nth prompt in full
 *
 * The summary answers the questions that actually come up after a bad lesson:
 * what was the tutor told, what did it think it heard, what did it say, and
 * did the Director ever run.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findings } from './log-analysis.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const argv = process.argv.slice(2);

// `--sim` reads the test harness's runs instead of real calls. They are kept
// apart on purpose: "the most recent session" should always mean a real one.
const LOGS_DIR = argv.includes('--sim')
  ? path.join(ROOT, 'tools', 'sim', 'runs')
  : process.env.LOGS_DIR
    ? path.resolve(process.env.LOGS_DIR)
    : path.join(ROOT, 'Logs');

const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : '';
};

/** @param {number} seconds */
function clock(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** @param {string} text @param {number} width */
function wrap(text, width = 96, indent = '         ') {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + word).length > width) {
      lines.push(line.trimEnd());
      line = '';
    }
    line += `${word} `;
  }
  if (line.trim()) lines.push(line.trimEnd());
  return lines.join(`\n${indent}`);
}

async function sessionFiles() {
  let entries = [];
  try {
    entries = (await readdir(LOGS_DIR)).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const detailed = await Promise.all(
    entries.map(async (name) => {
      const info = await stat(path.join(LOGS_DIR, name)).catch(() => null);
      return { name, bytes: info?.size ?? 0, at: info?.mtimeMs ?? 0 };
    }),
  );
  return detailed.sort((a, b) => b.at - a.at);
}

/** Parse a .jsonl file, tolerating a half-written final line on a live session. */
async function readEvents(file) {
  const text = await readFile(file, 'utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A session still being written can end mid-line. That is not an error.
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderSummary(file, events) {
  const start = events.find((event) => event.type === 'session.start') || {};
  const end = events.find((event) => event.type === 'session.end');
  const prompts = events.filter((event) => event.type === 'prompt');

  console.log('='.repeat(100));
  console.log(path.basename(file));
  console.log(
    `${start.user || '?'} · ${start.language || '?'} · ${start.level || '?'} · tutor ${start.tutor || '?'}` +
      `${end ? ` · ${clock(end.durationSeconds)} long` : '  (still running)'}`,
  );
  console.log(
    `lesson at start: ${start.lesson || 'none'}` +
      `${start.phase ? ` / ${start.phase}` : ''} · reference available: ${(start.referenceLanguages || []).join(', ') || 'none'}`,
  );
  console.log('='.repeat(100));

  const flagged = findings(events);
  if (flagged.length) {
    console.log('\nWORTH LOOKING AT');
    for (const item of flagged) {
      console.log(`  ${item.level === 'error' ? '!!' : ' ?'} ${clock(item.at)}  ${wrap(item.text, 88, '        ')}`);
    }
  }

  console.log(`\nINSTRUCTIONS SENT (${prompts.length})`);
  prompts.forEach((prompt, index) => {
    const bits = [
      prompt.hasReference ? 'reference' : '',
      prompt.hasLesson ? `lesson:${prompt.phase || '?'}` : '',
      prompt.hasCatalogue ? 'catalogue' : '',
    ].filter(Boolean);
    console.log(
      `  [${index + 1}] ${clock(prompt.at)}  ${String(prompt.reason).padEnd(16)} ` +
        `${String(prompt.chars).padStart(5)} chars  ${bits.join('  ')}`,
    );
  });
  console.log('  (npm run logs -- --prompt N  to read one in full)');

  const directorRuns = events.filter((event) => event.type === 'director.response');
  if (directorRuns.length) {
    console.log(`\nLESSON DIRECTOR (${directorRuns.length} passes)`);
    for (const run of directorRuns) {
      if (!run.ok) {
        console.log(`  ${clock(run.at)}  FAILED  ${run.error || ''}`);
        continue;
      }
      const applied = run.applied || {};
      const parts = [];
      if (applied.objectives) parts.push(`objectives +${applied.objectives}`);
      if (applied.inputs) parts.push(`inputs +${applied.inputs}`);
      if (applied.vocabulary) parts.push('vocabulary noted');
      if (applied.phaseChanged) parts.push(`phase -> ${applied.phaseName}`);
      if (applied.completed) parts.push('COMPLETED');
      if (applied.errors?.length) parts.push(`${applied.errors.length} tutor error(s) corrected`);
      console.log(`  ${clock(run.at)}  ok      ${parts.join(', ') || 'nothing changed'}`);
      for (const error of applied.errors || []) {
        console.log(`            said "${error.said}" -> ${error.correct}`);
      }
    }
  }

  console.log('\nCONVERSATION');
  for (const event of events) {
    if (event.type === 'student') {
      console.log(`  ${clock(event.at)}  YOU      ${wrap(event.text)}`);
    } else if (event.type === 'tutor') {
      console.log(`  ${clock(event.at)}  TUTOR    ${wrap(event.text)}`);
    } else if (event.type === 'nudge') {
      console.log(`  ${clock(event.at)}  nudge >  ${wrap(event.instruction, 88, '           ')}`);
    } else if (event.type === 'lesson.change') {
      console.log(`  ${clock(event.at)}  --       lesson ${event.from || 'none'} -> ${event.to || 'none'} (${event.reason})`);
    } else if (event.type === 'lesson.phase' || event.type === 'lesson.autoAdvance') {
      console.log(`  ${clock(event.at)}  --       phase -> ${event.to}${event.reason ? ` (${event.reason})` : ''}`);
    } else if (event.type === 'realtime.error') {
      console.log(`  ${clock(event.at)}  ERROR    ${event.message}`);
    }
  }

  const memory = events.find((event) => event.type === 'memory.extract');
  if (memory) {
    console.log('\nMEMORY');
    console.log(
      `  ${memory.ok ? 'saved' : 'FAILED'} ${memory.error || ''} · ` +
        `+${memory.added?.vocab || 0} vocab, +${memory.added?.weaknesses || 0} weaknesses · assessed ${memory.assessed || '—'}`,
    );
  }
  console.log('');
}

function renderFull(events) {
  for (const event of events) {
    console.log(`${clock(event.at)} ${event.type}`);
    const { type, at, seq, ...rest } = event;
    for (const [key, value] of Object.entries(rest)) {
      if (typeof value === 'string' && value.includes('\n')) {
        console.log(`  ${key}:`);
        for (const line of value.split('\n')) console.log(`    | ${line}`);
      } else {
        console.log(`  ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }
    console.log('');
  }
}

// ---------------------------------------------------------------------------

const files = await sessionFiles();

if (has('--list')) {
  if (!files.length) console.log(`No sessions in ${LOGS_DIR}`);
  for (const entry of files) {
    console.log(`${entry.name}  ${String(Math.round(entry.bytes / 1024)).padStart(5)} KB  ${new Date(entry.at).toISOString()}`);
  }
  process.exit(0);
}

const named = argv.find((arg) => arg.endsWith('.jsonl'));
const target = named
  ? path.isAbsolute(named)
    ? named
    : path.join(LOGS_DIR, path.basename(named))
  : files[0] && path.join(LOGS_DIR, files[0].name);

if (!target) {
  console.log(`No session logs in ${LOGS_DIR}.`);
  console.log('Start a call and one will appear. Set LOG_SESSIONS=0 to disable logging.');
  process.exit(0);
}

const events = await readEvents(target);

const promptIndex = Number(valueOf('--prompt'));
if (promptIndex) {
  const prompts = events.filter((event) => event.type === 'prompt');
  const chosen = prompts[promptIndex - 1];
  if (!chosen) {
    console.log(`Only ${prompts.length} prompts in this session.`);
    process.exit(1);
  }
  console.log(`# prompt ${promptIndex} of ${prompts.length} — ${chosen.reason} at ${clock(chosen.at)}`);
  console.log(`# ${chosen.chars} chars · reference:${chosen.hasReference} lesson:${chosen.hasLesson}\n`);
  console.log(chosen.instructions);
  process.exit(0);
}

if (has('--full')) renderFull(events);
else renderSummary(target, events);
