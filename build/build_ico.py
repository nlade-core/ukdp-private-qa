"""Parse the cached ICO pages into guidance, enforcement and link rows.

Called by build_db.py (stdlib only; the penalty-notice PDFs are read with
`pdftotext` from poppler). Nothing here touches the network -- fetching is
build/fetch_ico.py's job.

- guidance:    one row per sub-section of a guidance page ("In brief › Can
               we refuse to rectify?"), long ones split by paragraph.
- enforcement: one row per enforcement action -- organisation, date, type,
               sector, legal regime, amount (monetary penalties only; the
               amount is read from the notice PDF), summary, links.
- links:       every guidance/enforcement row -> the law provisions its text
               cites ("Article 16" -> "UK GDPR Art. 16"), so a plain-English
               guidance hit can lead straight to the law.
"""
import html
import os
import re
import shutil
import subprocess
from html.parser import HTMLParser

CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'ico')
MAX_CHARS = 2500
MONTHS = {m: i for i, m in enumerate(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'], 1)}


def clean(s):
    return re.sub(r'[ \t  -​ ]+', ' ', html.unescape(s)).strip()


class MainText(HTMLParser):
    """Headings and text blocks inside <main>, skipping navigation, download
    panels and other page furniture."""
    SKIP_CLASSES = ('download-panel', 'multipage-nav', 'print:hidden', 'breadcrumb', 'feedback')
    BLOCKS = {'p', 'li', 'td', 'th', 'dd', 'dt', 'blockquote'}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.in_main = 0
        self.skip = 0
        self.stack = []
        self.items = []  # ('h1'..'h4', text) or ('p', text)
        self.buf = None
        self.buf_tag = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'main':
            self.in_main += 1
        if not self.in_main:
            return
        cls = a.get('class', '') or ''
        skipping = tag in ('script', 'style', 'nav', 'aside', 'button', 'form', 'svg') or any(c in cls for c in self.SKIP_CLASSES)
        self.stack.append((tag, skipping))
        if skipping:
            self.skip += 1
        if self.skip:
            return
        if tag in ('h1', 'h2', 'h3', 'h4') or tag in self.BLOCKS:
            self.flush()
            self.buf, self.buf_tag = [], tag
        elif tag == 'br' and self.buf is not None:
            self.buf.append(' ')

    def handle_endtag(self, tag):
        if tag == 'main':
            self.flush()
            self.in_main -= 1
            return
        if not self.in_main:
            return
        while self.stack:
            t, skipping = self.stack.pop()
            if skipping:
                self.skip -= 1
            if t == tag:
                break
        if not self.skip and tag == self.buf_tag:
            self.flush()

    def handle_data(self, data):
        if self.in_main and not self.skip and self.buf is not None:
            self.buf.append(data)

    def flush(self):
        if self.buf is not None:
            text = re.sub(r'\s+', ' ', clean(''.join(self.buf))).strip()
            if text:
                kind = self.buf_tag if self.buf_tag in ('h1', 'h2', 'h3', 'h4') else 'p'
                self.items.append((kind, ('• ' if self.buf_tag == 'li' else '') + text))
        self.buf, self.buf_tag = None, None


def guidance_rows(path, url):
    p = MainText()
    p.feed(open(path, encoding='utf-8', errors='ignore').read())
    items = p.items
    title = next((t for k, t in items if k == 'h1'), '')
    topic = url.split('/uk-gdpr-guidance-and-resources/', 1)[-1].split('/')[0].replace('-', ' ')
    sections, h2, h3, buf = [], '', '', []

    def close():
        text = '\n'.join(buf).strip()
        if len(text) > 80:
            sections.append((' › '.join(x for x in (h2, h3) if x), text))

    for kind, text in items:
        if kind == 'h1':
            continue
        if kind in ('h2', 'h3', 'h4'):
            close()
            buf = []
            if kind == 'h2':
                h2, h3 = text, ''
            else:
                h3 = text
            continue
        if re.fullmatch(r'(Download options.*|Pages All pages This page|Back to top|Print this page)', text):
            continue
        buf.append(text)
    close()
    rows = []
    for section, text in sections:
        # Long sections: split on paragraph boundaries so each row fits a small model's context.
        chunk = []
        for para in text.split('\n'):
            if chunk and len('\n'.join(chunk)) + len(para) > MAX_CHARS:
                rows.append((title, section, '\n'.join(chunk), url, topic))
                chunk = []
            chunk.append(para)
        if chunk:
            rows.append((title, section, '\n'.join(chunk), url, topic))
    return rows


def parse_date(s):
    m = re.search(r'(\d{1,2}) ([A-Za-z]+) (\d{4})', s or '')
    if not m or m.group(2).lower() not in MONTHS:
        return None
    return '%s-%02d-%02d' % (m.group(3), MONTHS[m.group(2).lower()], int(m.group(1)))


def regime_of(text):
    t = text.lower()
    pecr = bool(re.search(r'privacy and electronic communications|\bpecr\b|regulations? (19|21|22|23|24)\b', t))
    gdpr = bool(re.search(r'\buk gdpr\b|\bgdpr\b|general data protection|data protection act 2018|\bdpa 2018\b|article \d', t))
    if pecr and not gdpr:
        return 'PECR'
    if gdpr and not pecr:
        return 'UK GDPR / DPA 2018'
    if pecr and gdpr:
        return 'UK GDPR / DPA 2018 and PECR'
    return ''


def pdf_text(pdf_path, pages=12):
    if not os.path.exists(pdf_path) or not shutil.which('pdftotext'):
        return ''
    try:
        return re.sub(r'\s+', ' ', subprocess.run(['pdftotext', '-l', str(pages), pdf_path, '-'], capture_output=True, text=True, timeout=60).stdout)
    except Exception:
        return ''


def notice_amount(pdf_path):
    """The penalty amount from a monetary penalty notice: the figure stated as
    the penalty ("a monetary penalty of £120,000", "penalty in the sum of"),
    else the largest £ figure in the notice's first pages."""
    if not os.path.exists(pdf_path) or not shutil.which('pdftotext'):
        return None, ''
    try:
        text = subprocess.run(['pdftotext', '-l', '12', pdf_path, '-'], capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return None, ''
    flat = re.sub(r'\s+', ' ', text)
    money = r'£\s?([\d,]+(?:\.\d{1,2})?)(\s?(?:million|m)\b)?'
    m = re.search(r'(?:penalty|fine)[^£.]{0,80}?' + money, flat, re.I) or re.search(money + r'[^.]{0,60}?(?:penalty|fine)', flat, re.I)
    def value(g, mult):
        v = float(g.replace(',', ''))
        return int(round(v * 1_000_000)) if mult else int(round(v))
    if m:
        return value(m.group(1), m.group(2)), flat
    figures = [value(a, b) for a, b in re.findall(money, flat)]
    return (max(figures) if figures else None), flat


def enforcement_row(path, url, pdf_dir):
    h = open(path, encoding='utf-8', errors='ignore').read()
    org = clean(re.sub(r'<[^>]+>', ' ', (re.findall(r'<h1[^>]*>(.*?)</h1>', h, re.S) or [''])[0]))
    # The page's own labelled fields: <span>Date</span> <strong>20 February 2026</strong>
    fields = {k: clean(re.sub(r'<[^>]+>', ' ', v)) for k, v in re.findall(r'<span>\s*(Date|Type|Sector)\s*</span>\s*<strong[^>]*>(.*?)</strong>', h, re.S)}
    date = parse_date(fields.get('Date', ''))
    if not date:  # fall back to the /YYYY/MM/ in the URL
        m = re.search(r'/(\d{4})/(\d{2})/', url)
        date = '%s-%s-01' % m.groups() if m else None
    etype, sector = fields.get('Type', ''), fields.get('Sector', '')
    p = MainText()
    p.feed(h)
    summary = ' '.join(t for k, t in p.items if k == 'p' and not re.match(r'(•\s*)?(Date|Type|Sector)\b|Back to top|Print this page', t))[:2000]
    pdfs = re.findall(r'href="([^"]+\.pdf)"', h)
    notice = (pdfs[0] if pdfs[0].startswith('http') else 'https://ico.org.uk' + pdfs[0]) if pdfs else ''
    amount, notice_text = None, ''
    notice_pdf = os.path.join(pdf_dir, re.sub(r'[^a-z0-9.]+', '-', notice.rsplit('/', 1)[-1].lower())) if notice else ''
    if 'penalt' in etype.lower():
        # A figure stated as the penalty in the page's own summary wins
        # ("We imposed a £14,472,500.00 penalty"); otherwise read the notice.
        m = re.search(r'£\s?([\d,]+(?:\.\d{1,2})?)(\s?(?:million|m)\b)?[^.]{0,40}?(?:penalty|fine)|(?:penalty|fine)[^£.]{0,60}?£\s?([\d,]+(?:\.\d{1,2})?)(\s?(?:million|m)\b)?', summary, re.I)
        if m:
            g, mult = (m.group(1), m.group(2)) if m.group(1) else (m.group(3), m.group(4))
            v = float(g.replace(',', ''))
            amount = int(round(v * 1_000_000)) if mult else int(round(v))
        if notice_pdf:
            a2, notice_text = notice_amount(notice_pdf)
            amount = amount or a2
    elif notice_pdf:
        notice_text = pdf_text(notice_pdf)
    regime = regime_of(summary + ' ' + notice_text[:20000])
    if not regime and re.search(r'unsolicited (?:direct )?(?:marketing )?(?:calls?|texts?|emails?|messages?|marketing)|nuisance calls|\bTPS\b', summary, re.I):
        regime = 'PECR'  # unsolicited electronic marketing is PECR by definition
    refs = sorted(law_refs(summary + ' ' + notice_text[:30000]))
    return (org, date, int(date[:4]) if date else None, etype, sector, regime, amount, summary, url, notice, refs)


# "Article 16", "Articles 5(1)(f) and 32", "section 170 of the DPA 2018",
# "Schedule 1, paragraph 6" -> refs in the provisions table.
def law_refs(text):
    refs = set()
    for m in re.finditer(r'\bArticles? (\d+[A-Z]{0,3}(?:\(\w+\))*)((?:(?:,| and| or) \d+[A-Z]{0,3}(?:\(\w+\))*)*)', text):
        for a in [m.group(1)] + re.findall(r'\d+[A-Z]{0,3}(?:\(\w+\))*', m.group(2)):
            refs.add('UK GDPR Art. ' + a)
    for m in re.finditer(r'\b[Ss]ections? (\d+[A-Z]{0,2}(?:\(\w+\))*)(?=[^.]{0,40}(?:DPA|Data Protection Act))', text):
        refs.add('DPA 2018 s. ' + m.group(1))
    for m in re.finditer(r'\bSchedule (\d+)(?:,? [Pp]aragraph (\d+))?(?=[^.]{0,60}(?:DPA|Data Protection Act)|)', text):
        refs.add('DPA 2018 Sch. ' + m.group(1) + (' para. ' + m.group(2) if m.group(2) else ''))
    return refs


def load():
    """(guidance rows, enforcement rows) from whatever is cached."""
    guidance, enforcement = [], []
    import glob
    sitemap = os.path.join(CACHE, 'sitemap.xml')
    urls = re.findall(r'<loc>(.*?)</loc>', open(sitemap, encoding='utf-8', errors='ignore').read()) if os.path.exists(sitemap) else []
    by_slug = {re.sub(r'[^a-z0-9]+', '-', u.split('ico.org.uk', 1)[-1].lower()).strip('-')[:180]: u for u in urls}
    for path in sorted(glob.glob(os.path.join(CACHE, 'guidance', '*.html'))):
        url = by_slug.get(os.path.basename(path)[:-5])
        if url:
            guidance += guidance_rows(path, url)
    for path in sorted(glob.glob(os.path.join(CACHE, 'enforcement', '*.html'))):
        url = by_slug.get(os.path.basename(path)[:-5])
        if url:
            enforcement.append(enforcement_row(path, url, os.path.join(CACHE, 'pdf')))
    return guidance, enforcement
