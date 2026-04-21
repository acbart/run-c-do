# run-c-do

**Compile and run C entirely in your browser — no server required.**

run-c-do is a pure static web app that lets you write C code in a textarea,
compile it with an in-browser Emscripten/Clang toolchain, and execute the
result — all locally in the browser tab.  It is designed to be deployed on
GitHub Pages (or any static file host) with zero backend infrastructure.

---

## How it works

```
┌─────────────────────────────────────────────────────────────┐
│  Browser tab                                                │
│                                                             │
│  index.html + app.js        ←──── User types C code        │
│       │                                                     │
│       │  postMessage(compile)                               │
│       ▼                                                     │
│  compiler-worker.js  (Web Worker — off the UI thread)       │
│       │                                                     │
│       │  importScripts(vendor/emception/emception.js)       │
│       ▼                                                     │
│  In-browser Emscripten/Clang bundle                         │
│  (runs entirely in the browser, no network calls needed)    │
│       │                                                     │
│       │  compiled Wasm artifact                             │
│       ▼                                                     │
│  app.js runs the artifact via new Function(jsText)(Module)  │
│  and captures stdout/stderr for display                     │
└─────────────────────────────────────────────────────────────┘
```

All compilation and execution happen **client-side**.  The only network
requests are the initial page load (HTML, CSS, JS, and the vendor bundle).

---

## Placing vendor compiler assets

> ⚠️  The vendor compiler bundle is **not** included in this repository.
> You must obtain it separately before the app will work.

See [`vendor/emception/README.md`](vendor/emception/README.md) for full
instructions.  The short version:

1. Build or download [Emception](https://github.com/nicowillis/emception).
2. Copy the resulting `emception.js` and sibling `.wasm` / data files into
   `vendor/emception/`.
3. Commit those files (or serve them alongside the static site).

If you use a different in-browser Emscripten/Clang distribution, update the
**COMPILER ADAPTER** section in `compiler-worker.js`.

---

## Local preview

Because `compiler-worker.js` uses `importScripts()` and Wasm files are
loaded from the filesystem, you **cannot** open `index.html` directly with
`file://` in most browsers.  Serve the directory over HTTP instead:

```bash
# Python 3 (simplest)
python3 -m http.server 8080
# then open http://localhost:8080

# Node.js (npx)
npx serve .
# then open the printed URL

# Ruby
ruby -run -e httpd . -p 8080
```

Some browsers require cross-origin isolation headers for `SharedArrayBuffer`
(used by certain Emception builds).  If you see `SharedArrayBuffer is not
defined` errors, start the server with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

A small Node.js helper server is provided for convenience:

```bash
node serve-local.js   # starts on http://localhost:8080
```

---

## GitHub Pages deployment

### Quick deploy (manual)

1. Push this repository to GitHub (with vendor assets in place).
2. Go to **Settings → Pages**.
3. Under **Source**, choose `Deploy from a branch`.
4. Select the branch (`main`) and folder (`/ (root)`).
5. Click **Save**.  Your site will appear at
   `https://<username>.github.io/<repo-name>/`.

No build step is required — the site is already static.

### Automated deploy with GitHub Actions

Create `.github/workflows/pages.yml`:

```yaml
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
permissions:
  pages: write
  id-token: write
jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - id: deployment
        uses: actions/deploy-pages@v4
```

### Notes on GitHub Pages and SharedArrayBuffer

GitHub Pages does **not** send `Cross-Origin-Opener-Policy` or
`Cross-Origin-Embedder-Policy` headers by default.  If the Emception bundle
requires `SharedArrayBuffer`, compilation will fail with a
`SharedArrayBuffer is not defined` error on GitHub Pages.

Workarounds:
- Use a bundle variant that does not require `SharedArrayBuffer` (check the
  Emception docs for a single-threaded build).
- Host on a platform that allows custom headers (Netlify, Cloudflare Pages,
  Vercel, etc.) and add the required headers there.
- Use the [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker)
  shim (adds the headers via a Service Worker hack — works for demos).

---

## Project structure

```
run-c-do/
├── index.html            Main page
├── styles.css            UI styles
├── app.js                UI logic, Worker communication, base-URL helper
├── compiler-worker.js    Web Worker: toolchain loader + COMPILER ADAPTER
├── serve-local.js        Optional local dev server with correct headers
├── vendor/
│   └── emception/
│       ├── README.md     Instructions for obtaining the compiler bundle
│       ├── emception.js  ← place the bundle here
│       └── *.wasm        ← sibling wasm/data assets
└── README.md             This file
```

---

## Known limitations

| Limitation | Notes |
|---|---|
| Vendor bundle not included | Must be built/downloaded separately (see above). |
| SharedArrayBuffer requirement | Some Emception builds need COOP/COEP headers not available on standard GitHub Pages. |
| Large bundle size | The in-browser compiler is large (50–150 MB); initial load is slow. |
| C standard library | Only the subset emulated by Emscripten is available; no OS syscalls. |
| No filesystem persistence | The Emscripten virtual FS is reset on each page reload. |
| Single-file programs only | The UI compiles one `main.c`; multi-file projects are not supported in this demo. |
| Adapter may need tuning | If you use a bundle other than Emception, update `compiler-worker.js`. |

---

## Adapter contract

The `compiler-worker.js` file contains a clearly marked **COMPILER ADAPTER**
section.  This is the only part of the code that directly calls the in-browser
Emscripten API.  Updating it to match a different bundle requires changing
three functions:

- `loadToolchain(baseUrl)` — how to load + instantiate the bundle.
- `compileSource(source)`  — how to invoke `emcc` and read the output.
- `runArtifact(artifact)`  — how to execute the compiled Wasm in-browser.

Everything else (UI, Worker communication, base-URL resolution) is
bundle-agnostic.