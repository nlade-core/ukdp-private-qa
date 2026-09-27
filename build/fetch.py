"""Fetch the two Acts from legislation.gov.uk as whole-document XML, once.

Two requests in total (not one per provision), cached in build/cache/ so
rebuilding the database never re-hits the site. Delete the cache to refresh.
"""
import os
import urllib.request

UA = 'ukdp-private-qa-build/0.1 (https://github.com/nlade-core/ukdp-private-qa)'
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
SOURCES = {
    'uk-gdpr': 'https://www.legislation.gov.uk/eur/2016/679/data.xml',
    'dpa-2018': 'https://www.legislation.gov.uk/ukpga/2018/12/data.xml',
}


def fetch_all():
    os.makedirs(CACHE, exist_ok=True)
    paths = {}
    for key, url in SOURCES.items():
        path = os.path.join(CACHE, key + '.xml')
        if not os.path.exists(path):
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=120) as r, open(path, 'wb') as f:
                f.write(r.read())
            print('fetched', key, os.path.getsize(path), 'bytes')
        paths[key] = path
    return paths


if __name__ == '__main__':
    print(fetch_all())
