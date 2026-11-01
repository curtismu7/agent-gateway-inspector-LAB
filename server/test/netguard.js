// Test helper: blocks every non-loopback socket, DNS lookup and fetch, and records the attempts.
// Loopback (the tests' own server) and in-memory transports are allowed.
import dns from 'node:dns';
import net from 'node:net';
import { isLoopbackHost } from '../src/safety.js';

export function guardNetwork() {
  const attempts = [];
  const realConnect = net.Socket.prototype.connect;
  const realLookup = dns.lookup;
  const realFetch = globalThis.fetch;

  const hostOf = (args) => {
    // net normalises some calls to [options, cb]; unwrap so that form cannot slip past the guard
    const a = Array.isArray(args[0]) && args[0][0] && typeof args[0][0] === 'object' ? args[0][0] : args[0];
    if (a && typeof a === 'object' && !Array.isArray(a)) return a.path ? 'unix-socket' : (a.host || 'localhost');
    if (typeof a === 'string' && Number.isNaN(Number(a))) return 'unix-socket';
    return typeof args[1] === 'string' ? args[1] : 'localhost';
  };
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const host = hostOf(args);
    if (!isLoopbackHost(host)) { attempts.push(`socket:${host}`); throw new Error(`network blocked: ${host}`); }
    return realConnect.apply(this, args);
  };
  dns.lookup = function guardedLookup(host, ...rest) {
    if (!isLoopbackHost(host)) {
      attempts.push(`dns:${host}`);
      const cb = rest.find((r) => typeof r === 'function');
      return cb?.(new Error(`network blocked: ${host}`));
    }
    return realLookup.call(dns, host, ...rest);
  };
  globalThis.fetch = async function guardedFetch(input, init) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!isLoopbackHost(url.hostname)) { attempts.push(`fetch:${url.hostname}`); throw new Error(`network blocked: ${url.hostname}`); }
    return realFetch(input, init);
  };
  return {
    attempts,
    restore() { net.Socket.prototype.connect = realConnect; dns.lookup = realLookup; globalThis.fetch = realFetch; },
  };
}
