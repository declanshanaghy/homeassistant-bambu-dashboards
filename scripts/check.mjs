#!/usr/bin/env node
// Validate the view and helper files; online, also verify every referenced
// entity exists in HA and that the views merge cleanly into the live Overview.
//   node scripts/check.mjs [--offline] [--only <path>]
import { pathToFileURL } from 'node:url';
import { loadAndValidate, entityRefs, merge, ROOT } from './lib/views.mjs';
import { connect, getOverview, getStates } from './lib/ha.mjs';
import { red, green, bold } from './lib/diff.mjs';

export async function runCheck({ offline = false, only, ha } = {}) {
  const { views, allViews, helpers, errors } = loadAndValidate({ only });
  const refs = [];
  for (const { file, view } of views)
    for (const r of entityRefs(view)) refs.push({ ...r, where: file.slice(ROOT.length) });
  for (const { file, helper } of helpers) {
    const where = file.slice(ROOT.length);
    refs.push({ id: helper.entity_id, at: 'entity_id', where });
    for (const [k, v] of Object.entries(helper))
      if (k !== 'entity_id') for (const r of entityRefs(v, k)) refs.push({ ...r, where });
  }

  console.log(
    `${views.length} view file(s), ${helpers.length} helper file(s), ` +
      `${new Set(refs.map((r) => r.id)).size} distinct entity reference(s)`,
  );

  if (!offline && errors.length === 0) {
    const own = !ha;
    ha ??= await connect();
    try {
      const [states, live] = await Promise.all([getStates(ha), getOverview(ha)]);
      const known = new Set(states.map((s) => s.entity_id));
      // One line per missing entity per file: first location plus a count.
      const missing = new Map();
      for (const r of refs) {
        if (known.has(r.id)) continue;
        const key = `${r.where}\0${r.id}`;
        if (missing.has(key)) missing.get(key).n++;
        else missing.set(key, { ...r, n: 1 });
      }
      for (const r of missing.values())
        errors.push(`${r.where}: missing entity ${r.id} (at ${r.at || 'top'}${r.n > 1 ? `, +${r.n - 1} more` : ''})`);
      // Same merge the deploy does: catches bad after/replaces targets and duplicate paths.
      errors.push(...merge(live, allViews.map((v) => v.view)).errors);
    } finally {
      if (own) ha.close();
    }
  }

  for (const e of errors) console.error(red(`✗ ${e}`));
  if (errors.length) console.error(red(bold(`check failed: ${errors.length} problem(s)`)));
  else console.log(green(offline ? '✓ offline check passed (structure only)' : '✓ check passed'));
  return errors.length === 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--only');
  const ok = await runCheck({ offline: args.includes('--offline'), only: oi >= 0 ? args[oi + 1] : undefined }).catch(
    (err) => {
      console.error(red(`✗ ${err.message}`));
      return false;
    },
  );
  process.exit(ok ? 0 : 1);
}
