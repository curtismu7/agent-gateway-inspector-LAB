// Test helpers. Every test file owns a distinct slice (5861-5867 and 5880-5899) so files running in parallel never collide.
// Two files on one slice race for the same ports when node --test runs them as parallel processes.
import http from 'node:http';
import net from 'node:net';

export const BASES = { scenarios: 5880, api: 5884, safety: 5888, guards: 5892, spare: 5896, static: 5861, upstreams: 5865 };
const SLICE_END = { scenarios: 5883, api: 5887, safety: 5891, guards: 5895, spare: 5899, static: 5864, upstreams: 5867 };

const isFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

// A run of `count` consecutive free loopback ports inside a file's own slice, so a foreign process holding one
// of the usual ports moves the test along instead of failing it. The search resumes after the last run handed
// out (and wraps), so a port is not reused right after a test closed a server on it. Ports stay in 5861-5867 and 5880-5899.
// The upstream stubs must be on 5851-5859 in production; tests start them on a slice base through the same
// `basePort` argument, which is why the production guard (assertUpstreamTarget) is tested separately.
const cursor = {};
export async function freeBase(slice, count = 4) {
  const first = BASES[slice]; const last = SLICE_END[slice];
  const starts = [];
  for (let s = cursor[slice] ?? first; s + count - 1 <= last; s += 1) starts.push(s);
  for (let s = first; s < (cursor[slice] ?? first) && s + count - 1 <= last; s += 1) starts.push(s);
  for (const start of starts) {
    let ok = true;
    for (let p = start; p < start + count && ok; p += 1) ok = await isFree(p);
    if (ok) { cursor[slice] = start + count; return start; }
  }
  throw new Error(`no ${count} free ports in ${first}-${last}`);
}

// Like fetch, but lets a test set the Host header. Resolves { status, headers, json }.
export function request(port, method, path, { headers = {}, body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, method, path, agent: false, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...(host ? { host } : {}), ...headers } }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(raw); } catch { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, json, raw }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
