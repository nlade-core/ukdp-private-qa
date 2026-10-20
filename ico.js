// ICO guidance and enforcement, joined to the law. Shared by the page and the
// eval, like retrieval.js. Every query is fixed code; enforcement figures come
// straight from rows (never from a model), each linked to its notice.
import { queryTerms } from './retrieval.js';

export function hasIco(db) {
  return !!db.selectValue("SELECT count(*) FROM sqlite_master WHERE name = 'guidance'");
}

// "UK GDPR Art. 16(1)" -> "UK GDPR Art. 16": links are compared at article /
// section / schedule-paragraph level, since guidance cites "Article 16" while
// the law row may be a paragraph of it.
export const baseRef = (ref) => ref.replace(/\(.*$/, '').trim();

function ftsMatch(terms) {
  return terms.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ');
}

// Guidance rows matching the question, best first.
export function searchGuidance(db, question, limit = 8) {
  const terms = queryTerms(question);
  if (!terms.length) return [];
  return db.selectObjects('SELECT g.id, g.title, g.section, g.text, g.url, g.topic, g.under_review, bm25(guidance_fts, 8.0, 4.0, 1.0) AS score FROM guidance_fts JOIN guidance g ON g.id = guidance_fts.rowid WHERE guidance_fts MATCH ? ORDER BY score LIMIT ?', [ftsMatch(terms), limit]);
}

// The bridge: plain-English guidance that matches the question points at the
// law it cites. Returns the cited refs, most-supported first -- a ref cited by
// several matching guidance rows, or by a higher-ranked one, comes first.
export function bridgeRefs(db, question, limit = 8) {
  const hits = searchGuidance(db, question, 12);
  const score = new Map();
  hits.forEach((g, rank) => {
    const refs = db.selectValues("SELECT DISTINCT ref FROM links WHERE kind = 'guidance' AND src_id = ?", [g.id]);
    for (const r of refs) {
      const b = baseRef(r);
      score.set(b, (score.get(b) || 0) + 1 / (rank + 1));
    }
  });
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([r]) => r);
}

// The guidance passage to show beside a law provision: rows linked to that
// provision's article, the one most relevant to the question first.
export function guidanceFor(db, provisionRef, question) {
  const base = baseRef(provisionRef);
  const ids = db.selectValues("SELECT DISTINCT src_id FROM links WHERE kind = 'guidance' AND (ref = ? OR ref LIKE ?)", [base, base + '(%']);
  if (!ids.length) return null;
  const terms = queryTerms(question);
  const placeholders = ids.map(() => '?').join(',');
  if (terms.length) {
    const ranked = db.selectObject('SELECT g.id, g.title, g.section, g.text, g.url, g.under_review FROM guidance_fts JOIN guidance g ON g.id = guidance_fts.rowid WHERE guidance_fts MATCH ? AND g.id IN (' + placeholders + ') ORDER BY bm25(guidance_fts, 8.0, 4.0, 1.0) LIMIT 1', [ftsMatch(terms), ...ids]);
    if (ranked) return ranked;
  }
  return db.selectObject('SELECT id, title, section, text, url, under_review FROM guidance WHERE id IN (' + placeholders + ') ORDER BY id LIMIT 1', ids);
}

// ---------------------------------------------------------------- enforcement

const ENFORCEMENT_Q = /\b(fines?|fined|penalt(?:y|ies)|reprimand(?:s|ed)?|enforcement notices?|prosecut\w*|action (?:against|taken)|sanction\w*|enforcement action)\b/i;
const INTENT_WORDS = new Set(('fine fines fined penalty penalties monetary reprimand reprimands reprimanded enforcement notice notices prosecution prosecutions prosecuted action actions against taken sanction sanctions ico largest biggest highest maximum total value sum much many number count which who what anyone anybody organisation organisations organization organizations company companies business businesses issued issue received receive given give data under uk gdpr dpa protection act law regulations pecr year years since during ever been has have any the').split(' '));

