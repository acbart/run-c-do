# vendor/emception/

This directory must contain the browser-port of the Emscripten/Clang toolchain.

## How to obtain the assets

run-c-do depends on **Emception** (or a compatible in-browser Emscripten bundle).
The assets cannot be redistributed in this repo because of their size and
licensing; you must build or download them separately.

### Option A — build Emception yourself

1. Clone Emception: `git clone https://github.com/nicowillis/emception`
2. Follow Emception's build instructions to produce the browser bundle.
3. Copy the following files into this directory:
   - `emception.js`   — the main bundle entry point
   - `*.wasm`         — all sibling WebAssembly files
   - Any other data files produced by the build (`.data`, etc.)

### Option B — download a pre-built release

Check Emception's Releases page for a pre-built bundle and unzip it here.

## Expected file layout after setup

```
vendor/
└── emception/
    ├── emception.js        ← loaded by compiler-worker.js via importScripts()
    ├── clang.wasm          ← Clang compiled to Wasm
    ├── lld.wasm            ← LLD linker compiled to Wasm
    ├── emscripten-...      ← other toolchain components
    └── ...
```

## Adapter notes

If you use a bundle with a different API surface, update the **COMPILER ADAPTER**
section in `compiler-worker.js`.  The two functions to adjust are:

- `loadToolchain()` — how the bundle is loaded and initialised.
- `compileSource()` — how `emcc` is invoked and output is read.
- `runArtifact()`   — how the compiled Wasm program is executed.
