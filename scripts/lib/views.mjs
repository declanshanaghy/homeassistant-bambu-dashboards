// Loading, validation, entity extraction and merging of the repo's view files.
import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse } from 'yaml';

export const ROOT = new URL('../../', import.meta.url).pathname;
export const VIEWS_DIR = join(ROOT, 'views');
export const HELPERS_DIR = join(ROOT, 'helpers');

// Placement keys: used by deploy, never saved to HA.
export const PLACEMENT_KEYS = ['after', 'replaces'];
// Keys that exist only in the live config (user IDs) and must never be in git.
export const LIVE_ONLY_KEYS = ['visible'];

function loadDir(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /\.ya?ml$/.test(n))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      const stem = basename(name).replace(/\.ya?ml$/, '');
      try {
        return { file, stem, data: parse(readFileSync(file, 'utf8')) };
      } catch (err) {
        return { file, stem, error: `YAML parse error: ${err.message}` };
      }
    });
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const rel = (file) => file.slice(ROOT.length);

// Structural checks that need no HA connection. Returns { views, helpers, errors }.
export function loadAndValidate({ only } = {}) {
  const errors = [];
  const views = [];
  const helpers = [];

  for (const v of loadDir(VIEWS_DIR)) {
    const where = rel(v.file);
    if (v.error) {
      errors.push(`${where}: ${v.error}`);
      continue;
    }
    const d = v.data;
    if (!isObj(d)) {
      errors.push(`${where}: top level must be a mapping (one view)`);
      continue;
    }
    if (d.path !== v.stem) errors.push(`${where}: "path" must equal the file name (${v.stem})`);
    if (typeof d.title !== 'string' || !d.title) errors.push(`${where}: "title" is required`);
    for (const k of LIVE_ONLY_KEYS)
      if (k in d) errors.push(`${where}: "${k}" is live-only (HA user IDs); remove it, deploy keeps the live value`);
    for (const k of PLACEMENT_KEYS)
      if (k in d && (typeof d[k] !== 'string' || !d[k])) errors.push(`${where}: "${k}" must be a view path`);
    if (d.after && d.after === d.path) errors.push(`${where}: "after" cannot be the view itself`);
    if (d.replaces && d.replaces === d.path) errors.push(`${where}: "replaces" cannot be the view itself`);
    if (d.type === 'sections') {
      if (!Array.isArray(d.sections)) errors.push(`${where}: a sections view needs a "sections" list`);
    } else if (!Array.isArray(d.cards)) {
      errors.push(`${where}: needs a "cards" list (or type: sections with "sections")`);
    }
    if (d.sections !== undefined && !Array.isArray(d.sections)) errors.push(`${where}: "sections" must be a list`);
    if (d.cards !== undefined && !Array.isArray(d.cards)) errors.push(`${where}: "cards" must be a list`);
    const ip = JSON.stringify(d).match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    if (ip) errors.push(`${where}: contains an IP address (${ip[0]}); use hostnames or entities, the repo is public`);
    views.push({ file: v.file, view: d });
  }

  // Duplicate view paths (including a "replaces" target claimed twice).
  const seen = new Map();
  for (const { file, view } of views) {
    for (const p of [view.path, view.replaces].filter(Boolean)) {
      if (seen.has(p)) errors.push(`duplicate view path "${p}" in ${rel(seen.get(p))} and ${rel(file)}`);
      else seen.set(p, file);
    }
  }

  for (const h of loadDir(HELPERS_DIR)) {
    const where = rel(h.file);
    if (h.error) {
      errors.push(`${where}: ${h.error}`);
      continue;
    }
    const d = h.data;
    if (!isObj(d)) {
      errors.push(`${where}: top level must be a mapping (one helper)`);
      continue;
    }
    if (d.entity_id !== h.stem) errors.push(`${where}: "entity_id" must equal the file name (${h.stem})`);
    if (!ENTITY_RE.test(String(d.entity_id))) errors.push(`${where}: "entity_id" is not a valid entity ID`);
    helpers.push({ file: h.file, helper: d });
  }

  if (only && !views.some((v) => v.view.path === only))
    errors.push(`--only ${only}: no view file with that path`);

  return {
    views: only ? views.filter((v) => v.view.path === only) : views,
    allViews: views,
    helpers,
    errors,
  };
}

// --- entity references -------------------------------------------------------

