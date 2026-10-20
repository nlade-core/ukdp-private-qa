// The page: load the law once, then answer questions entirely on this device.
import sqlite3InitModule from './vendor/sqlite-wasm/index.mjs';
import { openDb, createRetriever, cutAtBoundary } from './retrieval.js';
import { modelStatus, pickModel, answer } from './model.js';
import { hasIco, bridgeRefs, guidanceFor, baseRef, enforcementIntent, runEnforcement, describeEnforcement, gbp } from './ico.js';

const $ = (id) => document.getElementById(id);
const DB_URL = 'data/ukdp.sqlite.gz';
const STAGE_LABEL = {
  reference: 'found by the reference you cited',
  definition: 'found as the legal definition',
  title: "found by the provision's heading",
  model: 'chosen by the on-device model from the closest matches (law, and the law ICO guidance points to)',
  rank: 'best full-text match',
};

let retriever = null;
let db = null;
let ico = false;
let modelOk = false;
let current = null; // { question, result }
let abort = null;

// The privacy claim, made visible: every network request the page makes
// after the law has loaded shows up here. Asking questions should leave it
// at zero -- the database and the model are both on this device.
function startRequestCounter() {
  let n = 0;
  const el = $('net-count');
  const render = () => { el.textContent = n === 0 ? '0 network requests since the law loaded' : n + ' network request' + (n === 1 ? '' : 's') + ' since the law loaded'; el.classList.toggle('warn', n > 0); };
  render();
  new PerformanceObserver((list) => { n += list.getEntries().length; render(); }).observe({ type: 'resource' });
}

async function loadLaw() {
  $('status').textContent = 'Loading the law (≈0.6 MB, once)…';
  const t0 = performance.now();
  const [sqlite3, res] = await Promise.all([sqlite3InitModule({ print: () => {}, printErr: () => {} }), fetch(DB_URL)]);
  if (!res.ok) throw new Error('could not load ' + DB_URL + ' (HTTP ' + res.status + ')');
  // Shipped gzipped and decompressed here with the browser's own decoder --
  // unless the host already sent it with Content-Encoding: gzip, in which
  // case the browser has decompressed it; the gzip magic bytes tell which.
  let bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  }
  const db = await openDb(sqlite3, bytes);
  const meta = Object.fromEntries(db.selectArrays('SELECT key, value FROM meta'));
  const rows = db.selectValue('SELECT count(*) FROM provisions');
  $('fetched').textContent = meta.fetched || '';
  return { db, rows, ms: Math.round(performance.now() - t0) };
}

function showProvision(row) {
  $('prov-ref').textContent = row.ref;
  $('prov-title').textContent = row.title;
  $('prov-path').textContent = row.path;
  $('prov-text').textContent = row.text;
  $('prov-link').href = row.url;
  $('provision').hidden = false;
}

// The ICO's plain-English guidance for this provision, if any cites it.
function showGuidance(question, provision) {
  const g = ico ? guidanceFor(db, provision.ref, question) : null;
  $('guidance').hidden = !g;
  $('g-review').hidden = !(g && g.under_review);
  if (!g) return null;
  $('g-title').textContent = g.title + (g.section ? ' › ' + g.section : '');
  $('g-text').textContent = g.text;
  $('g-link').href = g.url;
  $('g-review').hidden = !g.under_review;
  return g;
}

// ICO enforcement actions that cite this provision's article.
function showRelatedEnforcement(provision) {
  const box = $('related');
  if (!ico) { box.hidden = true; return; }
  const base = baseRef(provision.ref);
  const rows = db.selectObjects("SELECT DISTINCT e.org, e.date, e.type, e.amount_gbp, e.url FROM links l JOIN enforcement e ON e.id = l.src_id WHERE l.kind = 'enforcement' AND (l.ref = ? OR l.ref LIKE ?) ORDER BY e.amount_gbp IS NULL, e.amount_gbp DESC, e.date DESC LIMIT 5", [base, base + '(%']);
  box.hidden = !rows.length;
  const list = $('related-list');
  list.innerHTML = '';
  for (const r of rows) list.append(actionItem(r));
}

function actionItem(r) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = r.url; a.target = '_blank'; a.rel = 'noopener';
  a.textContent = r.org;
  li.append(a, ' — ' + r.date + ' · ' + r.type + (r.amount_gbp != null ? ' · ' + gbp(r.amount_gbp) : ''));
  return li;
}

function showOthers(result) {
  const list = $('others');
  list.innerHTML = '';
  const others = result.candidates.filter((c) => c.id !== result.pick.id).slice(0, 5);
  $('others-wrap').hidden = !others.length;
  for (const c of others) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = c.ref + ' — ' + c.title;
    btn.addEventListener('click', () => respond(current.question, { ...result, pick: c, stage: 'chosen' }));
    li.append(btn);
    list.append(li);
  }
}

