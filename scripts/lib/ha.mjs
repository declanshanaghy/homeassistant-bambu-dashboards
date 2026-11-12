// Minimal Home Assistant WebSocket client (Node's built-in WebSocket, no deps).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Local settings (HA_TOKEN, HA_URL, HA_OP_REF) come from the environment or
// a gitignored `.env` (or `.env.local`), so account-specific values and the
// token never reach the repo. Keeping HA_TOKEN in `.env` avoids a 1Password
// prompt on every run; HA_OP_REF is only the fallback when it's absent.
// Use 1Password vault/item IDs in HA_OP_REF if a name contains "(", which
// `op` cannot parse in a secret reference.
for (const file of ['.env', '.env.local']) {
  try {
    for (const line of readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {}
}
const OP_REF = process.env.HA_OP_REF;
export const HA_URL = process.env.HA_URL ?? 'http://homeassistant.lan:8123';

// The token is read at runtime and kept in memory only.
function readToken() {
  if (process.env.HA_TOKEN) return process.env.HA_TOKEN.trim();
  if (!OP_REF) throw new Error('set HA_TOKEN, or HA_OP_REF (an op:// reference) in the environment or .env');
  try {
    return execFileSync('op', ['read', OP_REF], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = String(err.stderr || err.message).trim();
    throw new Error(`could not read the HA token (set HA_TOKEN or sign in to 1Password): ${msg}`);
  }
}

export async function connect() {
  const token = readToken();
  const wsUrl = HA_URL.replace(/^http/, 'ws').replace(/\/$/, '') + '/api/websocket';
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  let authed;
  const ready = new Promise((resolve, reject) => {
    authed = { resolve, reject };
  });

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    } else if (msg.type === 'auth_ok') {
      authed.resolve();
    } else if (msg.type === 'auth_invalid') {
      authed.reject(new Error(`HA rejected the token: ${msg.message}`));
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success) resolve(msg.result);
      else reject(new Error(`${msg.error?.code}: ${msg.error?.message}`));
    }
  });
  ws.addEventListener('error', () => authed.reject(new Error(`cannot connect to ${wsUrl}`)));
  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('websocket closed'));
    pending.clear();
  });

  await ready;

  return {
    call(type, payload = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, type, ...payload }));
      });
    },
    close() {
      ws.close();
    },
  };
}

// The printer tabs are views of the default Overview dashboard (url_path null).
export const getOverview = (ha) => ha.call('lovelace/config', { url_path: null, force: true });
export const saveOverview = (ha, config) =>
  ha.call('lovelace/config/save', { url_path: null, config });
export const getStates = (ha) => ha.call('get_states');
