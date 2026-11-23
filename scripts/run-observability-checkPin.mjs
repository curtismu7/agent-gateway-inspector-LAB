// checkPin.mjs — the ONE pin check for a lab that vendors shared/run-observability. Vendor to scripts/run-observability-checkPin.mjs (byte-for-byte), then
// call it from the lab's pin test:
//     import { checkPin } from '../scripts/run-observability-checkPin.mjs';
//     assert.deepEqual(checkPin(labRoot), []);
// or run it: node scripts/run-observability-checkPin.mjs <labRoot>   (exit 0 ok, 1 with the problems on stderr, 2 with the usage when no path is given).
// The pin file (web/src/run-observability/run-observability.sha256) lists each vendored file as "<sha256>  <canonical path relative to the lab root>":
//   web/src/run-observability/{RunObservability.jsx,run-observability.css,run-observability.test.jsx,fixtures.js}   (required)
//   server/src/runObservability.js                                                                                    (the core: required)
//   server/src/runObservabilityReaders.js                                                                             (optional: only labs that read logs)
// It FAILS when: the pin file is missing or has a line it cannot read, a duplicate, a non-canonical path (./, //, .., absolute) or a path that is not a
// vendored file; a required file is missing from the lab or from the pin; any file in web/src/run-observability/ or any server/src/runObservability*
// file is not in the pin; a pinned file is a symlink, a directory or anything but a regular file (or resolves outside the lab); or a hash differs.
// Dependency-free (node:fs, node:path, node:url, node:crypto only).
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const PIN_FILE = 'web/src/run-observability/run-observability.sha256';
export const CORE = 'server/src/runObservability.js';
export const READERS = 'server/src/runObservabilityReaders.js';
export const VENDORED = [
  'web/src/run-observability/RunObservability.jsx', 'web/src/run-observability/run-observability.css',
  'web/src/run-observability/run-observability.test.jsx', 'web/src/run-observability/fixtures.js',
  CORE, READERS,
];
const WEB_DIR = 'web/src/run-observability';
const SERVER_DIR = 'server/src';

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical = (rel) => typeof rel === 'string' && rel !== '' && !rel.startsWith('/') && !rel.includes('\\') && rel.split('/').every((p) => p !== '' && p !== '.' && p !== '..');
const lst = (file) => { try { return fs.lstatSync(file); } catch { return null; } };

export function checkPin(labRoot, { pinFile = PIN_FILE } = {}) {
  const problems = [];
  let root;
  try { root = fs.realpathSync(path.resolve(String(labRoot))); } catch { return [`${String(labRoot)}: the lab folder does not exist`]; }
  const pinPath = path.join(root, pinFile);
  const pst = lst(pinPath);
  if (!pst) return [`${pinFile}: the pin file is missing`];
  if (!pst.isFile()) return [`${pinFile}: the pin file is not a regular file`];
  const pinned = new Map();
  for (const line of fs.readFileSync(pinPath, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const [hash, rel, ...rest] = line.trim().split(/\s+/);
    if (!/^[0-9a-f]{64}$/.test(hash || '') || rest.length || !canonical(rel)) { problems.push(`${pinFile}: cannot read the line "${line.slice(0, 80)}"`); continue; }
    if (!VENDORED.includes(rel)) { problems.push(`${pinFile}: ${rel} is not a vendored run-observability file`); continue; }
    if (pinned.has(rel)) { problems.push(`${pinFile}: ${rel} is pinned twice`); continue; }
    pinned.set(rel, hash);
  }
  for (const rel of VENDORED) {
    const file = path.join(root, rel);
    const st = lst(file);
    const required = rel !== READERS;
    if (!st) { if (required) problems.push(`${rel}: missing from the lab`); continue; }
    if (!pinned.has(rel)) { problems.push(`${rel}: exists in the lab but is not in the pin file`); continue; }
    if (st.isSymbolicLink() || !st.isFile()) { problems.push(`${rel}: must be a regular file, not a symlink, directory or device`); continue; }
    let real; try { real = fs.realpathSync(file); } catch { problems.push(`${rel}: cannot be resolved`); continue; }
    if (!real.startsWith(`${root}${path.sep}`)) { problems.push(`${rel}: resolves outside the lab`); continue; }
    if (sha(file) !== pinned.get(rel)) problems.push(`${rel}: modified (re-vendor it byte-for-byte from shared/run-observability)`);
  }
  // Any other file of ours in the lab is unpinned.
  const known = new Set([...VENDORED, PIN_FILE]);
  for (const [dir, test] of [[WEB_DIR, () => true], [SERVER_DIR, (n) => /^runObservability/i.test(n)]]) {
    let names = [];
    try { names = fs.readdirSync(path.join(root, dir)); } catch { /* the folder is not there */ }
    for (const n of names) if (test(n) && !known.has(`${dir}/${n}`)) problems.push(`${dir}/${n}: is not in the pin file (nothing else may live beside the vendored files)`);
  }
  return problems;
}

// CLI. The guard compares real paths, so a path with a space, a symlinked folder (macOS /tmp) and a symlinked script all run it; it never fails open.
const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  if (!process.argv[2]) { console.error('usage: node run-observability-checkPin.mjs <labRoot>'); process.exit(2); }
  const problems = checkPin(process.argv[2]);
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('run-observability pin ok');
}
