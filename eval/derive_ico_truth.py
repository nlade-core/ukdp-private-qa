"""Answer key for the enforcement questions (eval/cases_ico.json, ids 45-52).

    python3 eval/derive_ico_truth.py            # print
    python3 eval/derive_ico_truth.py --write    # store into cases_ico.json

Written independently of ico.js: plain SQL over the enforcement table, one
hand-written query per question, NOT the page's intent parser or query
builder. Run it (and fix the key) before scoring the page's code.

Scoring rules, fixed here in advance: single answers (largest fine's
organisation, a count, a total) must match exactly; lists of organisations
count as correct at F1 >= 0.8 against this key.
"""
import json, os, sqlite3, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
db = sqlite3.connect(os.path.join(ROOT, 'data', 'ukdp.sqlite'))
PEN = "type LIKE '%Monetary penalt%'"
one = lambda sql: db.execute(sql).fetchone()
col = lambda sql: sorted({r[0] for r in db.execute(sql)})
truth = {
    45: {'org': one(f"SELECT org FROM enforcement WHERE {PEN} AND year = 2025 AND amount_gbp IS NOT NULL ORDER BY amount_gbp DESC LIMIT 1")[0]},
    46: {'orgs': col(f"SELECT org FROM enforcement WHERE {PEN} AND year = 2026 AND regime = 'PECR' AND (summary LIKE '%call%')")},
    47: {'count': one("SELECT count(*) FROM enforcement WHERE type LIKE '%Reprimand%' AND year = 2024")[0]},
    48: {'orgs': col(f"SELECT org FROM enforcement WHERE {PEN} AND regime LIKE '%UK GDPR%' AND (summary LIKE '%cyber%' OR summary LIKE '%security%' OR summary LIKE '%attack%' OR id IN (SELECT src_id FROM links WHERE kind = 'enforcement' AND ref LIKE 'UK GDPR Art. 32%'))")},
    49: {'total': one(f"SELECT sum(amount_gbp) FROM enforcement WHERE {PEN} AND year = 2024")[0]},
    50: {'orgs': col("SELECT org FROM enforcement WHERE type LIKE '%Enforcement notice%' AND year = 2025")},
    51: {'org': one(f"SELECT org FROM enforcement WHERE {PEN} AND regime LIKE '%UK GDPR%' AND amount_gbp IS NOT NULL ORDER BY amount_gbp DESC LIMIT 1")[0]},
    52: {'orgs': col("SELECT org FROM enforcement WHERE sector LIKE '%health%' OR summary LIKE '%NHS%' OR org LIKE '%NHS%'")},
}
for k, v in truth.items():
    print(k, json.dumps(v)[:300])
print('\nspot-check the largest amounts against their notices:')
for r in db.execute(f"SELECT org, date, amount_gbp, notice_url FROM enforcement WHERE {PEN} AND amount_gbp IS NOT NULL ORDER BY amount_gbp DESC LIMIT 6"):
    print('  ', r)
if '--write' in sys.argv:
    p = os.path.join(ROOT, 'eval', 'cases_ico.json')
    d = json.load(open(p))
    for c in d['cases']:
        if c['id'] in truth:
            c['truth'] = truth[c['id']]
    json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
    print('written to', p)
