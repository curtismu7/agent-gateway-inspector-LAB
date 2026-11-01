// The stub upstreams keep a hit log for tests. It must stay bounded: a long-lived process that forwards
// thousands of calls must not grow without limit. The upstream test slice is 5865-5867 (see helpers.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { startUpstreams } from '../src/upstreams.js';
import { freeBase, request } from './helpers.js';

test('the upstream hit log keeps only the newest 200 hits, however many calls are forwarded', async (t) => {
  const base = await freeBase('upstreams', 3);
  const up = await startUpstreams({ basePort: base });
  t.after(() => up.close());
  const body = { tool: 'tickets.read', args: { ticketId: 'T-100' } };
  for (let i = 0; i < 250; i += 1) assert.equal((await request(base, 'POST', '/tools/call', { body })).status, 200);
  assert.equal(up.hits.length, 200, 'capped at 200, not 250');
  assert.deepEqual(up.hits.at(-1), { upstream: 'tickets', tool: 'tickets.read' });
});
