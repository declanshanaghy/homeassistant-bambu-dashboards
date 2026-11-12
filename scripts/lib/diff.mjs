// Small line diff (LCS) with context, for readable dry-run output.
import { stringify } from 'yaml';
import { canonical } from './views.mjs';

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const red = (s) => paint(31, s);
export const green = (s) => paint(32, s);
export const cyan = (s) => paint(36, s);
export const bold = (s) => paint(1, s);

export const toYaml = (v) => (v == null ? '' : stringify(canonical(v), { lineWidth: 0 }));

export function lineDiff(a, b, context = 3) {
  const x = a ? a.split('\n') : [];
  const y = b ? b.split('\n') : [];
  const n = x.length;
  const m = y.length;
  // LCS table, row-major in a flat typed array.
  const t = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * (m + 1) + j] =
        x[i] === y[j] ? t[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(t[(i + 1) * (m + 1) + j], t[i * (m + 1) + j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push([' ', x[i++]]), j++;
    else if (j < m && (i >= n || t[i * (m + 1) + j + 1] >= t[(i + 1) * (m + 1) + j])) ops.push(['+', y[j++]]);
    else ops.push(['-', x[i++]]);
  }
  // Keep only changed lines plus context.
  const keep = ops.map(() => false);
  ops.forEach(([op], k) => {
    if (op !== ' ') for (let c = Math.max(0, k - context); c <= Math.min(ops.length - 1, k + context); c++) keep[c] = true;
  });
  const out = [];
  let skipped = false;
  ops.forEach(([op, line], k) => {
    if (!keep[k]) {
      skipped = true;
      return;
    }
    if (skipped) out.push(cyan('  ...'));
    skipped = false;
    out.push(op === '+' ? green(`+ ${line}`) : op === '-' ? red(`- ${line}`) : `  ${line}`);
  });
  return out.join('\n');
}
