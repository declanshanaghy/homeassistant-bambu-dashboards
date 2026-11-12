#!/usr/bin/env node
// Deploy the repo's views into the live Overview dashboard.
//   node scripts/deploy.mjs [--dry-run] [--only <path>]
// Runs the full check first, backs up the live config, replaces only the
// views this repo manages, saves, then verifies nothing else changed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCheck } from './check.mjs';
import { loadAndValidate, merge, same, ROOT, LIVE_ONLY_KEYS } from './lib/views.mjs';
import { connect, getOverview, saveOverview } from './lib/ha.mjs';
import { lineDiff, toYaml, red, green, bold, cyan } from './lib/diff.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const oi = args.indexOf('--only');
const only = oi >= 0 ? args[oi + 1] : undefined;
if (oi >= 0 && !only) fail('--only needs a view path');

// Keep HA user IDs out of terminal output (and anything it gets pasted into).
function masked(view) {
  if (!view) return view;
  const out = { ...view };
  for (const k of LIVE_ONLY_KEYS) if (k in out) out[k] = '(kept from live)';
  return out;
}

function fail(msg) {
  console.error(red(`✗ ${msg}`));
  process.exit(1);
}

const ha = await connect().catch((err) => fail(err.message));
try {
  // A failed check aborts a real deploy; a dry run still shows the diff, then fails.
  const checked = await runCheck({ ha });
  if (!checked && !dryRun) fail('deploy aborted: check failed');

  const { views } = loadAndValidate({ only });
  if (!views.length) fail('no view files to deploy');

  const live = await getOverview(ha);
  const { config, changes, errors } = merge(live, views.map((v) => v.view));
  if (errors.length) fail(errors.join('\n  '));

  console.log(bold(`\nOverview: ${changes.length} managed view(s)${dryRun ? ' (dry run)' : ''}`));
  for (const c of changes) {
    const label = c.kind === 'replaced' ? `replaced (was ${c.from})` : c.kind;
    console.log(`\n${bold(c.path)}: ${c.kind === 'unchanged' ? green(label) : cyan(label)}`);
    if (c.kind !== 'unchanged') console.log(lineDiff(toYaml(masked(c.before)), toYaml(masked(c.after))));
  }
  console.log(`\nView order: ${config.views.map((v) => v.path ?? '(no path)').join(', ')}`);

  if (changes.every((c) => c.kind === 'unchanged')) {
    console.log(green('\n✓ no change; nothing to save'));
  } else if (dryRun) {
    console.log(cyan('\ndry run: nothing saved'));
  }
  if (!checked) fail('dry run complete, but check failed (see above)');
  if (!dryRun && changes.some((c) => c.kind !== 'unchanged')) {
    const dir = join(ROOT, 'backups');
    mkdirSync(dir, { recursive: true });
    const backup = join(dir, `overview-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    writeFileSync(backup, JSON.stringify(live, null, 2) + '\n');
    console.log(`\nbackup: ${backup.slice(ROOT.length)}`);

    // Refuse to save if someone edited the dashboard since we read it.
    if (!same(await getOverview(ha), live)) fail('the live Overview changed while deploying; re-run');
    await saveOverview(ha, config);

    // Verify: managed views are what we sent; everything else matches the backup.
    const after = await getOverview(ha);
    const managed = new Set(changes.flatMap((c) => [c.path, c.from]).filter(Boolean));
    const problems = [];
    const strip = (cfg) => ({ ...cfg, views: cfg.views.filter((v) => !managed.has(v.path)) });
    if (!same(strip(after), strip(live))) problems.push('unmanaged views or dashboard settings differ from the backup');
    for (const c of changes) {
      const got = after.views.find((v) => v.path === c.path);
      if (!same(got, c.after)) problems.push(`view ${c.path} does not match what was saved`);
    }
    if (problems.length) fail(`verification failed (restore from ${backup.slice(ROOT.length)}):\n  ${problems.join('\n  ')}`);
    console.log(green('✓ saved and verified: unmanaged views identical to the backup'));
  }
} finally {
  ha.close();
}
