// Finding the provision that answers a question. Runs unchanged in the
// browser and in Node (eval/run.mjs), so the evaluation measures exactly the
// code the page ships. The model is passed in (`pickModel`), never imported:
// Gemini Nano in the page, a local stand-in in the eval.
//
// The order is the one measured in chrome-chat (where a model choosing from
// section titles scored 45/45 and body-text word matches caused every miss):
//   1. an explicit citation ("article 6(1)(f)", "s.170")  -> direct lookup
//   1b. a definition question                             -> the "‘term’ means" row
//   2. a strong title match                               -> trusted instantly
//   3. at send, the model picks from the top candidates   -> by number
//   4. otherwise                                          -> top full-text rank
// The code writes every SQL query; the model only ever returns a number.

export const MAX_CONTEXT_CHARS = 3000;
const CANDIDATES = 25;
const STOPWORDS = new Set(('the and for are was were who what when where which why how did does with from about that this its into than tell more much many have has had been will would could should there their them they his her him she you your our not any all some can '
  + 'must need needs do we us our may might is be a an of in on to it as at by or if so up out me my i am what\'s whats law legal rules rule allowed allow say says said').split(' '));

export async function openDb(sqlite3, bytes) {
  const p = sqlite3.wasm.allocFromTypedArray(bytes);
  const db = new sqlite3.oo1.DB();
  const { capi } = sqlite3;
  db.checkRc(capi.sqlite3_deserialize(db.pointer, 'main', p, bytes.byteLength, bytes.byteLength,
    capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE));
  return db;
}

