"""Build data/ukdp.sqlite(.gz) from UK GDPR + Data Protection Act 2018.

    python3 build/build_db.py

Source: legislation.gov.uk whole-document XML (build/fetch.py, cached).
One row per provision (article / section / schedule paragraph); anything
over MAX_CHARS is split into its numbered paragraphs, and those into their
points if still too long, so every row has a precise citation
("UK GDPR Art. 4(1)(7)") and fits comfortably in an on-device model's
context. Amendment notes (Commentary) are dropped from the text.
"""
import datetime
import gzip
import os
import re
import sqlite3
import sys
import xml.etree.ElementTree as ET

from fetch import fetch_all
import build_ico

NS = '{http://www.legislation.gov.uk/namespaces/legislation}'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'ukdp.sqlite')
MAX_CHARS = 3000
MAX_GZ_BYTES = 25 * 1024 * 1024
ACTS = {'uk-gdpr': 'UK GDPR', 'dpa-2018': 'DPA 2018'}
SKIP = {'Commentary', 'CommentaryRef', 'Commentaries', 'Footnote', 'FootnoteRef', 'MarginNote'}
CONTAINERS = {'Division', 'Part', 'Chapter', 'Pblock', 'PsubBlock', 'Schedule', 'EUPart', 'EUTitle', 'EUChapter', 'EUSection', 'EUSubsection'}
LEVELS = ('P2', 'P3', 'P4', 'P5')
# Which regime a DPA 2018 provision belongs to, from the Act's own structure.
# Parts 3 and 4 re-use UK GDPR headings but apply only to law-enforcement
# bodies and the intelligence services; Schedule 19 amends other Acts;
# Schedules 20-21 are transitional. Retrieval keeps those out of the way
# unless a question is about them (see retrieval.js).
SCOPES = [
    (r'^PART 3\b|^SCHEDULE (7|8)$', 'law-enforcement'),
    (r'^PART 4\b|^SCHEDULE (9|10|11)$', 'intelligence'),
    (r'^SCHEDULE 19$', 'amendments'),
    (r'^SCHEDULE (20|21)$', 'transitional'),
]


def scope_of(act, path):
    top = path.split(' › ')[0]
    if act == 'dpa-2018':
        for pattern, scope in SCOPES:
            if re.search(pattern, top):
                return scope
    return 'general'


def local(tag):
    return tag.split('}')[-1] if isinstance(tag, str) else ''


def inline(el):
    """All text inside an element, minus amendment notes."""
    if local(el.tag) in SKIP:
        return ''
    parts = [el.text or '']
    for c in el:
        parts.append(inline(c))
        parts.append(c.tail or '')
    return ''.join(parts)


def clean(s):
    # Non-breaking and other odd spaces become plain ones -- Schedule 21's
    # heading is "SCHEDULE\u00a021", which silently defeated the regime
    # labelling below until the eval caught it.
    return re.sub(r'[ \t\u00a0\u2000-\u200b\u202f]+', ' ', s).strip()


def render(el, depth=0):
    """Provision text with its paragraph numbering: '(1) … (a) …', one per line."""
    t = local(el.tag)
    if t in SKIP or t in ('Pnumber', 'Title', 'Number'):
        return ''
    if t in LEVELS:
        num = next((clean(inline(c)) for c in el if local(c.tag) == 'Pnumber'), '')
        body = ''.join(render(c, depth + 1) for c in el)
        return '\n' + '  ' * depth + ('(%s) ' % num.strip(' .()') if num else '') + body.lstrip()
    if t == 'Text':
        return clean(inline(el)) + ' '
    return ''.join(render(c, depth) for c in el)


def normalise(text):
    text = '\n'.join(clean(line) for line in text.split('\n'))
    return re.sub(r'\n{2,}', '\n', text).strip()


