/**
 * tools/build.mjs
 *
 * Builds a Kaiwa release for one platform: a single executable (Bun's
 * `--compile`) with the folders it reads at run time beside it, packed into
 * one archive under dist/.
 *
 *   node tools/build.mjs                         this computer's platform
 *   node tools/build.mjs --target linux-arm64    another one
 *
 * Targets: windows-x64, macos-x64, macos-arm64, linux-x64, linux-arm64.
 * Needs Bun on the PATH (or its path in BUN). macOS builds are ad-hoc signed
 * when built on a Mac; Apple silicon will not run an unsigned binary.
 *
 * Never packed: .env, Users/, Logs/, or anything else outside the list below.
 */

import { spawnSync } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** What ships beside the executable. */
const SHIPPED = ['public', 'Lessons', 'Languages', 'README.md', 'LICENSE', '.env.example'];

const TARGETS = {
  'windows-x64': 'bun-windows-x64',
  'macos-x64': 'bun-darwin-x64',
  'macos-arm64': 'bun-darwin-arm64',
  'linux-x64': 'bun-linux-x64',
  'linux-arm64': 'bun-linux-arm64',
};

function hostTarget() {
  const os = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  return `${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
}

function run(command, args, options = {}) {
  console.log(`  $ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}

const flag = process.argv.indexOf('--target');
const target = flag >= 0 ? process.argv[flag + 1] : hostTarget();
if (!TARGETS[target]) {
  console.error(`Unknown target "${target}". Use one of: ${Object.keys(TARGETS).join(', ')}`);
  process.exit(1);
}

const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `Kaiwa-v${version}-${target}`;
const stage = path.join(DIST, name);
const exe = path.join(stage, target.startsWith('windows') ? 'Kaiwa.exe' : 'Kaiwa');

console.log(`\nBuilding ${name}`);
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });

run(process.env.BUN || 'bun', [
  'build', path.join(ROOT, 'server.js'),
  '--compile',
  `--target=${TARGETS[target]}`,
  `--outfile=${exe}`,
]);

if (target.startsWith('macos') && process.platform === 'darwin') {
  run('codesign', ['--force', '--sign', '-', exe]);
}

for (const entry of SHIPPED) {
  await cp(path.join(ROOT, entry), path.join(stage, entry), { recursive: true });
}

// zip for Windows; tar.gz elsewhere, which keeps the executable bit.
if (target.startsWith('windows')) {
  const archive = path.join(DIST, `${name}.zip`);
  await rm(archive, { force: true });
  // Windows' own tar (bsdtar) writes zip files; Git's GNU tar does not.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'bsdtar';
  run(tar, ['-a', '-c', '-f', archive, name], { cwd: DIST });
  console.log(`\n  ${path.relative(ROOT, archive)}\n`);
} else {
  const archive = path.join(DIST, `${name}.tar.gz`);
  run('tar', ['-czf', archive, name], { cwd: DIST });
  console.log(`\n  ${path.relative(ROOT, archive)}\n`);
}
