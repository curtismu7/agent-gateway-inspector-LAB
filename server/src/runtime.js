// Builds what the API serves from: the stub upstreams on 127.0.0.1:5851-5853, the gateway, the audit trail.
// Always mock: the gateway is an in-process stub and the tool servers are stubs on loopback (live is refused, see config.js).
// State is in memory only: the gateway (call ring, pending pauses and their approval codes, rate windows), the audit trail and its
// HMAC key, and the scenario queue.
import { createGateway } from './gateway.js';
import { STUB_BASE_PORT } from './safety.js';
import { forwardTo, startUpstreams } from './upstreams.js';
import { runScenario } from './scenarios.js';

export async function createRuntime({ stubBase = STUB_BASE_PORT, now, sleep, upstreamTimeoutMs } = {}) {
  const upstreams = await startUpstreams({ basePort: stubBase });
  const gateway = createGateway({
    now,
    forward: {
      portFor: (name) => upstreams.ports.get(name),
      call: ({ port, tool, args }) => forwardTo({ port, allowedPorts: upstreams.allowedPorts, tool, args, ...(upstreamTimeoutMs ? { timeoutMs: upstreamTimeoutMs } : {}) }),
    },
  });
  let running = Promise.resolve();
  let pending = 0;
  return {
    mode: 'mock', gateway, upstreams,
    // Scenarios run one at a time; one may wait. A third request while one runs and one waits is refused (429).
    runScenario(id, opts) {
      if (pending >= 2) return Promise.reject(Object.assign(new Error('scenario queue full'), { code: 'scenario_queue_full' }));
      pending += 1;
      const run = running.then(() => runScenario(gateway, id, { ...opts, sleep }));
      running = run.catch(() => {}).then(() => { pending -= 1; });
      return run;
    },
    // The upstream hit log is test-only state; Reset clears it with the gateway.
    reset() { gateway.reset(); upstreams.reset(); },
    close: () => upstreams.close(),
  };
}
