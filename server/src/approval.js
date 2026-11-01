// What an approval is bound to: a hash of the exact call (agent, tool, token and every argument). Lab reading of the
// console swagger's FieldHash; the swagger gives the name, not the algorithm. Hashing is over a canonical form (keys sorted,
// no whitespace) so the same call always gives the same hash and any change to any argument gives another.
import crypto from 'node:crypto';

const MAX_DEPTH = 64;
const byKey = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// Keys are only ever read through Object.entries, never indexed, so a key such as __proto__ is just a string here.
export function canonical(v, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error('arguments are nested too deeply to bind an approval to');
  if (Array.isArray(v)) return `[${v.map((x) => canonical(x, depth + 1)).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).sort(byKey).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x, depth + 1)}`).join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

export const callHash = ({ agentId, tool, tokenId, args }) => crypto.createHash('sha256').update(canonical([agentId, tool, tokenId, args])).digest('hex');

// An approval reference looks like this and nothing else is looked up.
export const HOLD_REF_RE = /^hold-[0-9a-f]{16}$/;
export const newHoldRef = () => `hold-${crypto.randomBytes(8).toString('hex')}`;
