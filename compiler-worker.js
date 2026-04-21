/**
 * compiler-worker.js — run-c-do
 *
 * This script runs in a dedicated Web Worker, completely off the UI thread.
 *
 * Why a Worker?
 * ─────────────
 * Compiling C even for tiny programs can take several seconds of CPU time
 * when using an in-browser Emscripten/Clang bundle.  Running that work on
 * the main thread would freeze the browser tab.  A Worker lets the UI stay
 * responsive (status messages, scroll, etc.) while compilation proceeds.
 *
 * Additionally, some in-browser Emscripten distributions (notably Emception)
 * depend on SharedArrayBuffer and Atomics for their own internal threading,
 * and SharedArrayBuffer is only available in cross-origin-isolated contexts.
 * The coi-serviceworker.js shim (loaded by index.html) adds the necessary
 * Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers on
 * GitHub Pages so SharedArrayBuffer is available.
 *
 * ══════════════════════════════════════════════════════════
 *  COMPILER ADAPTER — this is where you wire up the bundle
 * ══════════════════════════════════════════════════════════
 *
 * This adapter uses the pre-built Emception bundle from
 * vendor/emception/emception.worker.bundle.worker.js.  That bundle is
 * produced by the deploy workflow (see .github/workflows/deploy.yml) by
 * cloning the jprendes/emception demo branch.
 *
 * Architecture
 * ────────────
 * The Emception bundle was built by the emception/playground project and
 * exposes a Comlink-proxied Emception instance.  We create a *nested*
 * Web Worker (a Worker spawned from within this Worker) that runs the
 * Emception bundle, then communicate with it using Comlink:
 *
 *   app.js  ──postMessage──►  compiler-worker.js  ──Comlink──►  emception-worker
 *           ◄──postMessage──                       ◄──Comlink──
 *
 * The Emception bundle is patched by the deploy workflow to add a
 * compileSource(source) method that handles writing to/reading from the
 * virtual FS internally, so we never need to access the FS directly from
 * this side of the Comlink boundary.
 *
 * ══════════════════════════════════════════════════════════
 *
 * Message protocol (received from main thread):
 *   { type: "init",    baseUrl: string }
 *   { type: "compile", source: string, baseUrl: string }
 *   { type: "run",     artifact: object }
 *
 * Message protocol (sent to main thread):
 *   { type: "ready" }
 *   { type: "init-error", message: string }
 *   { type: "status",     message: string, level: "info"|"error" }
 *   { type: "compile-result", ok: bool, artifact: object|null, stdout: string }
 *   { type: "run-result",     ok: bool, stdout: string, stderr: string }
 */

"use strict";

/* ── Worker globals ──────────────────────────────────────────────────── */
let emceptionProxy = null; // Comlink proxy to the nested Emception worker
let baseUrl        = "";   // Resolved from the main thread so asset paths work

/** How long (ms) to wait for a compiled program to call onExit before resolving anyway. */
const EXECUTION_TIMEOUT_MS = 5000;

/* ── Utility: post a status message to the UI ────────────────────────── */
function postStatus(message, level = "info") {
  self.postMessage({ type: "status", message, level });
}

/* ══════════════════════════════════════════════════════════
 *  COMPILER ADAPTER — Emception via nested Worker + Comlink
 * ══════════════════════════════════════════════════════════
 *
 * The Emception bundle (vendor/emception/emception.worker.bundle.worker.js)
 * is a self-contained webpack bundle that:
 *   1. Creates an Emception instance (the in-browser Emscripten/Clang toolchain).
 *   2. Exposes it via Comlink so the caller can invoke methods across the
 *      Worker boundary using standard async/await.
 *
 * The deploy workflow patches the bundle with a compileSource(source) helper
 * that handles virtual-FS I/O internally, so we never need to cross the
 * Comlink boundary to touch the FS directly.
 *
 * All communication between this worker and the nested Emception worker uses
 * Comlink (vendor/comlink.umd.min.js).  Comlink is loaded via importScripts()
 * once during loadToolchain() and exposes the global `Comlink` object.
 */

