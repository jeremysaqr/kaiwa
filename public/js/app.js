/**
 * public/js/app.js
 *
 * Application wiring: status indicators, storage, profile selection, the call
 * lifecycle, and the memory update that follows a lesson.
 *
 * Design rules enforced here:
 *   - No indicator is ever left on "Checking…" (PART 28, BUG 1).
 *   - Selecting a user or a language changes the ACTIVE state, not just the
 *     dropdown (PART 6, PART 7, BUG 2, BUG 3).
 *   - `proficiency_level` is written only by the user, from the UI.
 *   - Ending a call is instant; memory extraction happens afterwards and
 *     cannot hold the call open (PART 24).
 *   - Lessons are additive. With no lessons on disk, or with the lesson API
 *     unreachable, everything below behaves exactly as it did before the
 *     Lesson Skills Framework existed (PART 52, PART 58).
 */

import {
  isSupported,
  pickRoot,
  restoreRoot,
  requestPermission,
  forgetRoot,
  discoverProfiles,
  createUser,
  createLanguage,
  readConfig,
  writeConfig,
  validateName,
  UnsupportedBrowserError,
} from './storage.js';
import { RealtimeSession, fetchWithTimeout } from './realtime.js';
import { TranscriptView } from './transcript.js';
import { COMFORT_LEVELS, coerceLevel } from '../shared/levels.js';
import {
  createDefaultProfile,
  migrateProfile,
  defaultTutorName,
  profileLabel,
  DEFAULT_LANGUAGE,
} from '../shared/profile.js';
import { buildTutorPrompt, promptSummary } from '../shared/prompt.js';
import { referenceFacts } from '../shared/lesson-prompt.js';
import { LessonConductor } from '../shared/conductor.js';
import { evaluateRecommendation } from '../shared/assessment.js';
import { normalizeVocabList, normalizeWeaknessList } from '../shared/vocab.js';
import { toDisplayText } from '../shared/romaji.js';
import { LessonLibrary } from './lessons.js';
import { sessionLog } from './logger.js';
import { buildTranscriptionPrompt } from '../shared/transcription.js';
import { StudentTurns } from '../shared/turns.js';

// ---------------------------------------------------------------------------
// DOM lookup — every selector is resolved once and verified up front, so a
// typo surfaces immediately instead of as a silent no-op handler.
// ---------------------------------------------------------------------------

const IDS = [
  'app', 'sidebar', 'sidebarClose', 'sidebarToggle', 'scrim',
  'statusBackend', 'statusStorage', 'statusProfile', 'statusWebrtc', 'statusMic',
  'retryHealthBtn', 'storagePath', 'pickFolderBtn', 'grantAccessBtn',
  'userSelect', 'languageSelect', 'levelSelect', 'tutorNameInput', 'comfortInfoBtn',
  'topbarProfile', 'topbarSub', 'showPromptBtn',
  'banner', 'bannerText', 'bannerClose',
  'transcript', 'transcriptEmpty', 'jumpLatestBtn',
  'lessonSelect', 'lessonHint', 'lessonProblems', 'refreshLessonsBtn',
  'lessonStrip', 'lessonStripName', 'lessonStripPhase', 'lessonProgressBar',
  'lessonProgressValue', 'endLessonBtn', 'nextPhaseBtn', 'callTimer',
  'memStudent', 'memLanguage', 'memTutor', 'memLevel', 'memAssessed',
  'memWeaknesses', 'memVocab', 'memRecommendation', 'applyRecoBtn',
  'callDot', 'callState', 'muteBtn', 'startCallBtn', 'endCallBtn',
  'nameDialog', 'nameForm', 'nameDialogTitle', 'nameDialogBody', 'nameDialogLabel',
  'nameInput', 'nameError', 'nameCancel', 'nameConfirm',
  'promptDialog', 'promptSummary', 'promptPreview', 'promptCopy', 'promptClose',
  'infoDialog', 'infoClose',
  'apiKeySummary', 'manageKeyBtn',
  'keyDialog', 'keyForm', 'keyCurrent', 'keyInput', 'keyError', 'keyRemove', 'keyCancel', 'keySave',
];

