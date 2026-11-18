// privilege-check/PrivilegeCheck.jsx — the family's one "through the Privilege gateway" card.
// Calls the lab's own POST /api/gateway-check (the shared gatewayReal.js hop server-side) and
// shows the live hop: door, caller, tool count and round-trip time, plus the gateway's own
// refusal shape for a tool no policy grants. The agent key is never displayed: the server
// scrubs every message. No dependency beyond React and the shared standalone-ui.css tokens.
import { useEffect, useState, useCallback } from 'react';
import './privilege-check.css';

const LAYER_LABEL = {
  key: 'the gateway refused the key (401)',
  policy: 'the gateway refused by policy (the key is not granted this tool — expected for the probe)',
  unreachable: 'the gateway was unreachable',
  unknown: 'the gateway does not know that tool',
  other: 'the gateway refused (see its own words below)',
};

export default function PrivilegeCheck({ apiBase = '', title = 'Privilege gateway' }) {
  const [state, setState] = useState({ phase: 'idle' });

  const refresh = useCallback(async () => {
    setState({ phase: 'checking' });
    try {
      const info = await fetch(`${apiBase}/api/info`, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((r) => r.json());
      if (!info.realAvailable) {
        setState({ phase: 'not-configured', reason: info.realReason || info.realHowTo || 'Real is not configured.' });
        return;
      }
      const res = await fetch(`${apiBase}/api/gateway-check`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setState({ phase: 'error', reason: err.message || err.realReason || err.fix || `the lab answered ${res.status}` });
        return;
      }
      const out = await res.json();
      setState({ phase: 'done', ...out });
    } catch (e) {
      setState({ phase: 'error', reason: String(e?.message || e).slice(0, 200) });
    }
  }, [apiBase]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <section className="pcard" data-testid="privilege-check" aria-label={title}>
      <header className="pcard__head">
        <h3 className="pcard__title">{title}</h3>
        <button type="button" className="pcard__retry" onClick={refresh} disabled={state.phase === 'checking'}>
          {state.phase === 'checking' ? 'Checking…' : 'Run the gateway check'}
        </button>
      </header>

      {state.phase === 'checking' && <p className="pcard__note">Calling the live gateway door…</p>}

      {state.phase === 'not-configured' && (
        <p className="pcard__note pcard__note--honest">{state.reason}</p>
      )}

      {state.phase === 'error' && (
        <p className="pcard__note pcard__note--error" role="alert">{state.reason}</p>
      )}

      {state.phase === 'done' && (
        <>
          <dl className="pcard__facts">
            <div className="pcard__fact"><dt>Gateway</dt><dd className="pcard__mono">{state.gateway}</dd></div>
            <div className="pcard__fact"><dt>Door (Agentic App)</dt><dd className="pcard__mono">{state.app}</dd></div>
            <div className="pcard__fact"><dt>Caller (agent key)</dt><dd>{state.caller}</dd></div>
            {state.version && <div className="pcard__fact"><dt>Gateway build</dt><dd className="pcard__mono">{state.version}</dd></div>}
          </dl>

          {state.listing?.ok ? (
            <div className="pcard__listing">
              <p className="pcard__line">
                <strong>tools/list</strong> through the door: {state.listing.tools.length} tools in {state.listing.ms} ms
                {state.listing.serverInfo?.name ? <> — server <span className="pcard__mono">{state.listing.serverInfo.name}</span></> : null}
              </p>
              <ul className="pcard__tools">
                {state.listing.tools.slice(0, 5).map((t) => <li key={t.name} className="pcard__mono">{t.name}</li>)}
                {state.listing.tools.length > 5 && <li className="pcard__note">…and {state.listing.tools.length - 5} more</li>}
              </ul>
            </div>
          ) : (
            <div className="pcard__refusal">
              <p className="pcard__line"><strong>tools/list</strong> was refused by the gateway: {LAYER_LABEL[state.listing?.refusal?.layer] || state.listing?.refusal?.layer}</p>
              {state.listing?.refusal?.message && <pre className="pcard__raw">{state.listing.refusal.message}</pre>}
            </div>
          )}

          {state.refusal && (
            <div className="pcard__refusal">
              <p className="pcard__line">
                <strong>Refusal probe</strong> (a tool no policy grants):{' '}
                {state.refusal.ok
                  ? 'unexpectedly allowed — check the door policy'
                  : `${LAYER_LABEL[state.refusal.refusal?.layer] || state.refusal.refusal?.layer || 'refused'}${state.refusal.refusal?.status ? ` (HTTP ${state.refusal.refusal.status})` : ''}`}
              </p>
              {state.refusal.refusal?.message && <pre className="pcard__raw">{state.refusal.refusal.message}</pre>}
            </div>
          )}

          <p className="pcard__how">Real mode here = one live call through the PingOne Privilege gateway with an agent access key from the shared settings file. The key is write-only and never shown.</p>
        </>
      )}
    </section>
  );
}
