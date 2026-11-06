// Thin fetch wrapper. Same origin only. No credentials, no cookies, no custom auth headers: the server refuses them.
// A POST body is JSON, the only body type the server accepts.

async function call(path, method = "GET", body) {
  const init = { method, headers: { Accept: "application/json" }, credentials: "omit" };
  if (body !== undefined) { init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

export const getInfo = () => call("/api/info");
export const getMode = () => call("/api/info");
export const postMode = (source) => call("/api/mode", "POST", { source });
export const getHealth = () => call("/api/health");
export const getDiagram = (name) => call(`/api/diagrams/${encodeURIComponent(name)}`);
export const getScenarios = () => call("/api/scenarios");
export const runScenario = (id, hold = false) => call(`/api/scenarios/${encodeURIComponent(id)}/run`, "POST", { hold });
export const getCalls = () => call("/api/calls?limit=200");
export const getCall = (id) => call(`/api/calls/${encodeURIComponent(id)}`);
export const decide = (id, decision, approvalCode) => call(`/api/calls/${encodeURIComponent(id)}/decision`, "POST", { decision, approvalCode });
export const retryCall = (id) => call(`/api/calls/${encodeURIComponent(id)}/retry`, "POST");
export const getAudit = () => call("/api/audit?limit=500");
export const verifyAudit = () => call("/api/audit/verify");
export const postReset = () => call("/api/reset", "POST");