/**
 * loadToolchain(base)
 *
 * 1. Loads Comlink via importScripts().
 * 2. Creates a nested Worker running the Emception bundle.
 * 3. Wraps it with Comlink.wrap() to obtain an async proxy.
 * 4. Calls proxy.init() to boot the in-browser toolchain (fetches packs, etc.).
 */
async function loadToolchain(base) {
  // Derive the base URL from the worker script's own URL (self.location).
  // This is always the correct same-origin path and does not depend on any
  // value sent from outside the worker, which eliminates any URL-redirection
  // risk from an untrusted message payload.
  const workerBase = self.location.href.substring(
    0,
    self.location.href.lastIndexOf("/") + 1
  );

  // Load Comlink — exposes the global `Comlink` object in this worker scope.
  importScripts(workerBase + "vendor/comlink.umd.min.js");

  const bundleUrl = workerBase + "vendor/emception/emception.worker.bundle.worker.js";
  postStatus("Starting Emception worker…");

  // Create the nested Worker.  Nested workers (Workers spawned from within a
  // Worker) are supported in all modern browsers.
  let nestedWorker;
  try {
    nestedWorker = new Worker(bundleUrl);
  } catch (err) {
    throw new Error(
      "Could not create nested Worker from " + bundleUrl + "\n" +
      "Make sure the deploy workflow has run and vendor/emception/ is populated.\n" +
      "Original error: " + err.message
    );
  }

  // Wrap the worker with Comlink so every method call becomes an async RPC.
  emceptionProxy = Comlink.wrap(nestedWorker);

  postStatus("Initialising compiler (first load fetches toolchain data, please wait)…");

  // init() sets up the virtual filesystem, installs the lazy-load packs, and
  // preloads the core emscripten / cpython / wasm packs.  This is the slow
  // step on first load; subsequent loads benefit from the browser cache.
  await emceptionProxy.init();
}

/**
 * compileSource(source)
 *
 * Delegates entirely to the patched compileSource() method on the Emception
 * proxy.  That method (injected by the deploy workflow) handles:
 *   - Writing the C source into /working/main.c in the virtual FS.
 *   - Running emcc against it.
 *   - Reading back the compiled .js and .wasm artifacts.
 *
 * Returns { ok, stdout, artifact: { jsText, wasmData } | null }.
 */
async function compileSource(source) {
  postStatus("Running emcc…");
  // The proxy call crosses the Comlink boundary into the nested Worker.
  // The return value is structured-cloned back (strings and Uint8Array are
  // both safe to transfer through postMessage).
  return emceptionProxy.compileSource(source);
}

/**
 * runArtifact(artifact)
 *
 * Executes the compiled Wasm program in-browser.
 * Returns { ok, stdout, stderr }.
 *
 * ASSUMPTION: The compiler produced an Emscripten JS+Wasm pair.
 * We execute it by:
 *   1. Injecting the compiled JS into a new Function scope so we can
 *      intercept Emscripten's Module.print / Module.printErr hooks.
 *   2. Passing the wasm binary directly via Module.wasmBinary to avoid
 *      any network fetch.
 *
 * This is the standard "run Emscripten output in a Worker" pattern.
 * Adjust if your bundle produces a different output format.
 */
