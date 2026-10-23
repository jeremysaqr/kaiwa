/**
 * src/routes/logs.js
 *
 * POST /api/logs   append a batch of events to a session log
 * GET  /api/logs   list the session files on disk
 *
 * Logging is diagnostic plumbing: it must never be able to interrupt a lesson,
 * so this route answers 200 even when it could not write anything.
 */

import { Router } from 'express';
import { appendEvents, listSessions, LOGGING_ENABLED, LOGS_DIR } from '../logging.js';

const router = Router();

router.post('/logs', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const result = await appendEvents(String(body.sessionId || ''), body.events);
    res.status(200).json({ ok: result.ok, written: result.written });
  } catch {
    res.status(200).json({ ok: false, written: 0 });
  }
});

router.get('/logs', async (_req, res) => {
  res.status(200).json({
    ok: true,
    enabled: LOGGING_ENABLED,
    directory: LOGS_DIR,
    sessions: await listSessions(),
  });
});

export default router;
