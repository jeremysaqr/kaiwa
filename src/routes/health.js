/**
 * src/routes/health.js
 *
 * GET /api/health
 *
 * Always answers, and answers fast. The frontend uses this to move the
 * "Backend" indicator off "Checking..." — so this route must never depend on
 * a network call to OpenAI, which could hang.
 */

import { Router } from 'express';
import { publicConfig, hasApiKey } from '../config.js';

const router = Router();

router.get('/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'kaiwa',
    time: new Date().toISOString(),
    // A boolean only. The key itself never crosses this boundary.
    apiKeyConfigured: hasApiKey(),
    config: publicConfig(),
  });
});

export default router;
