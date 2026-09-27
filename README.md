# ukdp-private-qa

Private, on-device questions and answers over UK data-protection law (UK GDPR + Data Protection Act 2018): one static page, one SQLite file, Chrome's built-in model — no server, and nothing you ask leaves your device.

**Status (2026-09-27 14:22):** in development. Plan and method: full-text search (SQLite FTS5) finds candidate provisions, the on-device model picks the one that answers the question, and every answer cites the article or section it came from. Accuracy will be published here, measured on held-out questions.

**Spike (2026-09-27 14:22):** SQLite 3.53.4 (WebAssembly) in headless Chrome 154 — starts in 39 ms, loads a 7 MB full-text database in 38 ms, answers queries in 4–12 ms; identical engine and results in Node for evaluation.

## Licence

MIT — see [LICENSE](LICENSE). Bundled SQLite WebAssembly: Apache-2.0 packaging, public-domain SQLite ([`vendor/sqlite-wasm/`](vendor/sqlite-wasm/)). Legislation text: contains public sector information licensed under the Open Government Licence v3.0.
