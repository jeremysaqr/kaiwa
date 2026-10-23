/**
 * public/js/storage.js
 *
 * Local filesystem access via the File System Access API, plus persistence of
 * the chosen directory handle in IndexedDB.
 *
 * Directory layout under the selected root:
 *
 *   [Selected Root]/
 *   └── Users/
 *       ├── Alex/
 *       │   ├── German/config.json
 *       │   └── Japanese/config.json
 *       └── Sam/
 *           └── Spanish/config.json
 *
 * Nothing here assumes a fixed user or a fixed language; the tree is
 * discovered by walking it.
 *
 * Every operation is defensive: a stale handle, a revoked permission or a
 * corrupt config must degrade to a clear message, never to a crash or a
 * permanent spinner (PART 5, PART 32).
 */

const DB_NAME = 'language-tutor';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const ROOT_KEY = 'storage-root';
const USERS_DIR = 'Users';
const CONFIG_FILE = 'config.json';

/** Thrown when the browser cannot do File System Access at all. */
export class UnsupportedBrowserError extends Error {
  constructor() {
    super(
      'This browser cannot open a local folder. Use Chrome or Edge on the desktop — ' +
        'Firefox and Safari do not support the File System Access API.',
    );
    this.name = 'UnsupportedBrowserError';
  }
}

/** Thrown when we hold a handle but no longer have permission to use it. */
export class PermissionRequiredError extends Error {
  constructor(message = 'Permission to read the storage folder is needed again.') {
    super(message);
    this.name = 'PermissionRequiredError';
  }
}

/** @returns {boolean} */
export function isSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// ---------------------------------------------------------------------------
// IndexedDB: remembering the directory handle between visits
// ---------------------------------------------------------------------------

