# SQLite WebAssembly — vendored, unmodified

The official SQLite build for browsers (and Node), used to run full-text search (FTS5) over the bundled database entirely on the device.

- **Package:** [`@sqlite.org/sqlite-wasm`](https://www.npmjs.com/package/@sqlite.org/sqlite-wasm) **3.53.4-build1** (SQLite 3.53.4); npm tarball sha256 `24f46db4ce5248fa8f8f24b67e81909ab1a9c152f42a4796a32c6d385a6fb62b`
- **Licence:** the JavaScript/WebAssembly packaging is Apache-2.0 (see [LICENSE](LICENSE)); SQLite itself is in the public domain.
- **Files, unmodified from `dist/`:**
  - `index.mjs` — sha256 `a6d3fe46aa3f924e7686329f97b0564549ef1f787e0c19924179aef7f72bcc01`
  - `node.mjs` — sha256 `e474cb70f112cbc8d12082c9aef82076392b5e7874f856b7c2fd482e7bed6e54`
  - `sqlite3.wasm` — sha256 `2ee8f3dab694532afc8840e07703127287662d08b74e6ff50491ce63f00d5752`

`index.mjs` + `sqlite3.wasm` are what the page loads (~1.5 MB); `node.mjs` is only for `eval/`, so evaluation runs on the same engine as the browser.
