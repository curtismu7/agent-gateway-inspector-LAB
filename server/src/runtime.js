// Builds what the API serves from: the stub upstreams on 127.0.0.1:5851-5853, the gateway, the audit trail.
// Always mock: the gateway is an in-process stub and the tool servers are stubs on loopback (live is refused, see config.js).
// State is in memory only: the gateway (call ring, pending pauses and their approval codes, rate windows), the audit trail and its
// HMAC key, and the scenario queue.
import { createGateway } from './gateway.js';
import { STUB_BASE_PORT } from './safety.js';
import { forwardTo, startUpstreams } from './upstreams.js';
import { createRunLog } from './runObs.js';
import { getScenario, runScenario } from './scenarios.js';

// log: where the one-line-per-row decision log goes. Silent by default (so tests stay quiet); the boot path in app.js passes the stdout writer.
export async function createRuntime({ stubBase = STUB_BASE_PORT, now, sleep, upstreamTimeoutMs, log } = {}) {
  const upstreams = await startUpstreams({ basePort: stubBase });
  const runLog = createRunLog({ write: log, clock: now });
  const gateway = createGateway({
    now, observe: runLog.observe,
    forward: {
      portFor: (name) => upstreams.ports.get(name),
      call: ({ port, tool, args }) => forwardTo({ port, allowedPorts: upstreams.allowedPorts, tool, args, ...(upstreamTimeoutMs ? { timeoutMs: upstreamTimeoutMs } : {}) }),
    },
  });
  let running = Promise.resolve();
  let pending = 0;
  return {
    mode: 'mock', gateway, upstreams, runLog,
    // Scenarios run one at a time; one may wait. A third request while one runs and one waits is refused (429).
    runScenario(id, opts) {
      if (pending >= 2) return Promise.reject(Object.assign(new Error('scenario queue full'), { code: 'scenario_queue_full' }));
      pending += 1;
      // A scenario is one run of the run record (rule 27): opened here, its calls join it, and it stays open while one of them waits for a human.
      const run = running.then(async () => {
        const runId = getScenario(id) ? runLog.begin() : null;
        try {
          const result = await runScenario(gateway, id, { ...opts, sleep, runId });
          return result && runId ? { ...result, runId } : result;
        } finally { runLog.executed(runId); }
      });
      running = run.catch(() => {}).then(() => { pending -= 1; });
      return run;
    },
    // The upstream hit log is test-only state; Reset clears it with the gateway.
    reset() { gateway.reset(); upstreams.reset(); runLog.reset(); },
    close: () => upstreams.close(),
  };
}