/** @returns {Promise<IDBDatabase|null>} */
function openDatabase() {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/**
 * @param {'readonly'|'readwrite'} mode
 * @param {(store: IDBObjectStore) => IDBRequest} action
 * @returns {Promise<any>}
 */
async function withStore(mode, action) {
  const db = await openDatabase();
  if (!db) return null;
  return new Promise((resolve) => {
    let transaction;
    try {
      transaction = db.transaction(STORE_NAME, mode);
    } catch {
      db.close();
      resolve(null);
      return;
    }
    const request = action(transaction.objectStore(STORE_NAME));
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onabort = () => {
      db.close();
      resolve(null);
    };
  });
}

/** Persist the chosen root handle so the user is not asked again. */
export async function rememberRoot(handle) {
  try {
    await withStore('readwrite', (store) => store.put(handle, ROOT_KEY));
    return true;
  } catch {
    return false;
  }
}

/** @returns {Promise<FileSystemDirectoryHandle|null>} */
export async function recallRoot() {
  try {
    const handle = await withStore('readonly', (store) => store.get(ROOT_KEY));
    return handle && typeof handle.queryPermission === 'function' ? handle : null;
  } catch {
    return null;
  }
}

/** Forget the stored handle (used when it turns out to be unusable). */
export async function forgetRoot() {
  try {
    await withStore('readwrite', (store) => store.delete(ROOT_KEY));
  } catch {
    /* nothing we can do, and nothing that should stop the app */
  }
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

/**
 * Current permission state without prompting.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<'granted'|'prompt'|'denied'>}
 */
export async function queryPermission(handle) {
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'denied';
  }
}

/**
 * Ask for permission. Must be called from a user gesture.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export async function requestPermission(handle) {
  try {
    const state = await handle.requestPermission({ mode: 'readwrite' });
    return state === 'granted';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Picking and restoring the root
// ---------------------------------------------------------------------------

/**
 * Show the directory picker. Must be called from a user gesture.
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function pickRoot() {
  if (!isSupported()) throw new UnsupportedBrowserError();
  const handle = await window.showDirectoryPicker({
    id: 'language-tutor-root',
    mode: 'readwrite',
    startIn: 'documents',
  });
  await rememberRoot(handle);
  return handle;
}

/**
 * Try to bring back the previously selected folder without prompting.
 *
 * @returns {Promise<{status: 'connected'|'permission-required'|'none', handle: FileSystemDirectoryHandle|null}>}
 */
export async function restoreRoot() {
  if (!isSupported()) return { status: 'none', handle: null };

  const handle = await recallRoot();
  if (!handle) return { status: 'none', handle: null };

  const permission = await queryPermission(handle);

  if (permission === 'granted') {
    // The handle can still be stale — e.g. the folder was deleted or the drive
    // was unplugged. Prove it works before reporting success.
    try {
      await ensureDirectory(handle, USERS_DIR, { create: false });
      return { status: 'connected', handle };
    } catch (error) {
      if (error && error.name === 'NotFoundError') {
        // Folder is fine, it just has no Users/ subfolder yet.
        return { status: 'connected', handle };
      }
      await forgetRoot();
      return { status: 'none', handle: null };
    }
  }

  if (permission === 'prompt') return { status: 'permission-required', handle };

  await forgetRoot();
  return { status: 'none', handle: null };
}

// ---------------------------------------------------------------------------
// Directory / file helpers
// ---------------------------------------------------------------------------

/**
 * @param {FileSystemDirectoryHandle} parent
 * @param {string} name
 * @param {{create?: boolean}} [options]
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function ensureDirectory(parent, name, { create = true } = {}) {
  return parent.getDirectoryHandle(name, { create });
}

/**
 * Names of the sub-directories of `parent`, sorted case-insensitively.
 * @param {FileSystemDirectoryHandle} parent
 * @returns {Promise<string[]>}
 */
export async function listDirectories(parent) {
  const names = [];
  for await (const [name, entry] of parent.entries()) {
    if (entry.kind === 'directory' && !name.startsWith('.')) names.push(name);
  }
  return names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

/**
 * Walk the tree and report every user, their languages, and whether each
 * language already has a config.json.
 *
 * @param {FileSystemDirectoryHandle} root
 * @returns {Promise<{users: {name: string, languages: {name: string, hasConfig: boolean}[]}[]}>}
 */
export async function discoverProfiles(root) {
  /** @type {{name: string, languages: {name: string, hasConfig: boolean}[]}[]} */
  const users = [];

  let usersDir;
  try {
    usersDir = await ensureDirectory(root, USERS_DIR, { create: false });
  } catch (error) {
    if (error && error.name === 'NotFoundError') return { users: [] };
    throw error;
  }

  for (const userName of await listDirectories(usersDir)) {
    /** @type {{name: string, hasConfig: boolean}[]} */
    const languages = [];
    try {
      const userDir = await usersDir.getDirectoryHandle(userName);
      for (const languageName of await listDirectories(userDir)) {
        let hasConfig = false;
        try {
          const languageDir = await userDir.getDirectoryHandle(languageName);
          await languageDir.getFileHandle(CONFIG_FILE);
          hasConfig = true;
        } catch {
          hasConfig = false;
        }
        languages.push({ name: languageName, hasConfig });
      }
    } catch {
      // Unreadable user folder: list the user, no languages, keep going.
    }
    users.push({ name: userName, languages });
  }

  return { users };
}

/**
 * Create Users/[user]/ if needed.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} userName
 */
export async function createUser(root, userName) {
  const usersDir = await ensureDirectory(root, USERS_DIR);
  return ensureDirectory(usersDir, userName);
}

/**
 * Create Users/[user]/[language]/ if needed.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} userName
 * @param {string} language
 */
export async function createLanguage(root, userName, language) {
  const userDir = await createUser(root, userName);
  return ensureDirectory(userDir, language);
}

/**
 * Read Users/[user]/[language]/config.json.
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {string} userName
 * @param {string} language
 * @returns {Promise<{found: boolean, data: any, parseError: string|null}>}
 */
export async function readConfig(root, userName, language) {
  try {
    const usersDir = await ensureDirectory(root, USERS_DIR, { create: false });
    const userDir = await usersDir.getDirectoryHandle(userName);
    const languageDir = await userDir.getDirectoryHandle(language);
    const fileHandle = await languageDir.getFileHandle(CONFIG_FILE);
    const file = await fileHandle.getFile();
    const text = await file.text();

    if (!text.trim()) return { found: true, data: null, parseError: 'The file was empty.' };

    try {
      return { found: true, data: JSON.parse(text), parseError: null };
    } catch (error) {
      return { found: true, data: null, parseError: error?.message || 'Invalid JSON.' };
    }
  } catch (error) {
    if (error && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) {
      return { found: false, data: null, parseError: null };
    }
    throw error;
  }
}

/**
 * Write Users/[user]/[language]/config.json, creating folders as needed.
 *
 * @param {FileSystemDirectoryHandle} root
 * @param {string} userName
 * @param {string} language
 * @param {Record<string, any>} data
 */
export async function writeConfig(root, userName, language, data) {
  const languageDir = await createLanguage(root, userName, language);
  const fileHandle = await languageDir.getFileHandle(CONFIG_FILE, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(`${JSON.stringify(data, null, 2)}\n`);
  } finally {
    await writable.close();
  }
}

/**
 * A safe folder name. Windows forbids \\ / : * ? " < > | and trailing dots.
 * @param {string} name
 * @returns {{ok: boolean, value: string, error: string|null}}
 */
export function validateName(name) {
  const value = String(name ?? '').trim();
  if (!value) return { ok: false, value: '', error: 'Please enter a name.' };
  if (value.length > 64) {
    return { ok: false, value, error: 'Please use 64 characters or fewer.' };
  }
  if (/[\\/:*?"<>|]/.test(value)) {
    return { ok: false, value, error: 'These characters are not allowed: \\ / : * ? " < > |' };
  }
  if (/[. ]$/.test(value)) {
    return { ok: false, value, error: 'Names cannot end with a space or a period.' };
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)) {
    return { ok: false, value, error: 'That name is reserved by Windows.' };
  }
  return { ok: true, value, error: null };
}
