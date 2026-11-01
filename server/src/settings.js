// The one shared settings file (rulebook): ~/Development/.env, or the path in STANDALONE_ENV. Every standalone app reads it, so it
// holds other apps' keys too. This app takes ONLY the key listed below and ignores everything else: nothing else from the file
// ever enters the server's environment, and no value is printed. Read only; the app never writes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

export const SETTINGS_KEYS = ['GATEWAY_INSPECTOR_MODE'];
export const settingsPath = (env = process.env) => env.STANDALONE_ENV || path.join(os.homedir(), 'Development', '.env');

export function readSharedSettings(file) {
  try {
    const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
    return Object.fromEntries(SETTINGS_KEYS.filter((k) => typeof parsed[k] === 'string' && parsed[k] !== '').map((k) => [k, parsed[k]]));
  } catch { return {}; } // no file, or not readable: the defaults
}

// Fills only the listed keys, and only when the environment does not already set them.
export function applySharedSettings(env = process.env, file = settingsPath(env)) {
  for (const [k, v] of Object.entries(readSharedSettings(file))) if (env[k] === undefined) env[k] = v;
  return env;
}
