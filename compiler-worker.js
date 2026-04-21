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
 * and SharedArrayBuffer is only available in cross-origin-isolated contexts
 * which typically require specific response headers.  Using a Worker is the
 * expected runtime environment for these bundles.
 *
 * ══════════════════════════════════════════════════════════
 *  COMPILER ADAPTER — this is where you wire up the bundle
 * ══════════════════════════════════════════════════════════
 *
 * Different in-browser Emscripten distributions expose slightly different
 * APIs.  The section labelled "COMPILER ADAPTER" below is the only place
 * you should need to change when swapping between bundles, e.g.:
 *   • Emception  (https://github.com/nicowillis/emception)
 *   • Cheerp
 *   • Any other browser-ported Clang/Emscripten variant
 *
 * The adapter contract (what this worker expects from the bundle):
 *   - A global or exported `Emception` object (or equivalent) that exposes:
 *       emception.run(args: string[]) → Promise<{ returncode: number,
 *                                                  stdout: string,
 *                                                  stderr: string }>
 *       emception.FS  — an Emscripten-compatible virtual filesystem
 *   - The bundle is loaded via importScripts() from vendor/emception/emception.js
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
let emception  = null;   // The initialised compiler object (set during "init")
let baseUrl    = "";     // Resolved from the main thread so asset paths work

/** How long (ms) to wait for a compiled program to call onExit before resolving anyway. */
const EXECUTION_TIMEOUT_MS = 5000;

/* ── Utility: post a status message to the UI ────────────────────────── */
function postStatus(message, level = "info") {
  self.postMessage({ type: "status", message, level });
}

/* ══════════════════════════════════════════════════════════
 *  COMPILER ADAPTER — adapt this section to your bundle
 * ══════════════════════════════════════════════════════════ */

/**
 * loadToolchain(baseUrl)
 *
 * Loads the in-browser Emscripten/Clang bundle via importScripts().
 * Returns the initialised compiler object.
 *
 * ASSUMPTION: The bundle exposes a global `Emception` constructor/factory
 * and expects to be loaded from the same directory as its wasm/data siblings.
 *
 * If you use a different bundle, adjust:
 *   1. The importScripts() path.
 *   2. How the bundle is instantiated (new Emception() vs a factory call).
 *   3. The API calls in compileSource() and runArtifact().
 */
async function loadToolchain(base) {
  // `base` is derived from `window.location.href` in app.js — it is the
  // origin + path of the hosting page, never a value typed by the user.
  // It is used solely to construct a same-origin URL for the vendor bundle.
  const scriptUrl = base + "vendor/emception/emception.js";

  postStatus("Loading compiler bundle from: " + scriptUrl);

  // importScripts() is synchronous in Workers.
  // It will throw if the script cannot be fetched.
  try {
    importScripts(scriptUrl);
  } catch (err) {
    throw new Error(
      "Could not load vendor/emception/emception.js\n" +
      "Make sure you have placed the Emception bundle under vendor/emception/.\n" +
      "See README.md for instructions.\n" +
      "Original error: " + err.message
    );
  }

  // ── Adapt this instantiation to your specific bundle ──────────────────
  // Emception-style: the script exposes a global `Emception` async factory.
  // Adjust if your bundle uses a different export name or pattern.
  if (typeof Emception === "undefined") {
    throw new Error(
      "After loading vendor/emception/emception.js, the global `Emception` " +
      "symbol was not found.  Check that the bundle is an Emception-compatible " +
      "distribution and update the adapter in compiler-worker.js if needed."
    );
  }

  postStatus("Initialising compiler…");

  // Emception expects to receive the base path so it can locate its own
  // sibling .wasm and data assets.  Adjust the option name/value to match
  // the bundle you are using.
  const instance = await Emception({
    // Some builds accept a locateFile callback; others use a hardcoded path.
    // Use locateFile to redirect wasm/data sibling files:
    locateFile(filename) {
      return base + "vendor/emception/" + filename;
    },
  });

  return instance;
}

/**
 * compileSource(source)
 *
 * Writes the C source into the virtual FS and invokes the compiler.
 * Returns { ok, stdout, artifact } where artifact is whatever we
 * need to pass back to runArtifact().
 *
 * ASSUMPTION: Emception exposes:
 *   emception.FS.writeFile(path, data)
 *   emception.run(args)  → Promise<{ returncode, stdout, stderr }>
 *   Output is a .js + .wasm pair written to /output/a.out.js
 *
 * Adjust paths and API calls if your bundle works differently.
 */
async function compileSource(source) {
  const inputPath  = "/input/main.c";
  const outputBase = "/output/a.out";
  const outputJs   = outputBase + ".js";
  const outputWasm = outputBase + ".wasm";

  // ── Write source into the virtual filesystem ──────────────────────────
  try {
    // Ensure directories exist (Emscripten FS may or may not pre-create them).
    try { emception.FS.mkdir("/input");  } catch (_) { /* already exists */ }
    try { emception.FS.mkdir("/output"); } catch (_) { /* already exists */ }

    emception.FS.writeFile(inputPath, source);
  } catch (err) {
    throw new Error("FS write error: " + err.message);
  }

  // ── Invoke the compiler ───────────────────────────────────────────────
  // This is the Emception API.  Other bundles may use a different method
  // name or argument structure.
  postStatus("Running emcc…");

  const result = await emception.run([
    "emcc",
    inputPath,
    "-o", outputJs,
    // Produce a JavaScript + WebAssembly output pair that can be run with
    // the Emscripten JS runtime.
    "-s", "ENVIRONMENT=web,worker",
    "-O1",
  ]);

  const combinedOutput = [result.stdout, result.stderr]
    .filter(Boolean)
    .join("\n");

  if (result.returncode !== 0) {
    return { ok: false, stdout: combinedOutput, artifact: null };
  }

  // ── Read back the compiled artifact ──────────────────────────────────
  let jsText   = null;
  let wasmData = null;

  try {
    jsText   = emception.FS.readFile(outputJs,   { encoding: "utf8" });
    wasmData = emception.FS.readFile(outputWasm,  { encoding: "binary" });
  } catch (err) {
    return {
      ok: false,
      stdout: combinedOutput + "\nFailed to read compiler output: " + err.message,
      artifact: null,
    };
  }

  return {
    ok:       true,
    stdout:   combinedOutput || "(no compiler output)",
    artifact: { jsText, wasmData },
  };
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
        emception = await loadToolchain(baseUrl);
        self.postMessage({ type: "ready" });
      } catch (err) {
        self.postMessage({ type: "init-error", message: err.message });
      }
      break;
    }

    /* ── compile: compile C source ────────────────────────────────────── */
    case "compile": {
      if (!emception) {
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
