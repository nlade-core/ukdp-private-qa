// Usage: node eval/run_ico.mjs
// Scores the page's enforcement answering (ico.js: intent parser + fixed query
// builder) against the answer key in cases_ico.json (derived independently by
// eval/derive_ico_truth.py). No model involved: figures come from rows.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { openDb } from '../retrieval.js';
import { enforcementIntent, runEnforcement, describeEnforcement } from '../ico.js';

const root = new URL('..', import.meta.url);
const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const db = await openDb(sqlite3, new Uint8Array(gunzipSync(readFileSync(new URL('data/ukdp.sqlite.gz', root)))));
const cases = JSON.parse(readFileSync(new URL('eval/cases_ico.json', root), 'utf8')).cases.filter((c) => c.kind === 'enforcement');
const f1 = (got, want) => {
  const g = new Set(got), w = new Set(want);
  const tp = [...g].filter((x) => w.has(x)).length;
  if (!g.size && !w.size) return 1;
  const p = g.size ? tp / g.size : 0, r = w.size ? tp / w.size : 0;
  return p + r ? 2 * p * r / (p + r) : 0;
};
const tally = { dev: [0, 0], 'held-out': [0, 0] };
for (const c of cases) {
  if (!c.truth) { console.log(c.id, 'no answer key yet'); continue; }
  const set = c.id % 2 ? 'dev' : 'held-out';
  const intent = enforcementIntent(c.q);
  const res = intent ? runEnforcement(db, intent) : null;
  let ok = false, detail = '';
  if (!res) detail = 'not recognised as an enforcement question';
  else if ('org' in c.truth) { const got = res.figure && res.figure.org; ok = got === c.truth.org; detail = got + ' vs ' + c.truth.org; }
  else if ('count' in c.truth) { ok = res.figure === c.truth.count; detail = res.figure + ' vs ' + c.truth.count; }
  else if ('total' in c.truth) { ok = res.figure === c.truth.total; detail = res.figure + ' vs ' + c.truth.total; }
  else if ('orgs' in c.truth) { const got = [...new Set(res.rows.map((r) => r.org))]; const s = f1(got, c.truth.orgs); ok = s >= 0.8; detail = 'F1 ' + s.toFixed(2) + ' (' + got.length + ' found, ' + c.truth.orgs.length + ' expected)'; }
  tally[set][0] += ok; tally[set][1]++;
  console.log(String(c.id).padStart(2), set === 'dev' ? 'dev ' : 'HOLD', ok ? '✓' : '✗', c.q.padEnd(72), '|', detail, '\n      ', res ? describeEnforcement(res) : '');
}
for (const [k, [a, n]] of Object.entries(tally)) console.log(k.padEnd(9), a + '/' + n);
