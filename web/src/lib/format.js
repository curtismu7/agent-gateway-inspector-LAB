export const shortHash = (h) => (h ? String(h).replace(/^sha256:/, "").slice(0, 12) : "none");