/** @type {Record<string, HTMLElement>} */
const el = {};
const missing = [];
for (const id of IDS) {
  const node = document.getElementById(id);
  if (node) el[id] = node;
  else missing.push(id);
}
if (missing.length) {
  // Fail loudly rather than half-wiring the UI.
  document.body.innerHTML =
    `<pre style="padding:24px;color:#f2645a;font:14px monospace">` +
    `Kaiwa could not start: missing element(s) ${missing.join(', ')}.\n` +
    `public/language_tutor.html and public/js/app.js are out of sync.</pre>`;
  throw new Error(`Missing DOM elements: ${missing.join(', ')}`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const CREATE_USER = '__create_user__';
const ADD_LANGUAGE = '__add_language__';


const state = {
  /** @type {FileSystemDirectoryHandle|null} */
  root: null,
  /** @type {'none'|'connected'|'permission-required'|'unsupported'} */
  storageStatus: 'none',
  /** @type {{name: string, languages: {name: string, hasConfig: boolean}[]}[]} */
  users: [],
  currentUser: '',
  currentLanguage: '',
  /** @type {Record<string, any>|null} */
  profile: null,
  /** @type {RealtimeSession|null} */
  session: null,
  callActive: false,
  /** Epoch ms the current call started, for the bottom-bar timer. */
  callStartedAt: 0,
  /** @type {ReturnType<typeof setInterval>|null} */
  callTimerId: null,
  extracting: false,
  backendOk: false,
  /** @type {ReturnType<typeof evaluateRecommendation>|null} */
  recommendation: null,
};

const transcript = new TranscriptView({
  container: el.transcript,
  jumpButton: el.jumpLatestBtn,
  emptyState: el.transcriptEmpty,
});

/**
 * The Lesson Skills runtime. Everything lesson-related goes through this one
 * object, whether it started in the sidebar or in the tutor's mouth (PART 22).
 */
const lessons = new LessonLibrary({
  onChange: () => {
    renderLessonStrip();
    renderLessonSelect();
  },
});

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

/**
 * @param {HTMLElement} statusEl
 * @param {'idle'|'pending'|'ok'|'warn'|'error'} dotState
 * @param {string} value
 * @param {string} [title]
 */
function setStatus(statusEl, dotState, value, title) {
  const dot = statusEl.querySelector('.status__dot');
  const text = statusEl.querySelector('.status__value');
  if (dot) dot.setAttribute('data-state', dotState);
  if (text) {
    text.textContent = value;
    text.setAttribute('title', title || value);
  }
}

/**
 * The banner shows one message at a time, so a lower-priority notice must not
 * mask a blocking error. Startup runs the backend and storage checks in
 * parallel, and without this an "add your API key" note could hide "this
 * browser cannot open folders at all".
 */
const BANNER_PRIORITY = { success: 0, info: 1, error: 2 };

/**
 * @param {string} message
 * @param {'error'|'info'|'success'} [tone]
 * @param {{force?: boolean}} [options] force:true always wins — use it for
 *   messages caused by something the user just did.
 */
function showBanner(message, tone = 'error', { force = false } = {}) {
  if (!force && !el.banner.hidden) {
    const current = BANNER_PRIORITY[el.banner.getAttribute('data-tone')] ?? 0;
    if (BANNER_PRIORITY[tone] < current) return;
  }
  el.bannerText.textContent = message;
  el.banner.setAttribute('data-tone', tone);
  el.banner.hidden = false;
}

function hideBanner() {
  el.banner.hidden = true;
  el.banner.removeAttribute('data-tone');
}

/**
 * Elapsed call time as mm:ss, or h:mm:ss once past an hour.
 * @param {number} milliseconds
 */
function formatDuration(milliseconds) {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  const seconds = String(total % 60).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  if (hours > 0) {
    return `${hours}:${String(Math.floor(total / 60) % 60).padStart(2, '0')}:${seconds}`;
  }
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${seconds}`;
}

/** Paint the current elapsed time into the bottom bar. */
function renderCallTimer() {
  if (!state.callStartedAt) return;
  el.callTimer.textContent = formatDuration(Date.now() - state.callStartedAt);
}

/** Start the bottom-bar timer. Ticking every second is enough. */
function startCallTimer() {
  stopCallTimer({ clear: false });
  state.callStartedAt = Date.now();
  el.callTimer.hidden = false;
  el.callTimer.setAttribute('data-state', 'live');
  el.callTimer.textContent = '00:00';
  state.callTimerId = setInterval(renderCallTimer, 1000);
}

/**
 * Stop ticking. The final duration stays on screen after the call so the
 * student can see how long they spoke for.
 * @param {{clear?: boolean}} [options]
 */
function stopCallTimer({ clear = true } = {}) {
  if (state.callTimerId) {
    clearInterval(state.callTimerId);
    state.callTimerId = null;
  }
  if (clear && state.callStartedAt) {
    renderCallTimer();
    el.callTimer.setAttribute('data-state', 'ended');
  }
}

/** @param {string} label @param {'idle'|'connecting'|'live'|'done'} dotState */
function setCallState(label, dotState) {
  el.callState.textContent = label;
  el.callDot.setAttribute('data-state', dotState);
}

/** Replace a <ul> with chips, or a dashed "nothing yet" placeholder. */
function renderChips(listEl, items, emptyText) {
  listEl.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'chips__empty';
    li.textContent = emptyText;
    listEl.append(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    // textContent, never innerHTML: config files are user-editable input.
    li.textContent = item;
    listEl.append(li);
  }
}

/** Open a <dialog>, tolerating browsers without showModal. */
function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function closeDialog(dialog) {
  if (typeof dialog.close === 'function') dialog.close();
  else dialog.removeAttribute('open');
}

// ---------------------------------------------------------------------------
// Backend health — must always resolve to Connected or Error
// ---------------------------------------------------------------------------

async function checkBackend() {
  setStatus(el.statusBackend, 'pending', 'Checking…');
  try {
    const response = await fetchWithTimeout('/api/health', { method: 'GET' }, 6000);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data?.ok) throw new Error('The health endpoint reported a problem.');

    state.backendOk = true;

    if (data.apiKeyConfigured === false) {
      setStatus(el.statusBackend, 'warn', 'No API key', 'Add one under Settings → OpenAI API key');
      showBanner(
        'Kaiwa needs your OpenAI API key before it can talk. Add it under Settings → ' +
          'OpenAI API key. You can still manage profiles until then.',
        'info',
      );
    } else {
      setStatus(
        el.statusBackend,
        'ok',
        'Connected',
        `${data.config?.realtimeModel || ''} · ${data.config?.memoryModel || ''}`,
      );
    }
  } catch (error) {
    state.backendOk = false;
    const detail = error?.message || String(error);
    setStatus(el.statusBackend, 'error', 'Error', detail);
    showBanner(
      `Cannot reach the local server (${detail}).\n` +
        'Start Kaiwa again (or "npm start" in the project folder), then press "Recheck backend".',
      'error',
    );
  } finally {
    updateControls();
  }
}

// ---------------------------------------------------------------------------
// OpenAI API key — entered here, kept by the local server, never sent back
// ---------------------------------------------------------------------------

/** @type {{configured: boolean, source: string, hint: string} | null} */
let keyStatus = null;

async function loadKeyStatus() {
  try {
    const response = await fetchWithTimeout('/api/settings/api-key', { method: 'GET' }, 6000);
    const data = await response.json();
    if (!data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
    keyStatus = data;
  } catch {
    keyStatus = null;
  }
  renderKeyStatus();
  return keyStatus;
}

function renderKeyStatus() {
  if (!keyStatus) {
    el.apiKeySummary.textContent = 'unknown (server not reachable)';
  } else if (!keyStatus.configured) {
    el.apiKeySummary.textContent = 'not set';
  } else {
    const where = keyStatus.source === 'env' ? 'from .env' : 'saved';
    el.apiKeySummary.textContent = `${where}${keyStatus.hint ? ` (${keyStatus.hint})` : ''}`;
  }
}

function setKeyError(message) {
  el.keyError.textContent = message || '';
  el.keyError.hidden = !message;
}

function openKeyDialog() {
  const fromEnv = keyStatus?.source === 'env';
  el.keyInput.value = '';
  el.keyInput.disabled = fromEnv;
  el.keySave.disabled = fromEnv;
  el.keyRemove.hidden = keyStatus?.source !== 'saved';
  el.keyCancel.textContent = keyStatus?.configured ? 'Close' : 'Not now';
  el.keyCurrent.hidden = !keyStatus?.configured;
  el.keyCurrent.textContent = fromEnv
    ? `A key ending ${keyStatus.hint || ''} is set by OPENAI_API_KEY in the .env file. Change it there and restart Kaiwa.`
    : `A key ending ${keyStatus?.hint || ''} is saved. Paste a new one to replace it.`;
  setKeyError('');
  openDialog(el.keyDialog);
  if (!fromEnv) el.keyInput.focus();
}

async function sendKeyRequest(method, body) {
  const response = await fetchWithTimeout('/api/settings/api-key', {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }, 20000);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.ok) throw new Error(data?.error || `HTTP ${response.status}`);
  return data;
}

el.keyForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const apiKey = el.keyInput.value.trim();
  if (!apiKey) {
    setKeyError('Paste your API key first.');
    return;
  }
  el.keySave.disabled = true;
  el.keySave.textContent = 'Checking…';
  setKeyError('');
  try {
    const data = await sendKeyRequest('PUT', { apiKey });
    el.keyInput.value = '';
    keyStatus = data;
    renderKeyStatus();
    closeDialog(el.keyDialog);
    hideBanner();
    if (data.warning) showBanner(data.warning, 'info');
    await checkBackend();
  } catch (error) {
    setKeyError(error?.message || String(error));
  } finally {
    el.keySave.disabled = false;
    el.keySave.textContent = 'Save key';
  }
});

el.keyRemove.addEventListener('click', async () => {
  if (!window.confirm('Remove the saved OpenAI API key from this computer?')) return;
  try {
    keyStatus = await sendKeyRequest('DELETE');
    renderKeyStatus();
    closeDialog(el.keyDialog);
    await checkBackend();
  } catch (error) {
    setKeyError(error?.message || String(error));
  }
});

el.keyCancel.addEventListener('click', () => closeDialog(el.keyDialog));
el.manageKeyBtn.addEventListener('click', async () => {
  await loadKeyStatus();
  openKeyDialog();
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function initStorage() {
  if (!isSupported()) {
    state.storageStatus = 'unsupported';
    setStatus(el.statusStorage, 'error', 'Unsupported');
    el.storagePath.textContent =
      'This browser cannot open local folders. Use Chrome or Edge on the desktop.';
    el.pickFolderBtn.disabled = true;
    showBanner(new UnsupportedBrowserError().message, 'error');
    updateControls();
    return;
  }

  setStatus(el.statusStorage, 'pending', 'Checking…');
  try {
    const { status, handle } = await restoreRoot();

    if (status === 'connected' && handle) {
      state.root = handle;
      state.storageStatus = 'connected';
      setStatus(el.statusStorage, 'ok', 'Connected', handle.name);
      el.storagePath.textContent = `Using “${handle.name}” (remembered from last time).`;
      el.grantAccessBtn.hidden = true;
      await refreshProfiles();
    } else if (status === 'permission-required' && handle) {
      state.root = handle;
      state.storageStatus = 'permission-required';
      setStatus(el.statusStorage, 'warn', 'Permission required', handle.name);
      el.storagePath.textContent = `“${handle.name}” is remembered but needs permission again.`;
      el.grantAccessBtn.hidden = false;
    } else {
      state.storageStatus = 'none';
      setStatus(el.statusStorage, 'idle', 'Not selected');
      el.storagePath.textContent = 'No folder selected yet.';
      el.grantAccessBtn.hidden = true;
    }
  } catch (error) {
    state.storageStatus = 'none';
    setStatus(el.statusStorage, 'error', 'Error', error?.message);
    el.storagePath.textContent = 'Could not restore the previous folder.';
    showBanner(`Storage problem: ${error?.message || error}`, 'error');
  } finally {
    updateControls();
  }
}

async function handlePickFolder() {
  try {
    const handle = await pickRoot();
    state.root = handle;
    state.storageStatus = 'connected';
    state.currentUser = '';
    state.currentLanguage = '';
    state.profile = null;
    setStatus(el.statusStorage, 'ok', 'Connected', handle.name);
    el.storagePath.textContent = `Using “${handle.name}”. It will be remembered next time.`;
    el.grantAccessBtn.hidden = true;
    hideBanner();
    await refreshProfiles();
  } catch (error) {
    if (error?.name === 'AbortError') return; // The user simply cancelled.
    showBanner(`Could not open that folder: ${error?.message || error}`, 'error', { force: true });
  } finally {
    updateControls();
  }
}

async function handleGrantAccess() {
  if (!state.root) return;
  try {
    const granted = await requestPermission(state.root);
    if (granted) {
      state.storageStatus = 'connected';
      setStatus(el.statusStorage, 'ok', 'Connected', state.root.name);
      el.storagePath.textContent = `Using “${state.root.name}”.`;
      el.grantAccessBtn.hidden = true;
      hideBanner();
      await refreshProfiles();
    } else {
      showBanner(
        'Permission was not granted. Press “Regrant access”, or pick the folder again.',
        'error',
      );
    }
  } catch (error) {
    await forgetRoot();
    state.root = null;
    state.storageStatus = 'none';
    setStatus(el.statusStorage, 'idle', 'Not selected');
    showBanner(`That folder is no longer usable: ${error?.message || error}`, 'error', { force: true });
  } finally {
    updateControls();
  }
}

// ---------------------------------------------------------------------------
// Profile discovery and selection
// ---------------------------------------------------------------------------

async function refreshProfiles({ keepSelection = true } = {}) {
  if (!state.root) return;

  try {
    const { users } = await discoverProfiles(state.root);
    state.users = users;
  } catch (error) {
    state.users = [];
    showBanner(`Could not read the storage folder: ${error?.message || error}`, 'error');
  }

  // Keep the current user if it still exists, otherwise fall back sensibly.
  const hadSelection = state.users.some((user) => user.name === state.currentUser);
  let autoPicked = '';
  if (!keepSelection || !hadSelection) {
    autoPicked = state.users.length === 1 ? state.users[0].name : '';
    state.currentUser = autoPicked;
    state.currentLanguage = '';
    state.profile = null;
  }

  renderUserSelect();
  renderLanguageSelect();

  if (autoPicked) {
    // Setting state.currentUser is not the same as selecting a user: the
    // language list, the single-language shortcut and the profile load all hang
    // off selectUser(). Without this the dropdown showed the name while the app
    // still believed nothing was chosen, and the user had to re-pick it by hand.
    await selectUser(autoPicked);
    return;
  }

  if (state.currentUser && state.currentLanguage) {
    await loadProfile(state.currentUser, state.currentLanguage);
  } else {
    renderMemoryCard();
    updateControls();
  }
}

function renderUserSelect() {
  const select = /** @type {HTMLSelectElement} */ (el.userSelect);
  select.replaceChildren();

  const usable = state.storageStatus === 'connected';
  select.disabled = !usable;

  if (!usable) {
    select.append(new Option('Select a storage folder first', ''));
    select.value = '';
    return;
  }

  select.append(new Option(state.users.length ? 'Select a user…' : 'No users yet', ''));
  for (const user of state.users) {
    select.append(new Option(user.name, user.name));
  }
  select.append(new Option('Create New User…', CREATE_USER));

  select.value = state.currentUser || '';
}

function renderLanguageSelect() {
  const select = /** @type {HTMLSelectElement} */ (el.languageSelect);
  select.replaceChildren();

  const usable = state.storageStatus === 'connected' && Boolean(state.currentUser);
  select.disabled = !usable;

  if (!usable) {
    select.append(new Option('Select a user first', ''));
    select.value = '';
    return;
  }

  const user = state.users.find((entry) => entry.name === state.currentUser);
  const languages = user ? user.languages : [];

  select.append(new Option(languages.length ? 'Select a language…' : 'No languages yet', ''));
  for (const language of languages) {
    select.append(new Option(language.name, language.name));
  }
  select.append(new Option('Add New Language…', ADD_LANGUAGE));

  select.value = state.currentLanguage || '';
}

function renderLevelSelect() {
  const select = /** @type {HTMLSelectElement} */ (el.levelSelect);
  if (select.options.length !== COMFORT_LEVELS.length) {
    select.replaceChildren();
    for (const level of COMFORT_LEVELS) {
      select.append(new Option(level, level));
    }
  }
  const hasProfile = Boolean(state.profile);
  select.disabled = !hasProfile || state.callActive;
  select.value = hasProfile ? coerceLevel(state.profile.proficiency_level) : COMFORT_LEVELS[0];
}

/**
 * Load (or create, or migrate) the config for a user/language pair and make it
 * the active profile. This is the ONLY place `state.profile` is assigned from
 * disk, so the UI and the internal state cannot disagree.
 */
async function loadProfile(userName, language) {
  if (!state.root) return;

  try {
    const { found, data, parseError } = await readConfig(state.root, userName, language);

    if (found && parseError) {
      showBanner(
        `config.json for ${userName}/${language} is not valid JSON (${parseError}). ` +
          'A fresh profile has been created; the damaged file was left untouched until you save.',
        'error',
      );
    }

    let profile;
    if (found && data && !parseError) {
      const { profile: migrated, changed } = migrateProfile(data, { userName, language });
      profile = migrated;
      if (changed) {
        // Bring an older config up to date on disk, without losing anything.
        await writeConfig(state.root, userName, language, profile);
      }
    } else {
      profile = createDefaultProfile({ userName, language });
      await writeConfig(state.root, userName, language, profile);
    }

    state.currentUser = userName;
    state.currentLanguage = language;
    state.profile = profile;
    state.recommendation = evaluateRecommendation(
      profile.proficiency_level,
      profile.assessment_history,
    );

    transcript.setLanguage(profile.target_language);
    renderLevelSelect();
    renderMemoryCard();
    renderLessonSelect();
    updateControls();
  } catch (error) {
    state.profile = null;
    showBanner(
      `Could not open the profile for ${userName} / ${language}: ${error?.message || error}`,
      'error',
    );
    updateControls();
  }
}

/** Persist the active profile. Returns true on success. */
async function saveProfile() {
  if (!state.root || !state.profile || !state.currentUser || !state.currentLanguage) return false;
  try {
    await writeConfig(state.root, state.currentUser, state.currentLanguage, state.profile);
    return true;
  } catch (error) {
    showBanner(`Could not save the profile: ${error?.message || error}`, 'error', { force: true });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Memory card
// ---------------------------------------------------------------------------

function renderMemoryCard() {
  const profile = state.profile;

  if (!profile) {
    el.memStudent.textContent = '—';
    el.memLanguage.textContent = '—';
    el.memTutor.textContent = '—';
    el.memLevel.textContent = '—';
    el.memAssessed.textContent = '—';
    renderChips(el.memWeaknesses, [], 'Nothing recorded yet');
    renderChips(el.memVocab, [], 'Nothing recorded yet');
    el.memRecommendation.textContent = 'Select a user and language to see their memory.';
    el.memRecommendation.removeAttribute('data-status');
    el.applyRecoBtn.hidden = true;
    return;
  }

  const language = profile.target_language;

  el.memStudent.textContent = profile.user_name || state.currentUser || '—';
  el.memLanguage.textContent = language || '—';
  el.memTutor.textContent = profile.tutor_name || '—';
  el.memLevel.textContent = coerceLevel(profile.proficiency_level);
  el.memAssessed.textContent = profile.ai_assessed_level || 'Not assessed yet';

  renderChips(
    el.memWeaknesses,
    normalizeWeaknessList(profile.known_weaknesses),
    'Nothing recorded yet',
  );

  // Vocabulary is normalised to strings before it ever reaches the DOM, and
  // romanised for Japanese profiles.
  renderChips(
    el.memVocab,
    normalizeVocabList(profile.recent_vocab).map((item) => toDisplayText(item, language)),
    'Nothing recorded yet',
  );

  const recommendation =
    state.recommendation ||
    evaluateRecommendation(profile.proficiency_level, profile.assessment_history);
  state.recommendation = recommendation;

  el.memRecommendation.textContent = recommendation.message;
  el.memRecommendation.setAttribute('data-status', recommendation.status);

  if (recommendation.suggestedLevel && recommendation.actionLabel) {
    el.applyRecoBtn.hidden = false;
    el.applyRecoBtn.textContent = recommendation.actionLabel;
    el.applyRecoBtn.disabled = state.callActive;
  } else {
    el.applyRecoBtn.hidden = true;
  }
}

// ---------------------------------------------------------------------------
// Lessons
// ---------------------------------------------------------------------------

/** Rebuild the sidebar selector from whatever Skills were discovered. */
function renderLessonSelect() {
  const active = lessons.activeId;
  const select = /** @type {HTMLSelectElement} */ (el.lessonSelect);

  select.replaceChildren();

  const normal = document.createElement('option');
  normal.value = '';
  normal.textContent = 'Normal Conversation';
  select.append(normal);

  for (const skill of lessons.skills) {
    const option = document.createElement('option');
    option.value = skill.id;
    option.textContent = skill.name;
    select.append(option);
  }

  select.value = active;
  select.disabled = !state.profile || lessons.skills.length === 0;

  if (lessons.loadError) {
    el.lessonHint.textContent = `Lessons could not be loaded: ${lessons.loadError}`;
  } else if (!lessons.skills.length) {
    el.lessonHint.textContent =
      'No lessons found. Add a folder with a lesson.json under Lessons/ and press Reload lessons.';
  } else if (!state.profile) {
    el.lessonHint.textContent = 'Select a user and language first.';
  } else {
    el.lessonHint.textContent = 'Optional. You can also just ask for a lesson out loud.';
  }

  // A broken lesson file is shown, named, and otherwise ignored (PART 49).
  el.lessonProblems.replaceChildren();
  if (lessons.problems.length) {
    for (const problem of lessons.problems) {
      const item = document.createElement('li');
      item.textContent = `${problem.source}: ${problem.errors.join(' ')}`;
      el.lessonProblems.append(item);
    }
    el.lessonProblems.hidden = false;
  } else {
    el.lessonProblems.hidden = true;
  }
}

/** The minimal progress indicator (PART 27). Absent unless a lesson runs. */
function renderLessonStrip() {
  const skill = lessons.runtime.skill;
  if (!skill) {
    el.lessonStrip.hidden = true;
    return;
  }
  const snapshot = lessons.runtime.snapshot();
  el.lessonStrip.hidden = false;
  el.lessonStripName.textContent = skill.name;
  el.lessonStripPhase.textContent = snapshot.phase_name ? `\u00b7 ${snapshot.phase_name}` : '';
  el.lessonProgressValue.textContent = `~${snapshot.progress}%`;
  el.lessonProgressBar.style.width = `${snapshot.progress}%`;
}

/**
 * Push the current prompt into a live session.
 *
 * Built by `buildTutorPrompt`, the same function the preview uses, so the
 * preview cannot drift from what the model receives (PART 42).
 */
function syncLessonPrompt(reason = 'lesson-changed') {
  if (!state.session || !state.profile) return;
  const context = lessons.promptContext(state.profile.target_language);
  const instructions = buildTutorPrompt(state.profile, context, { opening: false, directed: conductor.directed });
  state.session.updateInstructions(instructions);
  syncTranscriptionHint(context);
  sessionLog.prompt(reason, instructions, {
    lesson: lessons.activeId || null,
    phase: lessons.runtime.phaseId || null,
    referenceKeys: Object.keys(context.reference || {}),
  });
}

/**
 * Tell the transcriber what it is about to hear: the words of the part of the
 * lesson now in progress. Sent whenever the lesson moves — a part is written,
 * a part begins — and only if it has changed.
 *
 * @param {ReturnType<typeof lessons.promptContext>} [context]
 */
function syncTranscriptionHint(context) {
  if (!state.session || !state.profile || !state.callActive) return;
  const source = context || lessons.promptContext(state.profile.target_language);
  const prompt = buildTranscriptionPrompt({
    profile: state.profile,
    skill: lessons.runtime.skill,
    reference: source.reference,
    expected: lessons.runtime.hintItems(),
  });
  if (state.session.updateTranscriptionHint(prompt)) {
    sessionLog.event('transcription.hint', { prompt, updated: true, phase: lessons.runtime.phaseId || null });
  }
}

/**
 * The one place a lesson starts or stops, whoever asked (PART 22).
 *
 * @param {string} skillId '' means normal conversation
 * @param {{reason?: string, announce?: boolean}} [options]
 */
function setActiveLesson(skillId, { reason = 'ui', announce = true } = {}) {
  const wasActive = lessons.runtime.skill;

  const result = skillId
    ? lessons.activate(skillId, { reason })
    : lessons.deactivate({ reason });

  if (!result.ok) {
    // PART 51: report it, return to normal conversation, never sit in a
    // half-active state.
    showBanner(result.error || 'That lesson could not be started.', 'error', { force: true });
    renderLessonSelect();
    renderLessonStrip();
    return false;
  }

  if (result.changed) {
    sessionLog.event('lesson.change', {
      to: skillId ? result.skill?.id || skillId : null,
      from: wasActive?.id || null,
      reason,
    });
  }

  if (announce && result.changed) {
    if (skillId && result.skill) {
      transcript.addSystemNote(`Lesson started: ${result.skill.name}.`, 'info');
    } else if (wasActive) {
      transcript.addSystemNote(`Lesson ended: ${wasActive.name}. Back to normal conversation.`, 'info');
    }
  }

  renderLessonSelect();
  renderLessonStrip();
  syncLessonPrompt();
  updateControls();

  // Updating the instructions is not the same as prompting the tutor to act on
  // them. Without this, choosing a lesson mid-call silently changes the rules
  // and the tutor carries on as though nothing had happened.
  if (result.changed && state.callActive) {
    if (skillId && result.skill) {
      // Nobody is talking: the student pressed a button. The tutor is given a
      // turn of its own — once the part's material has been written, so that
      // it begins with the script rather than with something it made up.
      conductor.beginPart(
        `The student has started the ${result.skill.name} lesson from the app. Begin it now, ` +
          'following the lesson instructions you have just been given.',
      );
    } else {
      state.session?.nudge(
        'The student has ended the lesson from the app. Carry on with ordinary conversation.',
        { speak: true },
      );
    }
  } else if (result.changed && skillId) {
    // Chosen before the call: have the first part written now, so it is ready
    // by the time they press Start.
    conductor.ensurePlan();
  }

  return true;
}

/**
 * Everything the app does around the conversation, turn by turn: counting the
 * student's turns, moving a stuck lesson on, running the Lesson Director and
 * telling the tutor what it found.
 *
 * The logic lives in shared/conductor.js so the test harness can drive a real
 * tutor through exactly the same code. This file supplies the page.
 */
const conductor = new LessonConductor({
  lessons,
  getProfile: () => state.profile,
  getTranscript: () => transcript.getRawTranscript(),
  isLive: () => state.callActive,
  nudge: (text, options) => state.session?.nudge(text, options),
  syncPrompt: () => syncLessonPrompt(),
  log: (type, payload) => sessionLog.event(type, payload),
  note: (text, kind) => transcript.addSystemNote(text, kind),
  // The transcriber writes Japanese in Japanese script; the lesson is in romaji.
  toTutorScript: (text) => toDisplayText(text, state.profile?.target_language || ''),
  // The app asks for each of the tutor's replies, and during a lesson chooses
  // its words. Switched off for a call if the session turns out not to be
  // waiting for the app (see onTurnMode below).
  directed: true,
  respond: (instructions, options) => state.session?.respond(instructions, options),
  judge: (question) => lessons.judgeAnswer(question),
  // The model that heard the student, asked whether they said a given thing.
  hear: (itemIds, instructions) => (state.session ? state.session.listen(itemIds, instructions) : null),
  getReference: () => referenceFacts(lessons.promptContext(state.profile?.target_language || '')),
  refresh: () => {
    renderLessonSelect();
    renderLessonStrip();
    updateControls();
  },
});

/** How many of the tutor's replies have begun to be heard on this call. */
let tutorReplies = 0;
/** What that count was when the student — or a noise — last started. */
let repliesAtSpeech = 0;
/** The tutor's last reply was cut off before it finished. */
let tutorCut = false;
/** Replies being worked out right now. */
let answersInFlight = 0;

/**
 * What counts as one turn of the student's (shared/turns.js): stretches of
 * speech that arrive before the reply to the first has been heard are put
 * together and answered once, and a stretch with no words in it is not an
 * answer to anything.
 */
const studentTurns = new StudentTurns({
  onAnswer: (text, detail) => answerStudent(text, detail),
  onNoise: (detail) => handleNoise(detail),
  onRetract: () => {
    const taken = conductor.retract();
    // And if the reply is already on its way to being spoken, it is stopped.
    if (taken) state.session?.cancelReply();
    return taken;
  },
  isWhole: (text) => conductor.completes(text),
  log: (type, detail) => sessionLog.event(type, detail),
});

/**
 * The student has said something, whole. This is where the reply is asked
 * for: the lesson decides the tutor's words from what was said.
 *
 * @param {string} text what they were heard to say; empty when they spoke and
 *        nothing could be made out
 * @param {{itemIds?: string[]}} [detail] the turn, as the session knows it
 */
function answerStudent(text, detail = {}) {
  answersInFlight += 1;
  // (How long the stretch was, as the session reports it: what "too short to
  // be speech" should mean is read off these.)
  if (!text) sessionLog.event('student.blank', { itemIds: detail.itemIds || [], ms: detail.ms || 0 });
  conductor.answerStudent(text, { itemIds: detail.itemIds || [], unheard: !text })
    .then((decided) => {
      // False: they have spoken again, and that turn is being answered
      // instead — or there was nothing to answer (a sound, not speech).
      if (decided === false) {
        if (!text) state.session?.clearSilenceWatchdog();
        return;
      }
      if (decided) conductor.speak(decided);
      else state.session?.respond('');
    })
    .catch((error) => {
      // Whatever went wrong, the student still gets a reply.
      sessionLog.event('turn.error', { message: error?.message || String(error) });
      state.session?.respond('');
    })
    .finally(() => { answersInFlight = Math.max(0, answersInFlight - 1); });
}

/**
 * A sound that was not speech: a cough, a click, the tutor's own voice coming
 * back through the microphone. Nothing is answered. But the session stops the
 * tutor talking the moment it hears anything, so whatever that cost is said.
 *
 * @param {{overTutor: boolean}} detail
 */
function handleNoise(detail) {
  const session = state.session;
  // A reply is waiting, on its way or being given: that is what gets said.
  // (One held back while the sound lasted is let go.)
  if (session?.replyOnItsWay) {
    session.releaseHeld();
    return;
  }
  // Was the tutor cut off by it, and has it said nothing since?
  const cut = Boolean(detail.overTutor) && tutorCut && tutorReplies === repliesAtSpeech;
  const again = conductor.resay({ cut });
  if (again) {
    conductor.speak(again);
    return;
  }
  // Cut off where no line is scripted — in ordinary conversation — the tutor
  // picks up by itself. Otherwise nobody is owed a reply: do not go looking.
  if (cut) session?.respond('');
  else session?.clearSilenceWatchdog();
}

/**
 * The written version of something the student said has arrived.
 * @param {string} text
 * @param {string} [itemId] the server's id for that stretch of speech
 */
function handleStudentTurn(text, itemId = '') {
  if (!conductor.directed) {
    conductor.handleStudentTurn(text);
    return;
  }
  if (itemId) studentTurns.transcript(itemId, text);
  else answerStudent(text);
}

/** The student spoke and, some seconds on, nothing has answered them. */
function handleUnanswered() {
  // Something is: a turn still being put together, or a reply being decided.
  if (studentTurns.waiting || answersInFlight > 0) return;
  if (!studentTurns.rescue()) answerStudent('');
}

/** Forget every turn in flight. Part of starting and ending a call. */
function clearStudentTurns() {
  studentTurns.reset();
  tutorReplies = 0;
  repliesAtSpeech = 0;
  tutorCut = false;
  answersInFlight = 0;
}

el.lessonSelect.addEventListener('change', (event) => {
  const value = /** @type {HTMLSelectElement} */ (event.target).value;
  setActiveLesson(value, { reason: 'ui' });
});

el.endLessonBtn.addEventListener('click', () => {
  setActiveLesson('', { reason: 'ui' });
});

// The student's escape hatch from a phase that is dragging. They should never
// have to talk the tutor into moving on.
el.nextPhaseBtn.addEventListener('click', () => {
  if (!lessons.isActive) return;

  const result = lessons.advancePhase();
  if (!result.ok) {
    transcript.addSystemNote(
      result.last
        ? 'This is the last part of the lesson. Say so, or press Back to conversation to stop.'
        : 'This lesson has no further parts to move to.',
      'info',
    );
    return;
  }

  sessionLog.event('lesson.phase', { to: result.phaseName, reason: 'student pressed Move on' });
  transcript.addSystemNote(`Moving on to: ${result.phaseName}.`, 'info');
  renderLessonStrip();
  updateControls();

  // Tell the tutor out loud, so it changes tack now rather than waiting for the
  // student to speak again — once the new part's material is in hand.
  conductor.beginPart(
    `The student pressed "Move on". You are now in the ${result.phaseName} part of the lesson. ` +
      'Say so in a few words, then begin it.',
  );
});

el.refreshLessonsBtn.addEventListener('click', async () => {
  el.refreshLessonsBtn.disabled = true;
  const runningBefore = lessons.runtime.skill?.name || '';
  try {
    await lessons.load({ refresh: true });
    renderLessonSelect();
    renderLessonStrip();

    // A reload can drop the lesson that was running. Say so, and make sure the
    // live session hears about it too.
    if (runningBefore && !lessons.isActive) {
      transcript.addSystemNote(
        `The ${runningBefore} lesson stopped: it is no longer in the lesson library.`,
        'info',
      );
    }
    syncLessonPrompt();
    updateControls();

    if (lessons.loadError) {
      showBanner(`Lessons could not be reloaded: ${lessons.loadError}`, 'error');
    } else {
      showBanner(
        `${lessons.skills.length} lesson${lessons.skills.length === 1 ? '' : 's'} loaded.`,
        'success',
      );
    }
  } finally {
    el.refreshLessonsBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Enable/disable everything according to the current state
// ---------------------------------------------------------------------------

function updateControls() {
  const ready = Boolean(state.backendOk && state.root && state.profile);

  el.startCallBtn.disabled = !ready || state.callActive;
  el.startCallBtn.hidden = state.callActive;
  el.endCallBtn.hidden = !state.callActive;
  el.muteBtn.disabled = !state.callActive;
  el.showPromptBtn.disabled = !state.profile;

  el.lessonSelect.disabled = !state.profile || lessons.skills.length === 0;
  el.endLessonBtn.disabled = !lessons.isActive;
  el.nextPhaseBtn.disabled = !lessons.isActive || !state.callActive;

  el.userSelect.disabled = state.storageStatus !== 'connected' || state.callActive;
  el.languageSelect.disabled =
    state.storageStatus !== 'connected' || !state.currentUser || state.callActive;
  el.levelSelect.disabled = !state.profile || state.callActive;
  el.tutorNameInput.disabled = !state.profile || state.callActive;
  el.pickFolderBtn.disabled = state.callActive || state.storageStatus === 'unsupported';

  if (state.profile) {
    el.tutorNameInput.value = state.profile.tutor_name || '';
    el.tutorNameInput.placeholder = defaultTutorName(state.profile.target_language);
  } else {
    el.tutorNameInput.value = '';
  }

  const label = profileLabel({ user: state.currentUser, language: state.currentLanguage });
  el.topbarProfile.textContent = state.profile ? label : 'No profile selected';
  setStatus(
    el.statusProfile,
    state.profile ? 'ok' : 'idle',
    state.profile ? label : 'None selected',
  );

  if (state.profile) {
    el.topbarSub.textContent = `${state.profile.tutor_name} · ${coerceLevel(
      state.profile.proficiency_level,
    )}`;
  } else if (state.storageStatus !== 'connected') {
    el.topbarSub.textContent = 'Select a storage folder to begin';
  } else if (!state.currentUser) {
    el.topbarSub.textContent = 'Select or create a user';
  } else {
    el.topbarSub.textContent = 'Select or add a language';
  }
}

// ---------------------------------------------------------------------------
// Name dialog (create user / add language)
// ---------------------------------------------------------------------------

/** @type {((value: string|null) => void)|null} */
let namePromiseResolve = null;

/**
 * @param {{title: string, body: string, label: string, confirm: string, existing: string[]}} options
 * @returns {Promise<string|null>}
 */
function askForName({ title, body, label, confirm, existing }) {
  el.nameDialogTitle.textContent = title;
  el.nameDialogBody.textContent = body;
  el.nameDialogLabel.textContent = label;
  el.nameConfirm.textContent = confirm;
  el.nameInput.value = '';
  el.nameError.hidden = true;
  el.nameForm.dataset.existing = JSON.stringify(existing);

  openDialog(el.nameDialog);
  setTimeout(() => el.nameInput.focus(), 30);

  return new Promise((resolve) => {
    namePromiseResolve = resolve;
  });
}

function resolveName(value) {
  const resolve = namePromiseResolve;
  namePromiseResolve = null;
  closeDialog(el.nameDialog);
  resolve?.(value);
}

el.nameForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const { ok, value, error } = validateName(el.nameInput.value);
  if (!ok) {
    el.nameError.textContent = error || 'That name cannot be used.';
    el.nameError.hidden = false;
    return;
  }

  /** @type {string[]} */
  let existing = [];
  try {
    existing = JSON.parse(el.nameForm.dataset.existing || '[]');
  } catch {
    existing = [];
  }

  if (existing.some((name) => name.toLowerCase() === value.toLowerCase())) {
    el.nameError.textContent = 'That name already exists.';
    el.nameError.hidden = false;
    return;
  }

  resolveName(value);
});

el.nameCancel.addEventListener('click', () => resolveName(null));
el.nameDialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  resolveName(null);
});

// ---------------------------------------------------------------------------
// Selection handlers
// ---------------------------------------------------------------------------

el.userSelect.addEventListener('change', async (event) => {
  const select = /** @type {HTMLSelectElement} */ (event.target);
  const value = select.value;

  if (value === CREATE_USER) {
    // Put the dropdown back where it was before opening the dialog, so a
    // cancelled creation cannot leave the UI showing a user that is not active.
    select.value = state.currentUser || '';

    const name = await askForName({
      title: 'Create new user',
      body: 'A folder will be created under Users/ in your storage folder.',
      label: 'User name',
      confirm: 'Create user',
      existing: state.users.map((user) => user.name),
    });
    if (!name || !state.root) return;

    try {
      await createUser(state.root, name);
      await refreshProfiles({ keepSelection: false });
      await selectUser(name);
    } catch (error) {
      showBanner(`Could not create that user: ${error?.message || error}`, 'error', { force: true });
    }
    return;
  }

  await selectUser(value);
});

/** Make `userName` the active user and refresh everything downstream. */
async function selectUser(userName) {
  state.currentUser = userName || '';
  state.currentLanguage = '';
  state.profile = null;
  state.recommendation = null;

  renderUserSelect();
  renderLanguageSelect();
  renderLevelSelect();
  renderMemoryCard();
  updateControls();

  if (!state.currentUser) return;

  // If this user has exactly one language, activating it immediately is what
  // the user wanted anyway.
  const user = state.users.find((entry) => entry.name === state.currentUser);
  if (user && user.languages.length === 1) {
    await selectLanguage(user.languages[0].name);
  }
}

el.languageSelect.addEventListener('change', async (event) => {
  const select = /** @type {HTMLSelectElement} */ (event.target);
  const value = select.value;

  if (value === ADD_LANGUAGE) {
    select.value = state.currentLanguage || '';

    const user = state.users.find((entry) => entry.name === state.currentUser);
    const name = await askForName({
      title: 'Add new language',
      body: `A folder will be created under Users/${state.currentUser}/.`,
      label: 'Language name',
      confirm: 'Add language',
      existing: user ? user.languages.map((language) => language.name) : [],
    });
    if (!name || !state.root) return;

    try {
      await createLanguage(state.root, state.currentUser, name);
      await refreshProfiles();
      await selectLanguage(name);
    } catch (error) {
      showBanner(`Could not add that language: ${error?.message || error}`, 'error', { force: true });
    }
    return;
  }

  await selectLanguage(value);
});

/** Make `language` active for the current user and load its profile. */
async function selectLanguage(language) {
  state.currentLanguage = language || '';
  state.profile = null;
  state.recommendation = null;

  renderLanguageSelect();

  if (!state.currentUser || !state.currentLanguage) {
    renderLevelSelect();
    renderMemoryCard();
    updateControls();
    return;
  }

  await loadProfile(state.currentUser, state.currentLanguage);
  renderLanguageSelect();
}

// --- Lesson Comfort Level: the one control that may change it --------------

el.levelSelect.addEventListener('change', async (event) => {
  if (!state.profile) return;
  const level = coerceLevel(/** @type {HTMLSelectElement} */ (event.target).value);
  state.profile.proficiency_level = level;
  state.recommendation = evaluateRecommendation(level, state.profile.assessment_history);
  renderMemoryCard();
  updateControls();
  await saveProfile();
});

el.tutorNameInput.addEventListener('change', async (event) => {
  if (!state.profile) return;
  const input = /** @type {HTMLInputElement} */ (event.target);
  const name = input.value.trim() || defaultTutorName(state.profile.target_language);
  input.value = name;
  state.profile.tutor_name = name;
  renderMemoryCard();
  updateControls();
  await saveProfile();
});

el.applyRecoBtn.addEventListener('click', async () => {
  const suggested = state.recommendation?.suggestedLevel;
  if (!state.profile || !suggested) return;

  // Explicit user approval — the only route by which an AI assessment can
  // affect the Lesson Comfort Level.
  state.profile.proficiency_level = coerceLevel(suggested);
  state.recommendation = evaluateRecommendation(
    state.profile.proficiency_level,
    state.profile.assessment_history,
  );

  renderLevelSelect();
  renderMemoryCard();
  updateControls();

  if (await saveProfile()) {
    showBanner(`Lesson Comfort Level set to ${state.profile.proficiency_level}.`, 'success', {
      force: true,
    });
  }
});

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

async function startCall() {
  if (!state.profile || state.callActive) return;

  hideBanner();
  transcript.clear();
  transcript.setLanguage(state.profile.target_language);

  // Forget the previous call's lesson observations. A lesson the student
  // selected before pressing Start Call survives this (PART 24).
  lessons.startCall();
  conductor.reset();
  conductor.directed = true;
  clearStudentTurns();

  sessionLog.start({
    user: state.currentUser,
    language: state.profile.target_language,
    level: state.profile.proficiency_level,
    tutor: state.profile.tutor_name,
    lesson: lessons.activeId || null,
    phase: lessons.runtime.phaseId || null,
    weaknesses: state.profile.known_weaknesses?.length || 0,
    vocabulary: state.profile.recent_vocab?.length || 0,
    lessonsAvailable: lessons.skills.map((skill) => skill.id),
    referenceLanguages: Object.keys(lessons.reference || {}),
  });

  state.callActive = true;
  startCallTimer();
  updateControls();
  setCallState('Connecting…', 'connecting');
  setStatus(el.statusWebrtc, 'pending', 'Connecting…');
  setStatus(el.statusMic, 'pending', 'Requesting…');

  const session = new RealtimeSession({
    onStatus: (status) => {
      switch (status) {
        case 'mic-active':
          setStatus(el.statusMic, 'ok', 'Active');
          break;
        case 'mic-denied':
          setStatus(el.statusMic, 'error', 'Blocked');
          break;
        case 'connected':
          setStatus(el.statusWebrtc, 'ok', 'Connected');
          setCallState('Live — speak whenever you are ready', 'live');
          break;
        case 'reconnecting':
          setStatus(el.statusWebrtc, 'warn', 'Reconnecting…');
          break;
        case 'closed':
          setStatus(el.statusWebrtc, 'idle', 'Idle');
          setStatus(el.statusMic, 'idle', 'Off');
          break;
        default:
          break;
      }
    },
    onConnectionState: (connectionState) => {
      if (connectionState === 'connected') setStatus(el.statusWebrtc, 'ok', 'Connected');
      else if (connectionState === 'failed') setStatus(el.statusWebrtc, 'error', 'Failed');
    },
    onUserDelta: ({ itemId, delta }) => transcript.appendDelta('user', itemId, delta),
    onUserDone: ({ itemId, text }) => {
      transcript.completeMessage('user', itemId, text);
      // What the tutor BELIEVES the student said. When a lesson goes wrong this
      // is frequently the answer, and it is invisible on screen for Japanese
      // because the view shows romaji.
      sessionLog.event('student', { text, itemId });
      handleStudentTurn(text, itemId);
    },
    // The server has heard a stretch of speech and is waiting for the app to
    // ask for the reply. The written version follows in a moment.
    onStudentCommitted: ({ itemId }) => { if (conductor.directed) studentTurns.committed(itemId); },
    // They have started speaking — possibly again, before being answered.
    onStudentSpeaking: (detail) => {
      repliesAtSpeech = tutorReplies;
      if (conductor.directed) studentTurns.speechStarted(detail);
    },
    onStudentStopped: (detail) => studentTurns.speechStopped(detail),
    // The tutor's reply can be heard: what the student says now is a new turn.
    onTutorSpeaking: () => {
      tutorReplies += 1;
      tutorCut = false;
      studentTurns.replyHeard();
    },
    onTutorCut: () => { tutorCut = true; },
    // The student spoke and nothing came of it. Ask for the reply now.
    onUnansweredTurn: () => handleUnanswered(),
    // Whether the session is really waiting for the app before replying. If it
    // is not, the app must not ask as well: the lesson goes back to steering
    // the tutor through its standing instructions.
    onTurnMode: (directed) => {
      if (conductor.directed === directed) return;
      conductor.directed = directed;
      sessionLog.event('turn.mode', { directed });
      syncLessonPrompt('turn-mode');
    },
    onTutorDelta: ({ itemId, delta }) => transcript.appendDelta('assistant', itemId, delta),
    onTutorDone: ({ itemId, text, cut }) => {
      transcript.completeMessage('assistant', itemId, text);
      sessionLog.event('tutor', { text, itemId, ...(cut ? { cut: true } : {}) });
      // Where the tutor has got to in the lesson is read off what it says.
      conductor.handleTutorTurn(text, { cut: Boolean(cut) });
    },
    onError: ({ message, fatal }) => {
      transcript.addSystemNote(message, 'error');
      sessionLog.event('realtime.error', { message, fatal });
      if (fatal) showBanner(message, 'error');
    },
    // Turn-taking, which is invisible on screen and is the whole story when the
    // tutor appears to hang: who asked for the turn, whether the server ever
    // created one, and how it ended.
    onTurnEvent: (detail) => sessionLog.event('turn', detail),
    // The student spoke and nothing answered, so the client asked for the turn
    // itself. One of these is a rescued hang; a run of them is a sick session.
    onSilentTurn: ({ afterMs }) => sessionLog.event('turn.rescued', { afterMs }),
    // Out-of-band instructions the student never sees, and which shape the
    // tutor's next turn — so the log has to show them.
    onNudge: (instruction, options) =>
      sessionLog.event('nudge', { instruction, speak: Boolean(options?.speak) }),
    // Exactly what the transcriber was configured with. Garbage transcription
    // makes the tutor answer noise, and this is how we tell whether the hint
    // and the language code actually took effect.
    onTranscriptionConfig: (config) => sessionLog.event('transcription.config', config),
  });

  state.session = session;

  try {
    // A lesson chosen before the call starts with its material already
    // written. Usually it is — the plan was requested when the lesson was
    // picked — and this waits a few seconds for it if not.
    if (lessons.isActive) {
      setCallState('Preparing the lesson…', 'connecting');
      await Promise.race([
        conductor.ensurePlan('', { quiet: true }),
        new Promise((resolve) => { setTimeout(resolve, 8000); }),
      ]);
    }

    const openingContext = lessons.promptContext(state.profile.target_language);
    const openingInstructions = buildTutorPrompt(state.profile, openingContext, { directed: conductor.directed });
    // Inside a lesson the first thing said is the lesson's first line.
    const openingTurn = conductor.openingTurn();
    sessionLog.prompt('initial', openingInstructions, {
      lesson: lessons.activeId || null,
      phase: lessons.runtime.phaseId || null,
      referenceKeys: Object.keys(openingContext.reference || {}),
    });

    const transcriptionPrompt = buildTranscriptionPrompt({
      profile: state.profile,
      skill: lessons.runtime.skill,
      reference: openingContext.reference,
      // The lesson's own material, when it has been written: the best
      // available guide to what the microphone is about to hear.
      expected: lessons.runtime.hintItems(),
    });
    sessionLog.event('transcription.hint', { prompt: transcriptionPrompt });

    await session.start({
      instructions: openingInstructions,
      language: state.profile.target_language,
      userName: state.profile.user_name || state.currentUser,
      transcriptionPrompt,
      opening: openingTurn
        ? { instructions: openingTurn.instructions, say: openingTurn.say, examples: openingTurn.examples }
        : null,
    });

    el.muteBtn.textContent = 'Mute';
    transcript.addSystemNote(
      `Connected to ${state.profile.tutor_name}. Speak naturally — the tutor will start.`,
      'success',
    );
  } catch (error) {
    sessionLog.event('call.failed', { message: error?.message || String(error) });
    state.callActive = false;
    state.session = null;
    stopCallTimer();
    el.callTimer.hidden = true;
    state.callStartedAt = 0;
    setCallState('Ready', 'idle');
    setStatus(el.statusWebrtc, 'error', 'Failed');
    setStatus(el.statusMic, 'idle', 'Off');
    showBanner(error?.message || String(error), 'error');
    transcript.addSystemNote('The call could not be started.', 'error');
  } finally {
    updateControls();
  }
}

async function endCall() {
  if (!state.callActive) return;

  const session = state.session;
  const profileAtCall = state.profile;
  const userAtCall = state.currentUser;
  const languageAtCall = state.currentLanguage;
  const rawTranscript = transcript.getRawTranscript();
  // Taken before teardown: whatever the lesson observed still has to reach the
  // existing memory extractor (PART 46).
  const lessonSummaries = lessons.callSummary();

  // 1-4. Stop everything first. The user never waits on the network to hang up.
  state.callActive = false;
  state.session = null;
  stopCallTimer();
  conductor.stop();
  clearStudentTurns();
  setCallState('Ending…', 'connecting');
  updateControls();

  try {
    await session?.stop();
  } catch {
    /* teardown is best-effort; the UI must recover regardless */
  }

  setStatus(el.statusWebrtc, 'idle', 'Idle');
  setStatus(el.statusMic, 'idle', 'Off');
  setCallState('Session ended', 'done');

  // Unfinished lesson state is discarded, deliberately. The next attempt at the
  // same lesson starts from the beginning (PART 24).
  lessons.endCall();
  renderLessonSelect();
  renderLessonStrip();
  updateControls();

  if (!rawTranscript.length) {
    transcript.addSystemNote('Call ended. Nothing was said, so memory was left unchanged.', 'info');
    sessionLog.end({ turns: 0, lessons: lessonSummaries.length });
    return;
  }

  // 5-9. Everything below happens after the call is already closed.
  transcript.addSystemNote('Call ended. Reviewing the lesson…', 'info');
  await runMemoryExtraction({
    profile: profileAtCall,
    userName: userAtCall,
    language: languageAtCall,
    rawTranscript,
    lessonSummaries,
  });

  sessionLog.end({ turns: rawTranscript.length, lessons: lessonSummaries.length });
}

/**
 * Send the transcript for extraction and save the merged result.
 * Failures here never destroy existing memory.
 */
async function runMemoryExtraction({ profile, userName, language, rawTranscript, lessonSummaries = [] }) {
  if (!profile || !state.root) return;

  state.extracting = true;
  setCallState('Updating memory…', 'connecting');

  try {
    const response = await fetchWithTimeout(
      '/api/memory/extract',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Lesson observations ride along in the SAME request, judged by the
        // same model, merged into the same pools. There is no second extractor
        // and no lesson-specific memory (PART 45, PART 46).
        body: JSON.stringify({ profile, transcript: rawTranscript, lessons: lessonSummaries }),
      },
      60000,
    );

    const payload = await response.json().catch(() => null);

    if (!payload?.profile) {
      throw new Error(payload?.error || `The server returned HTTP ${response.status}.`);
    }

    // Save whatever came back — on the failure path this is the untouched
    // profile, so the write is still safe.
    await writeConfig(state.root, userName, language, payload.profile);

    // Only adopt it into the live UI if the user has not switched profiles in
    // the meantime.
    if (state.currentUser === userName && state.currentLanguage === language) {
      state.profile = payload.profile;
      state.recommendation =
        payload.recommendation ||
        evaluateRecommendation(payload.profile.proficiency_level, payload.profile.assessment_history);
      renderLevelSelect();
      renderMemoryCard();
      updateControls();
    }

    if (!payload.ok) {
      transcript.addSystemNote(
        `Memory could not be updated: ${payload.error}. Your existing memory is unchanged.`,
        'error',
      );
      setCallState('Session ended — memory unchanged', 'done');
      return;
    }

    if (payload.skipped) {
      transcript.addSystemNote(payload.reason || 'The lesson was too short to assess.', 'info');
      setCallState('Session ended', 'done');
      return;
    }

    sessionLog.event('memory.extract', {
      ok: payload.ok,
      skipped: payload.skipped,
      error: payload.error || null,
      added: payload.added || {},
      assessed: payload.profile?.ai_assessed_level || '',
    });

    const added = payload.added || {};
    const parts = [];
    if (added.vocab > 0) parts.push(`${added.vocab} new vocab item${added.vocab === 1 ? '' : 's'}`);
    if (added.weaknesses > 0) {
      parts.push(`${added.weaknesses} new weakness${added.weaknesses === 1 ? '' : 'es'}`);
    }
    const assessed = payload.profile.ai_assessed_level;

    transcript.addSystemNote(
      `Lesson saved${parts.length ? `: ${parts.join(', ')}` : ''}.` +
        (assessed ? ` AI assessment: ${assessed}.` : '') +
        ' Your Lesson Comfort Level is unchanged.',
      'success',
    );
    setCallState('Session complete', 'done');
  } catch (error) {
    transcript.addSystemNote(
      `Memory update failed: ${error?.message || error}. Your existing memory is unchanged.`,
      'error',
    );
    setCallState('Session ended — memory unchanged', 'done');
  } finally {
    state.extracting = false;
    updateControls();
  }
}

el.startCallBtn.addEventListener('click', () => {
  startCall().catch((error) => showBanner(error?.message || String(error), 'error', { force: true }));
});

el.endCallBtn.addEventListener('click', () => {
  endCall().catch((error) => showBanner(error?.message || String(error), 'error', { force: true }));
});

el.muteBtn.addEventListener('click', () => {
  if (!state.session) return;
  const nowEnabled = !state.session.isMicrophoneEnabled();
  state.session.setMicrophoneEnabled(nowEnabled);
  el.muteBtn.textContent = nowEnabled ? 'Mute' : 'Unmute';
  setStatus(el.statusMic, nowEnabled ? 'ok' : 'warn', nowEnabled ? 'Active' : 'Muted');
});

// Ending the tab mid-call should still release the microphone.
window.addEventListener('pagehide', () => {
  state.session?.stop();
  // A closed tab mid-lesson is exactly when the log matters most.
  sessionLog.end({ reason: 'page closed' });
});

// ---------------------------------------------------------------------------
// Prompt preview and info dialogs
// ---------------------------------------------------------------------------

el.showPromptBtn.addEventListener('click', () => {
  if (!state.profile) return;
  // The lesson layer is included, so the preview stays the exact instruction
  // text the tutor has right now — lesson and all (PART 42).
  const lessonContext = lessons.promptContext(state.profile?.target_language);
  el.promptSummary.textContent = promptSummary(state.profile, lessonContext);
  el.promptPreview.textContent = buildTutorPrompt(state.profile, lessonContext);
  openDialog(el.promptDialog);
});

el.promptClose.addEventListener('click', () => closeDialog(el.promptDialog));

el.promptCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.promptPreview.textContent || '');
    el.promptCopy.textContent = 'Copied';
    setTimeout(() => {
      el.promptCopy.textContent = 'Copy';
    }, 1400);
  } catch {
    el.promptCopy.textContent = 'Copy failed';
    setTimeout(() => {
      el.promptCopy.textContent = 'Copy';
    }, 1400);
  }
});

el.comfortInfoBtn.addEventListener('click', () => openDialog(el.infoDialog));
el.infoClose.addEventListener('click', () => closeDialog(el.infoDialog));

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

el.bannerClose.addEventListener('click', hideBanner);
el.retryHealthBtn.addEventListener('click', () => {
  hideBanner();
  checkBackend();
});
el.pickFolderBtn.addEventListener('click', handlePickFolder);
el.grantAccessBtn.addEventListener('click', handleGrantAccess);

function setSidebar(open) {
  el.sidebar.setAttribute('data-open', open ? 'true' : 'false');
  el.sidebarToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  el.scrim.hidden = !open;
}

el.sidebarToggle.addEventListener('click', () => setSidebar(true));
el.sidebarClose.addEventListener('click', () => setSidebar(false));
el.scrim.addEventListener('click', () => setSidebar(false));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setSidebar(false);
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  renderLevelSelect();
  renderUserSelect();
  renderLanguageSelect();
  renderLessonSelect();
  renderLessonStrip();
  renderMemoryCard();
  updateControls();

  // All three run in parallel and all three always settle. A lesson library
  // that fails to load leaves the app fully usable for normal conversation.
  await Promise.allSettled([checkBackend(), initStorage(), lessons.load(), loadKeyStatus()]);

  // First launch: ask for the key before anything else.
  if (keyStatus && !keyStatus.configured) openKeyDialog();

  renderLessonSelect();
  if (lessons.loadError) {
    console.warn('[kaiwa] Lessons unavailable:', lessons.loadError);
  }

  if (state.storageStatus === 'none' && isSupported()) {
    el.storagePath.textContent =
      `No folder selected yet. Pick one and the app will create Users/<name>/${DEFAULT_LANGUAGE}/ inside it.`;
  }

  updateControls();
}

boot().catch((error) => {
  showBanner(`Kaiwa failed to start: ${error?.message || error}`, 'error');
});