const DOMAINS = [
  'ai_task', 'air_quality', 'alarm_control_panel', 'alert', 'assist_satellite', 'automation',
  'binary_sensor', 'button', 'calendar', 'camera', 'climate', 'conversation', 'counter', 'cover',
  'date', 'datetime', 'device_tracker', 'event', 'fan', 'group', 'humidifier', 'image',
  'image_processing', 'input_boolean', 'input_button', 'input_datetime', 'input_number',
  'input_select', 'input_text', 'lawn_mower', 'light', 'lock', 'media_player', 'notify', 'number',
  'person', 'plant', 'remote', 'scene', 'schedule', 'script', 'select', 'sensor', 'siren', 'stt',
  'sun', 'switch', 'text', 'time', 'timer', 'todo', 'tts', 'update', 'vacuum', 'valve',
  'wake_word', 'water_heater', 'weather', 'zone',
];
const D = DOMAINS.join('|');
export const ENTITY_RE = new RegExp(`^(?:${D})\\.[a-z0-9_]+$`);
// Inside templates: quoted IDs, states.domain.id, states['domain.id'].
const TEMPLATE_RE = new RegExp(`(?:['"]|\\bstates\\.)((?:${D})\\.[a-z0-9_]+)(?=['"]|\\b)`, 'g');
const IS_TEMPLATE = /\{\{|\{%|\[\[\[/;
// String values under these keys name services/actions (button.press), not entities.
const SERVICE_KEYS = new Set(['service', 'action', 'perform_action']);
// "image.png" etc. are file names, not entities.
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|js|css|json|ya?ml)$/;

// Returns [{ id, at }] where "at" is a readable location inside the view.
export function entityRefs(node, at = '') {
  const out = [];
  const walk = (v, loc, key) => {
    if (typeof v === 'string') {
      if (SERVICE_KEYS.has(key)) return;
      if (IS_TEMPLATE.test(v)) {
        for (const m of v.matchAll(TEMPLATE_RE)) if (!FILE_EXT.test(m[1])) out.push({ id: m[1], at: loc });
      } else if (ENTITY_RE.test(v) && !FILE_EXT.test(v)) {
        out.push({ id: v, at: loc });
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${loc}[${i}]`, key));
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) walk(x, loc ? `${loc}.${k}` : k, k);
    }
  };
  walk(node, at, '');
  return out;
}

// --- merging -----------------------------------------------------------------

// Canonical JSON (sorted keys) so key order never counts as a change.
export function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]));
  return v;
}
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function stripPlacement(view) {
  const out = { ...view };
  for (const k of PLACEMENT_KEYS) delete out[k];
  return out;
}

// Build the new Overview config. Returns { config, changes, errors } where each
// change is { path, kind: 'unchanged'|'changed'|'moved'|'replaced'|'inserted', before, after }.
export function merge(live, repoViews) {
  const errors = [];
  const views = [...(live.views ?? [])];
  const idx = (p) => views.findIndex((v) => v.path === p);
  const changes = [];
  const inserts = [];
  const livePrev = new Map((live.views ?? []).map((v, i, all) => [v.path, all[i - 1]?.path]));

  for (const view of repoViews) {
    const next = stripPlacement(view);
    let i = idx(view.path);
    let kind = 'changed';
    if (i >= 0 && view.replaces && idx(view.replaces) >= 0) {
      errors.push(`${view.path}: both "${view.path}" and the view it replaces ("${view.replaces}") are live; remove one in HA first`);
      continue;
    }
    if (i < 0 && view.replaces) {
      i = idx(view.replaces);
      kind = 'replaced';
      if (i < 0) {
        errors.push(`${view.path}: replaces "${view.replaces}", which is not a live view`);
        continue;
      }
    }
    if (i < 0) {
      inserts.push(next);
      continue;
    }
    const before = views[i];
    for (const k of LIVE_ONLY_KEYS) if (k in before) next[k] = before[k];
    views[i] = next;
    if (kind === 'changed' && same(before, next)) kind = 'unchanged';
    changes.push({ path: view.path, from: before.path, kind, before, after: next });
    // A live view with "after" is taken out and re-placed with the new ones below.
    if (view.after) {
      views.splice(i, 1);
      inserts.push(next);
    }
  }

  // Views with "after" go after that view (which may itself be new or moved);
  // new views without it go at the end.
  const afterOf = new Map(repoViews.map((v) => [v.path, v.after]));
  let queue = inserts;
  while (queue.length) {
    const rest = [];
    for (const next of queue) {
      const target = afterOf.get(next.path);
      if (!target) {
        views.push(next);
      } else if (idx(target) >= 0) {
        views.splice(idx(target) + 1, 0, next);
      } else {
        rest.push(next);
        continue;
      }
      if (!changes.some((c) => c.path === next.path))
        changes.push({ path: next.path, kind: 'inserted', before: null, after: next });
    }
    if (rest.length === queue.length) {
      for (const v of rest) errors.push(`${v.path}: "after: ${afterOf.get(v.path)}" is neither a live view nor deployed in this run`);
      break;
    }
    queue = rest;
  }

  // An otherwise unchanged view whose neighbour changed was moved: still save.
  for (const c of changes) {
    const i = idx(c.path);
    if (c.kind === 'unchanged' && i >= 0 && views[i - 1]?.path !== livePrev.get(c.from)) c.kind = 'moved';
  }

  const paths = views.map((v) => v.path).filter(Boolean);
  const dup = paths.find((p, i) => paths.indexOf(p) !== i);
  if (dup) errors.push(`resulting Overview would have duplicate view path "${dup}"`);

  return { config: { ...live, views }, changes, errors };
}
