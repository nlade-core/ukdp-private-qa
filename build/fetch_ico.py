"""Fetch ICO guidance and enforcement pages (and penalty notices) once, politely.

    python3 build/fetch_ico.py        # resumable; safe to re-run

ico.org.uk content: "All text content is available under the Open Government
Licence v3.0, except where otherwise stated." robots.txt asks for a 6-second
crawl delay, which is honoured between every request. Everything is cached in
build/cache/ico/ (gitignored); a re-run only fetches what's missing.

Scope: every dated enforcement action and its PDF notice (the amount, the
law breached and the articles cited are often only in the notice), and the
core UK GDPR guidance sections that map onto the law.
"""
import html
import os
import re
import time
import urllib.error
import urllib.request

UA = 'ukdp-private-qa-build/0.1 (https://github.com/nlade-core/ukdp-private-qa)'
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'ico')
CRAWL_DELAY = 6.0
GUIDANCE_ROOT = '/for-organisations/uk-gdpr-guidance-and-resources/'
GUIDANCE_SECTIONS = ['lawful-basis', 'individual-rights', 'subject-access-requests', 'data-protection-principles',
                     'personal-information-what-is-it', 'controllers-and-processors', 'accountability-and-governance',
                     'security', 'international-transfers', 'exemptions', 'employment']
_last = [0.0]


def get(url, path, log):
    if os.path.exists(path):
        return True
    wait = CRAWL_DELAY - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    for attempt in range(3):
        _last[0] = time.time()
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path + '.part', 'wb') as f:
                f.write(data)
            os.replace(path + '.part', path)
            log.write('ok   %s\n' % url)
            return True
        except urllib.error.HTTPError as e:
            log.write('HTTP %d %s\n' % (e.code, url))
            if e.code in (404, 410):
                return False
        except Exception as e:  # network hiccup: back off and retry
            log.write('err  %s %s\n' % (url, e))
        log.flush()
        time.sleep(CRAWL_DELAY * (attempt + 2))
    return False


def slug(url):
    return re.sub(r'[^a-z0-9]+', '-', url.split('ico.org.uk', 1)[-1].lower()).strip('-')[:180]


def main():
    os.makedirs(CACHE, exist_ok=True)
    log = open(os.path.join(CACHE, 'fetch.log'), 'a')
    sitemap = os.path.join(CACHE, 'sitemap.xml')
    get('https://ico.org.uk/sitemap/', sitemap, log)
    urls = re.findall(r'<loc>(.*?)</loc>', open(sitemap, encoding='utf-8', errors='ignore').read())
    enforcement = [u for u in urls if re.search(r'/action-weve-taken/enforcement/\d{4}/\d{2}/[^/]+/$', u)]
    guidance = [u for u in urls if any(u.split('ico.org.uk', 1)[-1].startswith(GUIDANCE_ROOT + s + '/') for s in GUIDANCE_SECTIONS)]
    todo = [('enforcement', u) for u in enforcement] + [('guidance', u) for u in guidance]
    print('%d enforcement + %d guidance pages (cached ones skipped)' % (len(enforcement), len(guidance)), flush=True)
    for i, (kind, u) in enumerate(todo, 1):
        get(u, os.path.join(CACHE, kind, slug(u) + '.html'), log)
        if i % 25 == 0:
            print('%d/%d pages' % (i, len(todo)), flush=True)
    # Notices: the amount, the regime and the articles breached are often only in the PDF.
    pdfs = []
    for u in enforcement:
        p = os.path.join(CACHE, 'enforcement', slug(u) + '.html')
        if not os.path.exists(p):
            continue
        page = open(p, encoding='utf-8', errors='ignore').read()
        text = re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', page)))
        for href in re.findall(r'href="([^"]+\.pdf)"', page)[:1]:
            pdfs.append(href if href.startswith('http') else 'https://ico.org.uk' + href)
    print('%d notices' % len(pdfs), flush=True)
    for i, u in enumerate(pdfs, 1):
        get(u, os.path.join(CACHE, 'pdf', re.sub(r'[^a-z0-9.]+', '-', u.rsplit('/', 1)[-1].lower())), log)
        if i % 25 == 0:
            print('%d/%d notices' % (i, len(pdfs)), flush=True)
    print('done', flush=True)


if __name__ == '__main__':
    main()
