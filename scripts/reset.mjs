#!/usr/bin/env node
// Reset a running app: POST /api/reset clears the calls, the pending holds, the rate windows and starts a new audit epoch.
// Saved settings are kept (there are none to clear). The UI Reset button also puts the diagram boxes back where they started;
// a script cannot move boxes in a browser tab.
//   node scripts/reset.mjs [base-url]      (default http://127.0.0.1:${PORT:-5850})
// Loopback only: refuses any other host. Needs the server already running; sends the same-origin header the server requires.
import { pathToFileURL } from 'node:url';
import { isLoopbackHost } from '../server/src/safety.js';

export async function reset(base = `http://127.0.0.1:${process.env.PORT || 5850}`) {
  const u = new URL(base);
  if (!isLoopbackHost(u.hostname)) throw new Error(`refusing ${u.hostname}: loopback only`);
  const r = await fetch(new URL('/api/reset', u), { method: 'POST', headers: { 'content-type': 'application/json', origin: u.origin }, body: '{}' });
  if (!r.ok) throw new Error(`reset failed: HTTP ${r.status}`);
  return r.json();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  reset(process.argv[2]).then(() => console.log('reset: ok'), (e) => { console.error(e.message); process.exit(1); });
}
