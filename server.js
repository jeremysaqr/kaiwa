/**
 * server.js
 *
 * Local Node.js backend for Kaiwa.
 *
 *   Browser  ->  this server  ->  OpenAI API
 *
 * The permanent OpenAI API key (from .env, or saved in the app) is read only
 * by src/config.js and never reaches the browser in any form.
 */

import express from 'express';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { PORT, HOST, apiKeySource, hasApiKey, redact } from './src/config.js';
import { APP_ROOT, IS_COMPILED } from './src/paths.js';
import healthRoutes from './src/routes/health.js';
import realtimeRoutes from './src/routes/realtime.js';
import memoryRoutes from './src/routes/memory.js';
import lessonRoutes from './src/routes/lessons.js';
import logRoutes from './src/routes/logs.js';
import settingsRoutes from './src/routes/settings.js';
import { getLessonLibrary, reportLessonLibrary } from './src/lessons.js';
import { getReferenceLibrary, reportReference } from './src/reference.js';
import { reportLogging } from './src/logging.js';

const app = express();

// SDP offers and transcripts can both be large.
app.use(express.json({ limit: '4mb' }));

// --- API ------------------------------------------------------------------
app.use('/api', healthRoutes);
app.use('/api', realtimeRoutes);
app.use('/api', memoryRoutes);
app.use('/api', lessonRoutes);
app.use('/api', logRoutes);
app.use('/api', settingsRoutes);

// Anything under /api that we did not define is a 404 with a JSON body, never
// the static-file handler's HTML.
app.use('/api', (_req, res) => {
  res.status(404).json({ ok: false, error: 'Unknown API endpoint.' });
});

// --- Static assets ---------------------------------------------------------
// public/shared/ holds modules imported by BOTH the server and the browser.
// Living under public/ means the on-disk path and the URL path agree, so the
// same relative import (`../shared/x.js`) resolves in Node and in the browser.
app.use(express.static(path.join(APP_ROOT, 'public'), {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// The app itself. Served at / as well as at its own filename.
app.get(['/', '/index.html', '/language_tutor.html'], (_req, res) => {
  res.sendFile(path.join(APP_ROOT, 'public', 'language_tutor.html'));
});

// --- Error handling --------------------------------------------------------
// Four arguments: this is Express's error middleware signature.
// eslint-disable-next-line no-unused-vars
app.use((error, _req, res, _next) => {
  console.error('[kaiwa] Unhandled error:', redact(error?.stack || error?.message || error));
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Unexpected server error.' });
});

// --- Start -----------------------------------------------------------------
const url = `http://localhost:${PORT}`;

/**
 * A release executable opens the app in the default browser, since there is
 * no terminal command to tell the user about. KAIWA_NO_BROWSER=1 turns it off.
 */
function openBrowser() {
  if (!IS_COMPILED || process.env.KAIWA_NO_BROWSER === '1') return;
  const [command, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      .on('error', () => console.log(`  Open ${url} in your browser.`))
      .unref();
  } catch {
    console.log(`  Open ${url} in your browser.`);
  }
}

const KEY_STATUS = {
  env: 'loaded from .env',
  saved: 'saved in Kaiwa',
  '': 'not set yet — the app will ask for one',
};

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Kaiwa');
  console.log(`  Listening on   ${url}`);
  console.log(`  Health check   ${url}/api/health`);
  console.log(`  OpenAI API key ${KEY_STATUS[apiKeySource()]}`);
  if (IS_COMPILED) console.log('  Keep this window open while you use Kaiwa. Close it to quit.');
  openBrowser();

  // Warm the lesson library so a broken lesson file is reported at startup
  // rather than on the first request. A failure here never stops the server:
  // the app simply runs with whatever Skills are valid (PART 49, PART 52).
  getLessonLibrary()
    .then(reportLessonLibrary)
    .catch((error) => console.warn('  Lessons        could not be read:', error?.message || error))
    .then(() => getReferenceLibrary())
    .then(reportReference)
    .then(reportLogging)
    .catch((error) => console.warn('  Reference      could not be read:', error?.message || error))
    .finally(() => console.log(''));
  if (!hasApiKey()) {
    console.warn('  You can manage profiles until then, but calls will fail.');
    console.log('');
  }
});

server.on('error', (error) => {
  if (/** @type {any} */ (error)?.code === 'EADDRINUSE') {
    // Most often Kaiwa is already running: show it rather than fail.
    fetch(`${url}/api/health`)
      .then((response) => response.json())
      .then((health) => {
        if (health?.service !== 'kaiwa') throw new Error('not Kaiwa');
        console.log(`\n  Kaiwa is already running at ${url}.\n`);
        openBrowser();
        setTimeout(() => process.exit(0), 3000);
      })
      .catch(() => {
        console.error(`\n  Port ${PORT} is already in use by another program.`);
        console.error('  Either stop the other program, or set a different PORT in .env.\n');
        // A double-clicked executable's window would close before this could be read.
        setTimeout(() => process.exit(1), IS_COMPILED ? 30000 : 0);
      });
    return;
  }
  console.error('[kaiwa] Server error:', redact(/** @type {any} */ (error)?.message));
  process.exit(1);
});

// Never let a stray rejection take the server down mid-lesson.
process.on('unhandledRejection', (reason) => {
  console.error('[kaiwa] Unhandled promise rejection:', redact(String(reason)));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n  Shutting down.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export default app;
