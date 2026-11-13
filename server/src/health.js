// GET /api/health, contract demo-health/1 (see the demo shelf's docs/health-contract.md).
// Public, GET only, no extra fields. The state comes from the doctor checks, refreshed in the background every 60 s;
// a request never runs them. Family shared service (owner, 2026-11-13): vendor it, never edit a lab's copy.
// The lab passes demoId/demoName (its registry identity) and its own runChecks/allPassed (from shared/doctor or local).
import express from 'express';

export function createHealth({ demoId, demoName, version, runChecks, allPassed, mockOnly, now = () => new Date(), intervalMs = 60_000, env = process.env } = {}) {
  if (!demoId || !demoName) throw new Error('createHealth: demoId and demoName are required');
  if (!runChecks || !allPassed) throw new Error('createHealth: runChecks and allPassed are required');
  const DEMO = { id: demoId, name: demoName, version };
  let last = { state: 'unknown', at: null };
  function refresh() {
    try { last = { state: allPassed(runChecks()) ? 'ready' : 'broken', at: now().toISOString() }; }
    catch { last = { state: 'unknown', at: now().toISOString() }; }
  }
  refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref();

  const router = express.Router();
  router.get('/', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ schema: 'demo-health/1', at: last.at || now().toISOString(), state: last.state, runtime: 'offline', demo: DEMO, ...(mockOnly?.(env) ? { mode: 'mock-only' } : {}) });
  });
  router.all('/', (_req, res) => res.set('Allow', 'GET').status(405).json({ error: 'method_not_allowed' }));
  return { router, refresh, stop: () => clearInterval(timer) };
}
