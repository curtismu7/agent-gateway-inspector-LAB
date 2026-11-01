// Preflight: the same checks GET /api/health reports from, plus whether the ports are free.
//   PORT=5865 npm run doctor        (the server port; 5850-5899 only)
// Prints only pass/fail lines, never the value of a setting. Exit 1 on any failure. Needs no network.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { applySharedSettings } = await import(pathToFileURL(path.join(root, 'server/src/settings.js')));
applySharedSettings(); // the one shared settings file (~/Development/.env or STANDALONE_ENV): only this app's key is taken

const { runChecks } = await import(pathToFileURL(path.join(root, 'server/src/doctor.js')));
const { serverPort, STUB_BASE_PORT, PORT_MIN, PORT_MAX } = await import(pathToFileURL(path.join(root, 'server/src/safety.js')));
let failed = 0;
const report = (level, name, detail) => {
  if (level === 'fail') failed++;
  console.log(`${level.toUpperCase().padEnd(4)}  ${name}: ${detail}`);
};

for (const c of runChecks()) report(c.level, c.id, c.detail);

const free = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve(e.code));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(null)));
});
const port = serverPort();
const err = await free(port);
report(err ? 'fail' : 'pass', 'port', err ? `${port} is not free (${err}). Set GATEWAY_INSPECTOR_PORT in .env to a free port in ${PORT_MIN}-${PORT_MAX}` : `${port} is free`);
const busy = [];
for (let p = STUB_BASE_PORT; p < STUB_BASE_PORT + 3; p++) if (await free(p)) busy.push(p);
report(busy.length ? 'fail' : 'pass', 'stub-ports', busy.length ? `in use: ${busy.join(', ')} (the stub upstreams need ${STUB_BASE_PORT}-${STUB_BASE_PORT + 2})` : `${STUB_BASE_PORT}-${STUB_BASE_PORT + 2} are free`);

process.exit(failed ? 1 : 0);
