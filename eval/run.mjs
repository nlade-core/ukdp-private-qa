// Usage: node eval/run.mjs [--model gemma4:e4b] [--runs 1] [--no-model] [--show-heldout]
//
// Scores retrieval.js on eval/cases.json with the same SQLite engine the page
// uses (vendor/sqlite-wasm/node.mjs) and a local Ollama model standing in for
// Gemini Nano (Nano's default sampling, temperature 1 / topK 3; hidden
// reasoning off, since Nano has none). Stand-ins are for fast iteration --
// calibrate against real Chrome before trusting a difference.
//
// Method: cases were written before any retrieval code existed. Odd ids are
// the dev set (tuning allowed, details printed); even ids are held out
// (only totals printed unless --show-heldout, and never tuned on).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import sqlite3InitModule from '../vendor/sqlite-wasm/node.mjs';
import { openDb, createRetriever, PICK_SYSTEM_PROMPT, pickPrompt, parsePick } from '../retrieval.js';
import { hasIco, bridgeRefs } from '../ico.js';

const arg = (name, dflt) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : dflt; };
const MODEL = arg('model', 'gemma4:e4b');
const RUNS = Number(arg('runs', 1));
const USE_MODEL = !process.argv.includes('--no-model');
const SHOW_HELDOUT = process.argv.includes('--show-heldout');
const USE_BRIDGE = !process.argv.includes('--no-bridge');
const OLLAMA = process.env.OLLAMA_HOST || 'http://localhost:11434';

let noThink = true;
async function ollamaChat(messages, format) {
  const body = { model: MODEL, messages, stream: false, ...(format ? { format } : {}), options: { temperature: 1, top_k: 3 } };
  let res = await fetch(OLLAMA + '/api/chat', { method: 'POST', body: JSON.stringify(noThink ? { ...body, think: false } : body) });
  if (!res.ok && noThink && /think/i.test(await res.clone().text())) { noThink = false; res = await fetch(OLLAMA + '/api/chat', { method: 'POST', body: JSON.stringify(body) }); }
  if (!res.ok) throw new Error('ollama HTTP ' + res.status);
  return (await res.json()).message.content;
}
async function pickModel(question, candidates) {
  const raw = await ollamaChat([{ role: 'system', content: PICK_SYSTEM_PROMPT }, { role: 'user', content: pickPrompt(question, candidates) }],
    { type: 'integer', minimum: 0, maximum: candidates.length });
  return parsePick(raw, candidates.length);
}

const root = new URL('..', import.meta.url);
const sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
const db = await openDb(sqlite3, new Uint8Array(gunzipSync(readFileSync(new URL('data/ukdp.sqlite.gz', root)))));
const bridge = USE_BRIDGE && hasIco(db) ? (q) => bridgeRefs(db, q) : null;
const retriever = createRetriever(db, { pickModel: USE_MODEL ? pickModel : null, bridge });
// Law questions from both files; enforcement questions (kind: enforcement) are scored by eval/run_ico.mjs.
const cases = [...JSON.parse(readFileSync(new URL('eval/cases.json', root), 'utf8')).cases,
  ...JSON.parse(readFileSync(new URL('eval/cases_ico.json', root), 'utf8')).cases.filter((c) => !c.kind)];

const matches = (ref, expect) => expect.some((e) => ref === e || ref.startsWith(e + '('));
const blank = () => ({ n: 0, at1: 0, at3: 0, ms: [], stages: {} });
const sets = { dev: blank(), 'held-out': blank(), 'plain dev': blank(), 'plain held': blank() };
console.log('model stand-in:', USE_MODEL ? MODEL : '(none)', '| guidance bridge:', bridge ? 'on' : 'off', '| runs per case:', RUNS, '\n');
for (const c of cases) {
  const set = c.id > 32 ? (c.id % 2 ? 'plain dev' : 'plain held') : (c.id % 2 ? 'dev' : 'held-out');
  for (let r = 0; r < RUNS; r++) {
    const res = await retriever.search(c.q, { atSend: true });
    const ranked = res.pick ? [res.pick, ...res.candidates.filter((x) => x.id !== res.pick.id)] : [];
    const at1 = !!res.pick && matches(res.pick.ref, c.expect);
    const at3 = ranked.slice(0, 3).some((x) => matches(x.ref, c.expect));
    const s = sets[set];
    s.n++; s.at1 += at1; s.at3 += at3; s.ms.push(res.ms); s.stages[res.stage] = (s.stages[res.stage] || 0) + 1;
    if (set === 'dev' || set === 'plain dev' || SHOW_HELDOUT) {
      console.log(String(c.id).padStart(2), set.includes('dev') ? 'dev ' : 'HOLD', at1 ? '✓' : at3 ? '~' : '✗', res.stage.padEnd(9),
        (res.pick ? res.pick.ref + ' — ' + res.pick.title : '-').slice(0, 58).padEnd(58), String(res.ms).padStart(5) + 'ms', '|', c.q.slice(0, 60), at1 ? '' : '  (want ' + c.expect.join(' / ') + ')');
    }
  }
}
console.log('');
for (const [name, s] of Object.entries(sets)) {
  if (!s.n) continue;
  const med = s.ms.slice().sort((a, b) => a - b)[Math.floor(s.ms.length / 2)];
  console.log(name.padEnd(10), 'hit@1', (s.at1 + '/' + s.n).padEnd(6), 'hit@3', (s.at3 + '/' + s.n).padEnd(6), 'median', med + 'ms', '| stages', JSON.stringify(s.stages));
}