def make_ref(act, uri):
    """…/article/6/1/f -> 'UK GDPR Art. 6(1)(f)'; …/schedule/1/paragraph/6/1 -> 'DPA 2018 Sch. 1 para. 6(1)'."""
    rest = re.sub(r'^.*?/(?:eur/2016/679|ukpga/2018/12)/', '', uri).split('/')
    head, i = [], 0
    names = {'article': 'Art.', 'section': 's.', 'schedule': 'Sch.', 'paragraph': 'para.', 'part': 'Pt', 'annex': 'Annex', 'chapter': 'Ch.', 'regulation': 'reg.'}
    while i + 1 < len(rest) and rest[i] in names:
        head.append('%s %s' % (names[rest[i]], rest[i + 1]))
        i += 2
    tail = ''.join('(%s)' % s for s in rest[i:])
    return '%s %s%s' % (ACTS[act], ' '.join(head), tail)


def parse(act, path):
    tree = ET.parse(path)
    root = tree.getroot()
    parent = {c: p for p in root.iter() for c in p}

    def title_of(el):
        t = next((c for c in el if local(c.tag) == 'Title'), None)
        return clean(inline(t)) if t is not None else ''

    def number_of(el):
        n = next((c for c in el if local(c.tag) == 'Number'), None)
        return clean(inline(n)) if n is not None else ''

    rows = []
    for p1 in root.iter(NS + 'P1'):
        uri = p1.get('DocumentURI')
        if not uri:
            continue
        up = parent.get(p1)
        title = title_of(up) if up is not None and local(up.tag) == 'P1group' else ''
        crumbs, a = [], up
        while a is not None:
            if local(a.tag) in CONTAINERS:
                label = ' '.join(x for x in (number_of(a), title_of(a)) if x)
                if label:
                    crumbs.append(label)
            a = parent.get(a)
        path_label = ' › '.join(reversed(crumbs))
        if not title:
            # Schedule paragraphs usually sit under a titled group, not in
            # their own P1group ("Statutory etc and government purposes").
            a = up
            while a is not None and not title:
                if local(a.tag) in CONTAINERS or local(a.tag) == 'P1group':
                    title = title_of(a)
                a = parent.get(a)
        text = normalise(render(p1))
        if len(re.sub(r'[\W_]', '', text)) < 15:
            continue  # repealed / omitted ("…")
        units = [(uri, text)]
        if len(text) > MAX_CHARS:
            units = split(p1)
        for u_uri, u_text in units:
            rows.append((act, make_ref(act, u_uri), title, path_label, u_text, u_uri.replace('http://', 'https://'), scope_of(act, path_label)))
    return rows


def split(el):
    """Numbered paragraphs, and their points if a paragraph is still too long.
    A point keeps its paragraph's lead-in ("For the purposes of this Regulation:")."""
    out = []
    for p2 in el.iter(NS + 'P2'):
        uri = p2.get('DocumentURI')
        text = normalise(render(p2))
        if not uri or not text:
            continue
        if len(text) <= MAX_CHARS or not any(True for _ in p2.iter(NS + 'P3')):
            out.append((uri, text))
            continue
        para = next((c for c in p2 if local(c.tag) == 'P2para'), None)
        lead = next((clean(inline(c)) for c in para if local(c.tag) == 'Text'), '') if para is not None else ''
        for p3 in p2.iter(NS + 'P3'):
            if p3.get('DocumentURI'):
                out.append((p3.get('DocumentURI'), normalise((lead + '\n' if lead else '') + render(p3))))
    return out or [(el.get('DocumentURI'), normalise(render(el)))]