async function runArtifact(artifact) {
  const stdoutLines = [];
  const stderrLines = [];

  return new Promise((resolve) => {
    try {
      // Build an Emscripten Module object that captures output.
      const Module = {
        // Capture stdout
        print(text) {
          stdoutLines.push(text);
        },
        // Capture stderr
        printErr(text) {
          stderrLines.push(text);
        },
        // Provide the wasm binary directly so no fetch is needed.
        wasmBinary: artifact.wasmData,
        // Called by the generated JS when execution finishes.
        onExit(code) {
          clearTimeout(fallbackTimer);
          resolve({
            ok:     code === 0,
            stdout: stdoutLines.join("\n"),
            stderr: stderrLines.join("\n"),
          });
        },
        // Prevent the generated JS from trying to locate the .wasm file
        // via a URL — we are supplying it directly above.
        locateFile(path) {
          return path; // Unused because wasmBinary is set, but required.
        },
      };

      // If onExit is never called (e.g. the program exits without an explicit
      // exit() call, or the Emscripten module is async), resolve after a short
      // timeout so the UI doesn't hang.  We set up the timer BEFORE running
      // so that onExit can cancel it and avoid double-resolution.
      const fallbackTimer = setTimeout(() => {
        resolve({
          ok:     true,
          stdout: stdoutLines.join("\n"),
          stderr: stderrLines.join("\n"),
        });
      }, EXECUTION_TIMEOUT_MS);

      /**
       * Execute the compiled Emscripten output.
       * Security note: `artifact.jsText` is the JavaScript emitted by the
       * in-browser Emscripten compiler from the user's C source.  It is
       * compiler-generated output, not raw user input, and never travels over
       * the network.  `new Function` is the standard way to evaluate
       * Emscripten-generated JS in a controlled scope so we can inject the
       * Module object with custom print/onExit hooks.
       */
      // eslint-disable-next-line no-new-func
      const runFn = new Function("Module", artifact.jsText);
      runFn(Module);
    } catch (err) {
      resolve({
        ok:     false,
        stdout: stdoutLines.join("\n"),
        stderr: stderrLines.join("\n") + "\nRuntime error: " + err.message,
      });
    }
  });
}

/* ══════════════════════════════════════════════════════════
 *  END COMPILER ADAPTER
 * ══════════════════════════════════════════════════════════ */

/* ── Message handler ─────────────────────────────────────────────────── */
self.addEventListener("message", async (event) => {
  const msg = event.data;

  switch (msg.type) {

    /* ── init: load the toolchain ──────────────────────────────────────── */
    case "init": {
      baseUrl = msg.baseUrl || "";
      try {
        await loadToolchain(baseUrl);
        self.postMessage({ type: "ready" });
      } catch (err) {
        self.postMessage({ type: "init-error", message: err.message });
      }
      break;
    }

    /* ── compile: compile C source ────────────────────────────────────── */
    case "compile": {
      if (!emceptionProxy) {
        self.postMessage({
          type:     "compile-result",
          ok:       false,
          stdout:   "Compiler not initialised yet.  Please wait.",
          artifact: null,
        });
        return;
      }
      if (msg.baseUrl) baseUrl = msg.baseUrl;

      try {
        const result = await compileSource(msg.source);
        self.postMessage({
          type:     "compile-result",
          ok:       result.ok,
          stdout:   result.stdout,
          artifact: result.artifact,
        });
      } catch (err) {
        self.postMessage({
          type:     "compile-result",
          ok:       false,
          stdout:   "Internal compiler error: " + err.message,
          artifact: null,
        });
      }
      break;
    }

    /* ── run: execute the compiled artifact ───────────────────────────── */
    case "run": {
      if (!msg.artifact) {
        self.postMessage({
          type:   "run-result",
          ok:     false,
          stdout: "",
          stderr: "No compiled artifact available.  Please compile first.",
        });
        return;
      }

      try {
        const result = await runArtifact(msg.artifact);
        self.postMessage({
          type:   "run-result",
          ok:     result.ok,
          stdout: result.stdout,
          stderr: result.stderr,
        });
      } catch (err) {
        self.postMessage({
          type:   "run-result",
          ok:     false,
          stdout: "",
          stderr: "Internal run error: " + err.message,
        });
      }
      break;
    }

    default:
      console.warn("compiler-worker: unknown message type:", msg.type);
  }
});
