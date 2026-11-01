// Shared by gateway tests: a fake clock and a fake upstream (no sockets), so these tests need no ports.
export function fakeClock(start = Date.parse('2026-10-21T12:00:00Z')) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

export function fakeForward({ result = { fake: true }, fail = false } = {}) {
  const sent = [];
  return {
    sent,
    portFor: (name) => ({ tickets: 5851, payments: 5852, files: 5853 })[name],
    call: async ({ port, tool, args }) => { sent.push({ port, tool, args }); return fail ? { ok: false, error: 'upstream_unreachable' } : { ok: true, result }; },
  };
}
