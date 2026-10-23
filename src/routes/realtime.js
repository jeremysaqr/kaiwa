/**
 * src/routes/realtime.js
 *
 * Realtime session bootstrapping. Two paths, both keeping the permanent API
 * key on the server:
 *
 *   POST /api/realtime/session
 *     Mints a short-lived client secret (ek_...). The browser then POSTs its
 *     SDP offer straight to OpenAI. Lowest latency — this is the default.
 *
 *   POST /api/realtime/sdp
 *     Unified-interface fallback: the browser sends us its SDP offer and we
 *     relay it to OpenAI ourselves. Used when the direct browser-to-OpenAI
 *     request fails.
 */

import { Router } from 'express';
import { createHash } from 'node:crypto';
import {
  MIC_NOISE_REDUCTION, REALTIME_MODEL, REALTIME_VOICE, TRANSCRIBE_MODEL, TURN_EAGERNESS, TUTOR_TURNS,
} from '../config.js';
import { createClientSecret, exchangeSdp, OpenAIError } from '../openai.js';

const router = Router();

/** Language name -> ISO code, used as a transcription hint. */
const LANGUAGE_CODES = Object.freeze({
  german: 'de', japanese: 'ja', spanish: 'es', french: 'fr', italian: 'it',
  portuguese: 'pt', dutch: 'nl', swedish: 'sv', norwegian: 'no', danish: 'da',
  finnish: 'fi', polish: 'pl', russian: 'ru', czech: 'cs', greek: 'el',
  turkish: 'tr', arabic: 'ar', hebrew: 'he', hindi: 'hi', korean: 'ko',
  chinese: 'zh', mandarin: 'zh', vietnamese: 'vi', thai: 'th',
  indonesian: 'id', english: 'en',
});

/**
 * A stable, privacy-preserving identifier for the end user, as recommended for
 * Realtime sessions. Derived by hashing — the raw name never leaves the box.
 * @param {unknown} userName
 * @returns {string|undefined}
 */
function safetyIdentifier(userName) {
  const name = typeof userName === 'string' ? userName.trim() : '';
  if (!name) return undefined;
  return createHash('sha256').update(`language-tutor:${name.toLowerCase()}`).digest('hex').slice(0, 32);
}

/**
 * Build the Realtime `session` object.
 *
 * The tutor instructions are generated in the browser from the active profile
 * and passed in here — they contain no secrets, and keeping one generator means
 * the "Show Active Tutor Prompt" preview always matches what the model gets.
 *
 * There are deliberately NO tools. Lesson bookkeeping used to live here as five
 * function definitions costing roughly a thousand tokens of standing context on
 * every turn, and the voice model never once called them. That work now runs
 * out of band on a cheap text model — see src/director.js.
 *
 * @param {{instructions?: unknown, language?: unknown, voice?: unknown}} body
 */
function buildSessionConfig(body) {
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim()
      ? body.instructions.trim()
      : undefined;

  const languageName = typeof body.language === 'string' ? body.language.trim().toLowerCase() : '';
  const code = LANGUAGE_CODES[languageName];

  // `language`, singular, an ISO-639-1 code — the documented field. This used
  // to send a `languages` ARRAY, which is not a field the transcription config
  // recognises, so the hint was silently dropped and the transcriber fell back
  // to detecting the language itself. A beginner's Japanese came back as
  // Korean, and the tutor spent the lesson replying to noise.
  const language = code && code !== 'en' ? code : 'en';

  // A bias for the transcriber: what this student is likely to be saying. The
  // caller builds it from the lesson and the profile; the difference between
  // "rokujuu" and a guess is often exactly this.
  const transcriptionPrompt =
    typeof body.transcriptionPrompt === 'string' ? body.transcriptionPrompt.trim().slice(0, 900) : '';

  const voice =
    typeof body.voice === 'string' && /^[a-z]+$/i.test(body.voice.trim())
      ? body.voice.trim()
      : REALTIME_VOICE;

  return {
    type: 'realtime',
    model: REALTIME_MODEL,
    ...(instructions ? { instructions } : {}),
    audio: {
      input: {
        transcription: {
          model: TRANSCRIBE_MODEL,
          language,
          ...(transcriptionPrompt ? { prompt: transcriptionPrompt } : {}),
        },
        turn_detection: {
          type: 'semantic_vad',
          // "I barely paused long enough to think and it thought I was done."
          // A beginner searching for a word pauses in the middle of it.
          eagerness: TURN_EAGERNESS,
          // The app asks for each reply once it has the student's words, so
          // that a lesson can choose the tutor's. The student can still
          // interrupt a reply by speaking.
          ...(TUTOR_TURNS === 'app' ? { create_response: false } : {}),
        },
        ...(MIC_NOISE_REDUCTION ? { noise_reduction: { type: MIC_NOISE_REDUCTION } } : {}),
      },
      output: {
        voice,
      },
    },
  };
}

/** Turn any thrown value into a safe { status, body } pair. */
function toErrorResponse(error) {
  if (error instanceof OpenAIError) {
    return {
      status: error.status >= 400 && error.status < 600 ? error.status : 502,
      body: { ok: false, error: error.message, details: error.details },
    };
  }
  return {
    status: 500,
    body: { ok: false, error: 'Unexpected server error while starting the session.' },
  };
}

/** POST /api/realtime/session — mint an ephemeral client secret. */
router.post('/realtime/session', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  try {
    const sessionConfig = buildSessionConfig(body);
    const secret = await createClientSecret(sessionConfig, safetyIdentifier(body.userName));

    res.status(200).json({
      ok: true,
      // `value` is the ephemeral ek_... token, valid for a few minutes. It is
      // NOT the permanent key.
      clientSecret: secret.value,
      expiresAt: secret.expires_at ?? null,
      model: REALTIME_MODEL,
      // Echoed back so the session log records what was actually asked for,
      // rather than what the code was believed to send.
      transcription: sessionConfig.audio.input.transcription,
      // How the session listens, whole. The browser sends this back when it
      // changes the transcription hint part-way through a call, so that the
      // turn-taking settings are restated with it rather than reset by it.
      input: sessionConfig.audio.input,
      // Who asks for each reply: the browser has to know before the first one.
      turns: TUTOR_TURNS,
    });
  } catch (error) {
    const { status, body: payload } = toErrorResponse(error);
    res.status(status).json(payload);
  }
});

/** POST /api/realtime/sdp — server-side SDP relay (fallback path). */
router.post('/realtime/sdp', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const sdp = typeof body.sdp === 'string' ? body.sdp : '';

  if (!sdp.trim()) {
    res.status(400).json({ ok: false, error: 'No SDP offer was supplied.' });
    return;
  }

  try {
    const sessionConfig = buildSessionConfig(body);
    const answer = await exchangeSdp(sdp, sessionConfig, safetyIdentifier(body.userName));
    res.status(200).json({ ok: true, sdp: answer, model: REALTIME_MODEL, turns: TUTOR_TURNS, input: sessionConfig.audio.input });
  } catch (error) {
    const { status, body: payload } = toErrorResponse(error);
    res.status(status).json(payload);
  }
});

export default router;