def build():
    paths = fetch_all()
    rows = []
    for act, path in paths.items():
        rows += parse(act, path)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    if os.path.exists(OUT):
        os.remove(OUT)
    db = sqlite3.connect(OUT)
    db.executescript("""
        CREATE TABLE provisions(id INTEGER PRIMARY KEY, act TEXT, ref TEXT, title TEXT, path TEXT, text TEXT, url TEXT, scope TEXT);
        CREATE VIRTUAL TABLE provisions_fts USING fts5(title, path, text, content='provisions', content_rowid='id', tokenize='porter unicode61');
        CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);
    """)
    db.executemany('INSERT INTO provisions(act, ref, title, path, text, url, scope) VALUES (?,?,?,?,?,?,?)', rows)
    db.execute("INSERT INTO provisions_fts(provisions_fts) VALUES('rebuild')")
    ico = add_ico(db, rows)
    fetched = datetime.datetime.fromtimestamp(min(os.path.getmtime(p) for p in paths.values()), datetime.UTC).strftime('%Y-%m-%d')
    db.executemany('INSERT INTO meta VALUES (?,?)', [
        ('source', 'legislation.gov.uk: UK GDPR (eur/2016/679) and Data Protection Act 2018 (ukpga/2018/12)'),
        ('licence', 'Contains public sector information licensed under the Open Government Licence v3.0.'),
        ('fetched', fetched),
        ('note', 'Text as published on legislation.gov.uk on the fetch date; it may not reflect every amendment in force.'),
    ] + ([('ico_source', 'ico.org.uk: UK GDPR guidance and enforcement action. All text content is available under the Open Government Licence v3.0.'),
          ('ico_fetched', ico['fetched'])] if ico else []))
    db.commit()
    db.execute('VACUUM')
    db.close()
    # mtime=0: an unchanged law rebuilds to a byte-identical file, so git
    # only sees a diff when the text actually changed.
    with open(OUT, 'rb') as f, open(OUT + '.gz', 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', compresslevel=9, mtime=0) as g:
        g.write(f.read())
    return rows


def resolve_ref(ref, refs, prefixes):
    """A cited ref -> the most specific ref that exists in the provisions
    table ("UK GDPR Art. 32(1)(f)" -> "UK GDPR Art. 32(1)"), or None."""
    r = ref
    while True:
        if r in refs or r in prefixes:
            return r
        shorter = re.sub(r'\([^()]*\)$', '', r)
        if shorter == r:
            return None
        r = shorter


def add_ico(db, rows):
    """ICO guidance + enforcement + links to the law, if the cache exists."""
    if not os.path.isdir(build_ico.CACHE):
        return None
    guidance, enforcement = build_ico.load()
    if not guidance and not enforcement:
        return None
    refs = {r[1] for r in rows}
    prefixes = set()
    for r in refs:
        for m in re.finditer(r'\(', r):
            prefixes.add(r[:m.start()])
    db.executescript("""
        CREATE TABLE guidance(id INTEGER PRIMARY KEY, title TEXT, section TEXT, text TEXT, url TEXT, topic TEXT, under_review INTEGER);
        CREATE VIRTUAL TABLE guidance_fts USING fts5(title, section, text, content='guidance', content_rowid='id', tokenize='porter unicode61');
        CREATE TABLE enforcement(id INTEGER PRIMARY KEY, org TEXT, date TEXT, year INTEGER, type TEXT, sector TEXT, regime TEXT, amount_gbp INTEGER, summary TEXT, url TEXT, notice_url TEXT);
        CREATE VIRTUAL TABLE enforcement_fts USING fts5(org, type, sector, summary, content='enforcement', content_rowid='id', tokenize='porter unicode61');
        CREATE TABLE links(kind TEXT, src_id INTEGER, ref TEXT);
        CREATE INDEX links_ref ON links(ref);
        CREATE INDEX links_src ON links(kind, src_id);
    """)
    review = {g[3] for g in guidance if re.search(r'this guidance is under review', g[2], re.I)}
    n_links, unresolved = 0, 0
    for g in guidance:
        cur = db.execute('INSERT INTO guidance(title, section, text, url, topic, under_review) VALUES (?,?,?,?,?,?)', (*g, int(g[3] in review)))
        for ref in build_ico.law_refs(g[2]):
            r = resolve_ref(ref, refs, prefixes)
            if r:
                db.execute('INSERT INTO links VALUES (?,?,?)', ('guidance', cur.lastrowid, r)); n_links += 1
            else:
                unresolved += 1
    for e in enforcement:
        cur = db.execute('INSERT INTO enforcement(org, date, year, type, sector, regime, amount_gbp, summary, url, notice_url) VALUES (?,?,?,?,?,?,?,?,?,?)', e[:10])
        for ref in e[10]:
            r = resolve_ref(ref, refs, prefixes)
            if r:
                db.execute('INSERT INTO links VALUES (?,?,?)', ('enforcement', cur.lastrowid, r)); n_links += 1
            else:
                unresolved += 1
    db.execute("INSERT INTO guidance_fts(guidance_fts) VALUES('rebuild')")
    db.execute("INSERT INTO enforcement_fts(enforcement_fts) VALUES('rebuild')")
    # Links are deduplicated per source row.
    db.execute('DELETE FROM links WHERE rowid NOT IN (SELECT min(rowid) FROM links GROUP BY kind, src_id, ref)')
    fetched = datetime.datetime.fromtimestamp(os.path.getmtime(os.path.join(build_ico.CACHE, 'sitemap.xml')), datetime.UTC).strftime('%Y-%m-%d')
    return {'guidance': len(guidance), 'pages': len({g[3] for g in guidance}), 'under_review': len(review), 'enforcement': len(enforcement),
            'links': n_links, 'unresolved': unresolved, 'fetched': fetched}


def report(rows):
    raw, gz = os.path.getsize(OUT), os.path.getsize(OUT + '.gz')
    print('rows: %d  (%s)' % (len(rows), ', '.join('%s %d' % (ACTS[a], sum(1 for r in rows if r[0] == a)) for a in ACTS)))
    print('size: %.2f MB raw, %.2f MB gzipped' % (raw / 1e6, gz / 1e6))
    print('longest row: %d chars (%s)' % max((len(r[4]), r[1]) for r in rows))
    print('scopes:', ', '.join('%s %d' % (sc, sum(1 for r in rows if r[6] == sc)) for sc in ('general', 'law-enforcement', 'intelligence', 'amendments', 'transitional')))
    db = sqlite3.connect(OUT)
    for ref in ('UK GDPR Art. 6', 'UK GDPR Art. 4(1)(7)', 'DPA 2018 s. 64', 'DPA 2018 Sch. 1 para. 6'):
        r = db.execute('SELECT ref, title, path, substr(text, 1, 160) FROM provisions WHERE ref = ?', (ref,)).fetchone()
        print('\n' + (' | '.join(r) if r else 'MISSING: ' + ref))
    if db.execute("SELECT count(*) FROM sqlite_master WHERE name='guidance'").fetchone()[0]:
        g = db.execute('SELECT count(*), count(DISTINCT url), sum(under_review) FROM guidance').fetchone()
        e = db.execute("SELECT count(*), sum(amount_gbp IS NOT NULL), sum(regime != '') FROM enforcement").fetchone()
        l = db.execute('SELECT kind, count(*) FROM links GROUP BY kind').fetchall()
        print('\nICO guidance: %d rows from %d pages (%d rows on pages flagged under review)' % g)
        print('ICO enforcement: %d actions, %d with an amount, %d with a known regime' % e)
        print('links to the law:', l)
    print('\nFTS "lawfulness processing":', db.execute("SELECT p.ref FROM provisions_fts JOIN provisions p ON p.id = provisions_fts.rowid WHERE provisions_fts MATCH 'lawfulness processing' ORDER BY bm25(provisions_fts, 10.0, 3.0, 1.0) LIMIT 3").fetchall())
    if gz > MAX_GZ_BYTES:
        sys.exit('gzipped database is over %d MB -- too big to ship as a static file' % (MAX_GZ_BYTES // 1024 // 1024))


if __name__ == '__main__':
    report(build())