export function enforcementIntent(question) {
  if (!ENFORCEMENT_Q.test(question)) return null;
  const q = question.toLowerCase();
  const type = /reprimand/.test(q) ? 'Reprimands'
    : /enforcement notice/.test(q) ? 'Enforcement notices'
    : /prosecut/.test(q) ? 'Prosecutions'
    : /\b(fines?|fined|penalt)/.test(q) ? 'Monetary penalties' : null;
  const year = (/\b(20\d\d)\b/.exec(q) || [])[1];
  const regime = /\b(nuisance|cold[- ]call|marketing (?:calls?|texts?|emails?)|spam|pecr|electronic (?:marketing|communications)|unsolicited)\b/.test(q) ? 'PECR'
    : /\b(uk gdpr|gdpr|data protection act|dpa)\b/.test(q) ? 'UK GDPR' : null;
  const kind = /\b(largest|biggest|highest|maximum|record)\b/.test(q) ? 'largest'
    : /\b(total|sum|combined|altogether|in total)\b|how much/.test(q) ? 'total'
    : /\bhow many\b|\bnumber of\b|\bcount\b/.test(q) ? 'count' : 'list';
  const topic = queryTerms(question).filter((t) => !INTENT_WORDS.has(t) && !/^\d+$/.test(t));
  return { kind, type, year: year ? Number(year) : null, regime, topic };
}

// Runs the intent as one fixed, parameterised query. Returns the rows, the
// headline figure, and the exact SQL + parameters (shown in the page).
export function runEnforcement(db, intent) {
  const where = [], params = [];
  let from = 'enforcement e';
  if (intent.topic.length) {
    from = 'enforcement_fts JOIN enforcement e ON e.id = enforcement_fts.rowid';
    where.push('enforcement_fts MATCH ?');
    params.push(ftsMatch(intent.topic));
  }
  if (intent.type) { where.push('e.type LIKE ?'); params.push('%' + intent.type + '%'); }
  if (intent.year) { where.push('e.year = ?'); params.push(intent.year); }
  if (intent.regime) { where.push('e.regime LIKE ?'); params.push('%' + intent.regime + '%'); }
  const w = where.length ? ' WHERE ' + where.join(' AND ') : '';
  const cols = 'e.id, e.org, e.date, e.year, e.type, e.sector, e.regime, e.amount_gbp, e.summary, e.url, e.notice_url';
  const order = intent.kind === 'largest' ? ' ORDER BY e.amount_gbp IS NULL, e.amount_gbp DESC, e.date DESC' : ' ORDER BY e.date DESC';
  const sql = 'SELECT ' + cols + ' FROM ' + from + w + order + ' LIMIT 200';
  const rows = db.selectObjects(sql, params);
  const withAmount = rows.filter((r) => r.amount_gbp != null);
  let figure = null;
  if (intent.kind === 'total') figure = withAmount.reduce((s, r) => s + r.amount_gbp, 0);
  if (intent.kind === 'count') figure = rows.length;
  if (intent.kind === 'largest') figure = withAmount[0] || null;
  // The law these actions cite most often, for "which articles were breached".
  const ids = rows.map((r) => r.id);
  const breached = ids.length ? db.selectObjects("SELECT ref, count(DISTINCT src_id) AS n FROM links WHERE kind = 'enforcement' AND src_id IN (" + ids.map(() => '?').join(',') + ') GROUP BY ref ORDER BY n DESC LIMIT 6', ids) : [];
  return { intent, rows, withAmount: withAmount.length, figure, breached, sql, params };
}

export const gbp = (n) => '£' + Number(n).toLocaleString('en-GB');

// A deterministic sentence for the headline -- figures are never generated.
export function describeEnforcement(res) {
  const { intent, rows, figure, withAmount } = res;
  const scope = [intent.type ? intent.type.toLowerCase() : 'enforcement actions', intent.regime ? 'under ' + intent.regime : '', intent.year ? 'in ' + intent.year : '', intent.topic.length ? 'matching "' + intent.topic.join(' ') + '"' : ''].filter(Boolean).join(' ');
  if (!rows.length) return 'No ' + scope + ' in the ICO data held here.';
  if (intent.kind === 'largest') return figure ? 'The largest of the ' + rows.length + ' ' + scope + ' is ' + gbp(figure.amount_gbp) + ', issued to ' + figure.org + ' on ' + figure.date + '.' : 'None of the ' + rows.length + ' ' + scope + ' has a stated amount.';
  if (intent.kind === 'total') return 'The ' + rows.length + ' ' + scope + ' total ' + gbp(figure) + (withAmount < rows.length ? ' (' + (rows.length - withAmount) + ' without a stated amount are excluded)' : '') + '.';
  if (intent.kind === 'count') return 'There are ' + figure + ' ' + scope + ' in the ICO data held here.';
  return rows.length + ' ' + scope + ':';
}