export function queryTerms(question) {
  const words = question.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return [...new Set(words)].filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// "article 6(1)(f)" / "art 17" / "section 170" / "s.64" / "schedule 1 para 6"
// -> the ref strings used in the database, most specific first.
export function explicitRefs(question) {
  const q = question.replace(/\s+/g, ' ');
  const out = [];
  let m;
  const art = /\b(?:article|art)\.?\s*(\d+[A-Z]{0,3})((?:\s*\(\w+\))*)/gi;
  while ((m = art.exec(q))) out.push('UK GDPR Art. ' + m[1].toUpperCase() + m[2].replace(/\s+/g, ''));
  const sec = /\b(?:section|s)\.?\s*(\d+[A-Z]{0,2})((?:\s*\(\w+\))*)/gi;
  while ((m = sec.exec(q))) if (!/^\d{4}$/.test(m[1])) out.push('DPA 2018 s. ' + m[1].toUpperCase() + m[2].replace(/\s+/g, ''));
  const sch = /\bschedule\s*(\d+)(?:,?\s*(?:para(?:graph)?|para\.)\s*(\d+))?/gi;
  while ((m = sch.exec(q))) out.push('DPA 2018 Sch. ' + m[1] + (m[2] ? ' para. ' + m[2] : ''));
  return out;
}

// `bridge(question)` (optional) returns law refs that plain-English sources
// point at -- ICO guidance matching "fix mistakes in my details" cites
// Article 16, which the law's own wording ("rectification") never matches.
// Those provisions join the candidates the model chooses from.
export function createRetriever(db, { pickModel = null, bridge = null } = {}) {
  const rowCols = 'p.id, p.act, p.ref, p.title, p.path, p.text, p.url, p.scope';

  // The most specific existing text for a cited ref. "Art. 6(1)(f)" may only
  // exist as "Art. 6(1)" (the paragraph holds its points). A long article is
  // stored split into its paragraphs, so "Article 17" is reassembled from
  // "Art. 17(1)", "Art. 17(2)"… -- someone citing a whole article wants all
  // of it (the page shows it in full; the model gets the first ~3,000 chars).
  function lookupRef(ref) {
    let r = ref;
    for (;;) {
      const exact = db.selectObject('SELECT ' + rowCols + ' FROM provisions p WHERE p.ref = ?', [r]);
      if (exact) return exact;
      const parts = db.selectObjects('SELECT ' + rowCols + ' FROM provisions p WHERE p.ref LIKE ? ORDER BY p.id', [r + '(%']);
      if (parts.length) {
        return { ...parts[0], ref: r, text: parts.map((x) => x.text).join('\n'), url: parts[0].url.replace(/\/[^/]+$/, ''), parts: parts.length };
      }
      const shorter = r.replace(/\([^()]*\)$/, '');
      if (shorter === r) return null;
      r = shorter;
    }
  }

  // Regimes most questions are NOT about: DPA Parts 3/4 re-use UK GDPR
  // headings but apply only to police and the intelligence services, and
  // Schedules 19-21 amend other Acts or are transitional. They stay
  // reachable -- a question that mentions them, or cites them, gets them --
  // but otherwise rank after everything general.
  function scopeRank(row, question) {
    const q = question.toLowerCase();
    if (row.scope === 'law-enforcement') return /\b(police|law enforcement|competent authorit|crime|criminal investigation|prosecut)/.test(q) ? 0 : 1;
    if (row.scope === 'intelligence') return /\b(intelligence|security service|mi5|mi6|gchq|national security)/.test(q) ? 0 : 1;
    if (row.scope === 'amendments' || row.scope === 'transitional') return /\b(transitional|amend|commencement)/.test(q) ? 0 : 2;
    return 0;
  }
  function fts(terms, question = '', limit = CANDIDATES) {
    if (!terms.length) return [];
    const match = terms.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
    const rows = db.selectObjects('SELECT ' + rowCols + ', bm25(provisions_fts, 10.0, 3.0, 1.0) AS score FROM provisions_fts JOIN provisions p ON p.id = provisions_fts.rowid WHERE provisions_fts MATCH ? ORDER BY score LIMIT ?', [match, limit * 4]);
    return rows.map((r, i) => ({ r, i, k: scopeRank(r, question) })).filter((x) => x.k < 2)
      .sort((a, b) => a.k - b.k || a.i - b.i).slice(0, limit).map((x) => x.r);
  }

  // Legislation defines terms in one fixed form: ‘personal data’ means …
  // A definition question can't rely on full-text rank -- "personal data"
  // is in almost every row -- so look for that form directly, trying runs of
  // the question's words longest first ("personal data" before "data").
  const DEFINITION_Q = /\b(definition|defined|define|meaning|means)\b/i;
  function definitionRow(question) {
    if (!DEFINITION_Q.test(question)) return null;
    const toks = question.toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter(Boolean);
    const edge = (w) => STOPWORDS.has(w) || DEFINITION_Q.test(w);
    for (let n = Math.min(4, toks.length); n >= 1; n--) {
      for (let i = 0; i + n <= toks.length; i++) {
        const span = toks.slice(i, i + n);
        if (edge(span[0]) || edge(span[n - 1])) continue;
        const phrase = span.join(' ');
        const row = db.selectObject('SELECT ' + rowCols + ' FROM provisions p WHERE p.scope = \'general\' AND (p.text LIKE ? OR p.text LIKE ?) ORDER BY p.act = \'uk-gdpr\' DESC, p.id LIMIT 1',
          ['%‘' + phrase + '’ means%', "%'" + phrase + "' means%"]);
        if (row) return row;
      }
    }
    return null;
  }

  // Strong = the top candidate's title contains the question's key terms
  // (stems compared loosely: "breach" ~ "breaches"). Only a heading match is
  // trusted without the model -- body-text matches were the error source.
  function titleStrength(row, terms) {
    const title = row.title.toLowerCase();
    const hits = terms.filter((t) => title.includes(t.length > 5 ? t.slice(0, -2) : t)).length;
    return hits / Math.max(1, terms.length);
  }

  return {
    lookupRef,
    fts,
    async search(question, { atSend = false } = {}) {
      const t0 = performance.now();
      const done = (stage, pick, candidates) => ({ stage, pick, candidates, ms: Math.round(performance.now() - t0) });

      for (const ref of explicitRefs(question)) {
        const row = lookupRef(ref);
        if (row) return done('reference', row, [row]);
      }
      const def = definitionRow(question);
      if (def) return done('definition', def, [def, ...fts(queryTerms(question), question).filter((r) => r.id !== def.id)]);
      const terms = queryTerms(question);
      const ranked = fts(terms, question);
      if (ranked.length && titleStrength(ranked[0], terms) >= 0.5) return done('title', ranked[0], ranked);
      const bridged = bridge ? bridge(question).map(lookupRef).filter(Boolean).map((r) => ({ ...r, bridged: true })) : [];
      const seen = new Set();
      const candidates = [...bridged, ...ranked].filter((r) => !seen.has(r.ref) && seen.add(r.ref)).slice(0, CANDIDATES);
      if (!candidates.length) return done('none', null, []);
      if (atSend && pickModel) {
        const i = await pickModel(question, candidates).catch(() => null);
        if (Number.isInteger(i) && i >= 0 && i < candidates.length) return done('model', candidates[i], candidates);
      }
      return done('rank', ranked[0] || candidates[0], candidates);
    },
  };
}

// The prompt the model sees to choose a provision: references and titles
// only, numbered; it answers with one number (0 = none).
export const PICK_SYSTEM_PROMPT = 'You choose which provision of UK data protection law (UK GDPR or the Data Protection Act 2018) most directly answers a question. Reply only with its number, or 0 if none of them is likely to help.';
// Split rows share their provision's title (every Art. 4 definition is just
// "Definitions"), so where titles repeat, the line also carries the start of
// the text -- "'personal data' means…" vs "'personal data breach' means…".
export function snippet(row, len = 90) {
  const lines = row.text.split('\n').map((l) => l.trim()).filter(Boolean);
  const first = lines.find((l, i) => !(i === 0 && l.endsWith(':') && lines.length > 1)) || '';
  return first.replace(/^\([^)]*\)\s*/, '').slice(0, len);
}
export function pickPrompt(question, candidates) {
  const seen = {};
  for (const c of candidates) seen[c.title] = (seen[c.title] || 0) + 1;
  return 'Question: ' + question + '\nProvisions:\n' + candidates.map((c, k) => (k + 1) + '. ' + c.ref + ' — ' + c.title
    + (seen[c.title] > 1 ? ': "' + snippet(c) + '…"' : '') + (c.path ? ' [' + c.path + ']' : '')).join('\n');
}
// Accepts {"n": 6}, a bare 6 or "6." -- a schema-constrained reply can come
// back as a bare number (found in chrome-chat). Returns a 0-based index or null.
export function parsePick(raw, count) {
  let n = NaN;
  try { const v = JSON.parse(raw); n = typeof v === 'number' ? v : v && (v.n ?? v.section); } catch {}
  if (!Number.isInteger(n)) n = parseInt((/\d+/.exec(String(raw)) || [])[0], 10);
  return n >= 1 && n <= count ? n - 1 : null;
}

export function cutAtBoundary(text, max = MAX_CONTEXT_CHARS) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const para = head.lastIndexOf('\n');
  const sentence = head.lastIndexOf('. ');
  const cut = para > max * 0.7 ? para : sentence > max * 0.7 ? sentence + 1 : max;
  return head.slice(0, cut).trim() + '\n[…]';
}
