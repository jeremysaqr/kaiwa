/**
 * src/routes/settings.js
 *
 * GET    /api/settings/api-key  whether a key is set, where from, and its last four characters
 * PUT    /api/settings/api-key  check a key with OpenAI, then save it   { apiKey }
 * DELETE /api/settings/api-key  forget the saved key
 *
 * The key travels from the browser to this server once, when it is entered,
 * and never in the other direction.
 */

import { Router } from 'express';
import { apiKeyHint, apiKeySource, removeSavedApiKey, saveApiKey } from '../config.js';
import { checkApiKey } from '../openai.js';

const router = Router();

function keyStatus() {
  const source = apiKeySource();
  return { ok: true, configured: Boolean(source), source, hint: apiKeyHint() };
}

router.get('/settings/api-key', (_req, res) => {
  res.json(keyStatus());
});

router.put('/settings/api-key', async (req, res) => {
  if (apiKeySource() === 'env') {
    res.status(409).json({
      ok: false,
      error: 'This key is set by OPENAI_API_KEY in .env. Change it there and restart Kaiwa.',
    });
    return;
  }
  const key = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) {
    res.status(400).json({ ok: false, error: 'That does not look like an OpenAI API key. It starts with "sk-".' });
    return;
  }

  const check = await checkApiKey(key);
  if (!check.ok && check.rejected) {
    res.status(400).json({ ok: false, error: check.error });
    return;
  }

  try {
    saveApiKey(key);
  } catch (error) {
    res.status(500).json({ ok: false, error: `The key could not be saved: ${/** @type {any} */ (error)?.code || 'write failed'}.` });
    return;
  }
  // Saved even when OpenAI could not be reached, so an offline first launch is
  // not a dead end; the warning says it is unchecked.
  res.json({ ...keyStatus(), warning: check.ok ? '' : `Saved, but not yet checked. ${check.error}` });
});

router.delete('/settings/api-key', (_req, res) => {
  if (apiKeySource() === 'env') {
    res.status(409).json({
      ok: false,
      error: 'This key is set by OPENAI_API_KEY in .env. Remove it there and restart Kaiwa.',
    });
    return;
  }
  try {
    removeSavedApiKey();
  } catch (error) {
    res.status(500).json({ ok: false, error: `The key could not be removed: ${/** @type {any} */ (error)?.code || 'delete failed'}.` });
    return;
  }
  res.json(keyStatus());
});

export default router;
