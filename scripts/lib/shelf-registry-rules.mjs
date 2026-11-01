// A copy of the validation rules in demo-shelf's server/src/registry.js (validateDemos, checkPath and its constants),
// reduced to returning a list of problems. Copied, not imported: this repo never reads the shelf repo at runtime.
// If the shelf's rules change, update this copy.
import path from 'node:path';

const ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const SHELL_CHARS = /[;&|$`<>\\"'*?(){}!#\n\r\t\0]/;
const FIELDS = ['id', 'name', 'catalogId', 'kind', 'description', 'url', 'where', 'mockUrl', 'healthPath', 'composeFile', 'composeOverlays', 'notes', 'tags'];

// A compose path is absolute, or relative to the demo root (the folder the demo repos sit in). A relative path is what makes an
// entry portable across machines (rule 9); the shelf resolves it against its demo root.
function checkPath(label, p, errors) {
  if (typeof p !== 'string' || !p) return errors.push(`${label} must be a path`);
  if (SHELL_CHARS.test(p)) return errors.push(`${label} contains shell characters`);
  if (p.split('/').includes('..')) return errors.push(`${label} must not contain ".."`);
  if (!/\.ya?ml$/.test(p)) errors.push(`${label} must be a .yml or .yaml file`);
}

export function shelfProblems(demos) {
  const errors = [];
  if (!Array.isArray(demos)) return ['"demos" must be an array'];
  const seen = new Set();
  demos.forEach((d, i) => {
    const at = `demos[${i}]${d && typeof d.id === 'string' ? ` (${d.id})` : ''}`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return errors.push(`${at} must be an object`);
    if (typeof d.id !== 'string' || !ID.test(d.id)) errors.push(`${at}: id must match ${ID}`);
    else if (seen.has(d.id)) errors.push(`${at}: duplicate id`);
    else seen.add(d.id);
    for (const f of ['name', 'description']) {
      if (typeof d[f] !== 'string' || !d[f].trim() || d[f].length > 300) errors.push(`${at}: ${f} must be a non-empty string up to 300 characters`);
    }
    for (const f of ['catalogId', 'kind']) {
      if (d[f] !== undefined && (typeof d[f] !== 'string' || d[f].length > 40)) errors.push(`${at}: ${f} must be a short string`);
    }
    try {
      const u = new URL(d.url);
      const host = u.hostname.toLowerCase();
      if (u.protocol !== 'http:' && u.protocol !== 'https:') errors.push(`${at}: url must be http or https`);
      else if (u.username || u.password) errors.push(`${at}: url must not carry credentials`);
      else if (u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) errors.push(`${at}: url must be an origin only`);
      else if (!LOOPBACK.has(host)) errors.push(`${at}: host "${host}" is not loopback`);
    } catch { errors.push(`${at}: url is not a valid URL`); }
    const hp = d.healthPath === undefined ? '/api/health' : d.healthPath;
    if (typeof hp !== 'string' || !/^\/[A-Za-z0-9._~\-/]*$/.test(hp) || hp.startsWith('//') || hp.includes('..')) errors.push(`${at}: healthPath must be a plain path starting with "/"`);
    if (d.composeFile !== undefined) checkPath(`${at}: composeFile`, d.composeFile, errors);
    if (d.composeOverlays !== undefined) {
      if (!Array.isArray(d.composeOverlays)) errors.push(`${at}: composeOverlays must be an array of paths`);
      else d.composeOverlays.forEach((o, j) => checkPath(`${at}: composeOverlays[${j}]`, o, errors));
      if (d.composeFile === undefined && d.composeOverlays?.length) errors.push(`${at}: composeOverlays needs composeFile`);
    }
    for (const k of Object.keys(d)) if (!FIELDS.includes(k)) errors.push(`${at}: unknown field ${k} (the shelf drops it)`);
  });
  return errors;
}
