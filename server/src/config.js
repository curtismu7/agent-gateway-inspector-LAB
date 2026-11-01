// Mode configuration. GATEWAY_INSPECTOR_MODE is the DEFAULT mode the page opens in (mock or live). A bare MODE is NOT read: the
// shared settings file is read by every standalone app, and another app's MODE must not switch this one.
//
// This app has a Mock/Live toggle on every page, but LIVE IS REFUSED. Mock is the in-process stub gateway and the three stub tool
// servers on loopback. Live would be a real gateway, and there is none to talk to: the Ping release this app simulates (2026-11-02)
// is not on our tenant and the app has no client for a real gateway. Live therefore passes only when every guard below passes,
// and the last one cannot. Anything that is not mock or live is an error, never a silent fallback.
import { isLoopbackHost } from './safety.js';

export const MODES = Object.freeze(['mock', 'live']);
export const MODE_KEY = 'GATEWAY_INSPECTOR_MODE';

export function modeFrom(env = process.env) {
  const raw = env[MODE_KEY];
  const m = raw === undefined || raw === '' ? 'mock' : raw;
  if (!MODES.includes(m)) throw new Error(`${MODE_KEY}=${String(m).slice(0, 20).replace(/[^\x20-\x7e]/g, '?')} is not a mode: use mock or live`);
  return m;
}
export const modeOf = (v) => (typeof v === 'string' && MODES.includes(v) ? v : null);

// The guards live mode must pass. Each: { id, ok, detail }.
export function liveGuards(env = process.env) {
  const host = env.GATEWAY_INSPECTOR_BIND || '127.0.0.1';
  return [
    { id: 'owner-opt-in', ok: env[MODE_KEY] === 'live', detail: `${MODE_KEY}=live is set in the shared settings file or the environment` },
    { id: 'loopback-bind', ok: isLoopbackHost(host) || Boolean(env.GATEWAY_INSPECTOR_BIND), detail: 'the server is bound to loopback, or GATEWAY_INSPECTOR_BIND is set (the container does: it binds inside and is published on 127.0.0.1 only); any value of GATEWAY_INSPECTOR_BIND passes this guard, so it proves nothing about the address' },
    { id: 'live-gateway', ok: false, detail: 'a real gateway to talk to: none, because the release is not on our tenant and this app has no client for one' },
  ];
}
export const liveRefusal = (env = process.env) => {
  const failed = liveGuards(env).filter((g) => !g.ok);
  return failed.length ? { failed: failed.map((g) => g.id), needs: failed.map((g) => g.detail) } : null;
};