async function respond(question, result) {
  current = { question, result };
  if (abort) abort.abort();
  abort = new AbortController();
  const pick = result.pick;
  showProvision(pick);
  showOthers(result);
  $('enforcement-wrap').hidden = true;
  const guidance = showGuidance(question, pick);
  showRelatedEnforcement(pick);
  $('cite').textContent = pick.ref;
  $('how').textContent = (result.stage === 'chosen' ? 'the provision you chose' : STAGE_LABEL[result.stage] || result.stage) + (result.ms != null ? ' · ' + result.ms + ' ms' : '');
  $('answer-wrap').hidden = false;
  const out = $('answer');
  if (!modelOk) {
    out.textContent = 'Search-only mode: this browser has no on-device model available, so here is the provision that best matches your question.';
    return;
  }
  out.textContent = '…';
  try {
    // Law first and authoritative; the guidance gets what's left of the budget.
    const law = cutAtBoundary(pick.text, guidance ? 1800 : 3000);
    await answer(question, { ...pick, text: law }, {
      guidance: guidance ? { ...guidance, text: cutAtBoundary(guidance.text, 3000 - law.length) } : null,
      signal: abort.signal,
      onChunk: (text) => { out.textContent = text; },
      onDownload: (f) => { out.textContent = 'Downloading the on-device model… ' + Math.round(f * 100) + '%'; },
    });
  } catch (e) {
    if (e.name !== 'AbortError') out.textContent = "Couldn't generate an answer (" + e.message + '). The provision is shown alongside.';
  }
}

// Enforcement questions ("largest fine in 2025", "how many reprimands") are
// answered by one fixed, parameterised query -- figures straight from rows,
// never generated -- with the query itself shown underneath.
function answerEnforcement(question, intent) {
  const res = runEnforcement(db, intent);
  $('answer-wrap').hidden = true;
  $('provision').hidden = true;
  $('enforcement-wrap').hidden = false;
  $('e-headline').textContent = describeEnforcement(res);
  const list = $('e-list');
  list.innerHTML = '';
  for (const r of res.rows.slice(0, 25)) list.append(actionItem(r));
  $('e-more').textContent = res.rows.length > 25 ? '…and ' + (res.rows.length - 25) + ' more.' : '';
  const chips = $('e-breached');
  chips.innerHTML = '';
  $('e-breached-wrap').hidden = !res.breached.length;
  for (const b of res.breached) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'example';
    btn.textContent = b.ref + ' (' + b.n + ')';
    btn.addEventListener('click', () => { $('q').value = 'What does ' + b.ref.replace('UK GDPR ', '').replace('DPA 2018 ', '') + ' say?'; ask($('q').value); });
    chips.append(btn);
  }
  $('e-sql').textContent = res.sql + '\n\nparameters: ' + JSON.stringify(res.params);
}

async function ask(question) {
  question = question.trim();
  if (!question || !retriever) return;
  const intent = ico ? enforcementIntent(question) : null;
  if (intent) { $('status').textContent = ''; answerEnforcement(question, intent); return; }
  $('ask-btn').disabled = true;
  $('status').textContent = 'Finding the provision…';
  try {
    const result = await retriever.search(question, { atSend: true });
    if (!result.pick) {
      $('status').textContent = 'Nothing in the UK GDPR or DPA 2018 matched that — try different words, or cite a provision (e.g. "Article 17").';
      return;
    }
    $('status').textContent = '';
    await respond(question, result);
  } finally {
    $('ask-btn').disabled = false;
  }
}

async function main() {
  try {
    const [law, status] = await Promise.all([loadLaw(), modelStatus()]);
    modelOk = status !== 'missing' && status !== 'unavailable';
    db = law.db;
    ico = hasIco(db);
    retriever = createRetriever(db, { pickModel: modelOk ? pickModel : null, bridge: ico ? (q) => bridgeRefs(db, q) : null });
    $('status').textContent = 'Loaded ' + law.rows.toLocaleString() + ' provisions in ' + law.ms + ' ms.';
    $('mode').textContent = modelOk
      ? (status === 'available' ? 'On-device model ready.' : 'On-device model will download on first question.')
      : 'Search-only mode: no on-device model in this browser (desktop Chrome has one).';
    startRequestCounter();
    $('ask-btn').disabled = false;
  } catch (e) {
    $('status').textContent = "Couldn't load: " + e.message;
    return;
  }
  $('ask').addEventListener('submit', (e) => { e.preventDefault(); ask($('q').value); });
  for (const b of document.querySelectorAll('.example')) b.addEventListener('click', () => { $('q').value = b.textContent; ask(b.textContent); });
}

main();
