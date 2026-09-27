# ukdp-private-qa

Ask questions about UK data protection law — the **UK GDPR** and the **Data Protection Act 2018** — and get an answer that cites the provision it came from, **computed entirely on your device**. The law ships with the page as a 0.57 MB SQLite database; the model is the one built into Chrome. Nothing you type is sent anywhere, and the page shows a live count of network requests to prove it (it stays at 0).

**Live:** https://nlade-core.github.io/ukdp-private-qa/ (desktop Chrome for generated answers; any modern browser for search-only mode).

It's a demonstration of a pattern, not a legal tool: **a document set, answered privately on-device, with measured accuracy.** The same approach works for an organisation's own policies or procedures — which then never leave its machines.

## How it works

1. `build/build_db.py` fetches both Acts from legislation.gov.uk as XML (two requests, cached), splits them into **1,576 citable rows** — articles, sections, schedule paragraphs; long ones into their numbered paragraphs, so a row cites as precisely as "UK GDPR Art. 4(1)(7)" — and writes a SQLite database with a full-text index (FTS5), gzipped for shipping.
2. The page loads it once (≈40–55 ms) into SQLite compiled to WebAssembly, running in the page.
3. For each question, [`retrieval.js`](retrieval.js) finds the provision, cheapest step first:
   - **an explicit citation** ("What does Article 17 say?") → looked up directly (a whole article is reassembled from its paragraphs);
   - **a definition question** → the row in the law's own form, *‘personal data’ means …*;
   - **a strong heading match** → trusted as is;
   - **otherwise Chrome's on-device model chooses** from the 25 closest full-text matches, shown only their references and headings — it answers with a number;
   - **with no model** (search-only mode), the best full-text match.
4. The model writes a short answer **from that provision's text only**, citing it; the provision is shown alongside with a link to legislation.gov.uk, plus other relevant provisions to switch to.

**The model never writes SQL.** Every query is fixed code; the model's only jobs are picking a number from a list and reading the text it's given. That keeps the search auditable and avoids a small model's unreliable query-writing.

Provisions that rarely answer general questions are kept out of the way unless asked for: DPA Parts 3 and 4 re-use UK GDPR headings but apply only to law-enforcement bodies and the intelligence services, and Schedules 19–21 amend other Acts or are transitional.

## Accuracy

32 questions of the kind a data protection officer or a business would ask, each with the provision(s) a correct answer should cite ([`eval/cases.json`](eval/cases.json)). "Correct" = the provision the page shows first is one of those (or a paragraph of one).

| Configuration | Development set (16) | **Held-out set (16)** |
|---|---|---|
| With a model choosing (3 runs per question) | 48/48 | **42/48 (88%)** |
| Search-only, no model — shown first | 9/16 | 11/16 |
| Search-only — within the top three shown | 11/16 | 13/16 |

Lookups take a few milliseconds; with the model choosing, the stand-in took ~0.1–2 s per question on an M1 Max.

**Method, and its limits** (2026-09-27):
- The questions and expected provisions were written **before any retrieval code existed**; the split was fixed in advance (odd = development, even = held-out). Only the development set was used for tuning.
- Ground truth is **the law as fetched**, not memory of it: while writing the questions, three expected provisions turned out to have been replaced by the Data (Use and Access) Act 2025 (Art. 22 → 22A–D, Arts. 44/45 → 44A/45A–C, DPA s. 9 → Art. 8ZA), and were corrected before any code ran.
- Changes made after seeing results are disclosed: one development expectation was widened when the first run picked Art. 6(11), which on reading lists examples of legitimate interests; and a labelling bug (a non-breaking space in "SCHEDULE 21") was found through a held-out miss and fixed — the held-out score was 42/48 before and after.
- The two held-out questions it gets wrong: *"Can a customer ask us to correct wrong information?"* — the law says "rectification", and keyword search can't bridge that (semantic matching would); and *"Can we send personal data to a supplier outside the UK?"* — it picks DPA s. 119A (standard clauses for transfers), related but not the core rules in UK GDPR Art. 44A/45A/46.
- The model in these numbers is a **stand-in** (Gemma 4 e4b via Ollama, with Gemini Nano's default sampling and no hidden reasoning), running the same SQLite build as the page. A run with real Gemini Nano in Chrome, and a review of answer quality (not just which provision was picked), are still to do.
- 32 questions is a small set: treat the percentages as indicative.

## Run it yourself

```sh
python3 -m http.server 8000            # then open http://localhost:8000
python3 build/build_db.py              # rebuild the database (stdlib only)
node eval/run.mjs --runs 3             # evaluate (needs Ollama + a small model; --no-model for search-only)
```

## Licence and sources

MIT — see [LICENSE](LICENSE). Bundled SQLite WebAssembly build: Apache-2.0 packaging of public-domain SQLite ([`vendor/sqlite-wasm/`](vendor/sqlite-wasm/)).

Legislation text from [legislation.gov.uk](https://www.legislation.gov.uk), fetched 2026-09-27; it may not reflect every amendment in force. Contains public sector information licensed under the Open Government Licence v3.0. General information, not legal advice.
