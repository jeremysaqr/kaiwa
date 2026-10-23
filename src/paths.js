/**
 * src/paths.js
 *
 * Where Kaiwa finds its files, whether it runs from source or as a release
 * executable.
 *
 *   APP_ROOT  public/, Lessons/, Languages/ and Logs/. From source this is the
 *             project folder; in a release it is the folder holding the
 *             executable, since those folders ship beside it.
 *   DATA_DIR  per-user settings (the saved API key), kept out of the app
 *             folder so an upgrade or a shared copy never carries a key along:
 *               Windows  %APPDATA%\Kaiwa
 *               macOS    ~/Library/Application Support/Kaiwa
 *               Linux    $XDG_CONFIG_HOME/kaiwa, else ~/.config/kaiwa
 *             KAIWA_DATA_DIR overrides it.
 */

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * True inside a `bun build --compile` executable, whose modules live in a
 * virtual filesystem ($bunfs on macOS and Linux, ~BUN on Windows).
 */
const MODULE_PATH = fileURLToPath(import.meta.url);
export const IS_COMPILED = /\$bunfs|~BUN/.test(MODULE_PATH);

export const APP_ROOT = IS_COMPILED
  ? path.dirname(process.execPath)
  : path.resolve(path.dirname(MODULE_PATH), '..');

function defaultDataDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kaiwa');
  }
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Kaiwa');
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'kaiwa');
}

export const DATA_DIR = path.resolve(process.env.KAIWA_DATA_DIR || defaultDataDir());
