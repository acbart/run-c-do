/**
 * app.js — run-c-do
 *
 * Architecture
 * ────────────
 * Compilation is intentionally offloaded to a Web Worker (compiler-worker.js)
 * for two reasons:
 *   1. The in-browser Emscripten/Clang toolchain is CPU-intensive and would
 *      freeze the UI thread for seconds if run inline.
 *   2. Many Emscripten bundles rely on SharedArrayBuffer / Atomics for their
 *      own internal threading; running them in a Worker is the supported path.
 *
 * This file is responsible for:
 *   - Wiring up the UI (buttons, textarea, output panels).
 *   - Spawning the compiler Worker and communicating via postMessage.
 *   - Holding the compiled Wasm/JS artifact in memory between compile and run.
 *   - Providing a robust base-URL helper so the project works from any GitHub
 *     Pages subpath (e.g. https://user.github.io/run-c-do/).
 *
 * Message protocol (main → worker):
 *   { type: "compile", source: "<c source string>", baseUrl: "<string>" }
 *   { type: "run",     artifact: <object from compile result>            }
 *
 * Message protocol (worker → main):
 *   { type: "status",  message: "<string>", level: "info"|"error" }
 *   { type: "compile-result",  ok: bool, stdout: string, artifact: any }
 *   { type: "run-result",      ok: bool, stdout: string, stderr: string }
 */

"use strict";

/* ── Base-URL helper ──────────────────────────────────────────────────────
 * Resolves paths relative to wherever index.html is hosted.
 * This is necessary for GitHub Pages where the repo lives under a subpath,
 * e.g. https://username.github.io/run-c-do/.
 * We derive the base from the current page URL so that asset loads such as
 * the compiler worker and vendor Wasm files always resolve correctly.
 */
function getBaseUrl() {
  const loc = window.location.href;
  // Strip the filename (if any) from the path, keep the trailing slash.
  return loc.substring(0, loc.lastIndexOf("/") + 1);
}

/* ── DOM references ────────────────────────────────────────────────────── */
const editorEl         = document.getElementById("code-editor");
const btnCompile       = document.getElementById("btn-compile");
const btnRun           = document.getElementById("btn-run");
const statusEl         = document.getElementById("status-msg");
const compilerOutputEl = document.getElementById("compiler-output");
const programOutputEl  = document.getElementById("program-output");

/* ── Application state ─────────────────────────────────────────────────── */
let worker        = null;   // The compiler Web Worker instance
let compiledArtifact = null; // Holds the artifact produced by a successful compile
let workerReady   = false;  // True once the worker has loaded the toolchain

/* ── Status display helper ─────────────────────────────────────────────── */
const STATUS_CLASSES = ["idle", "loading", "compiling", "success", "error", "running"];

function setStatus(message, level = "idle") {
  statusEl.textContent = message;
  STATUS_CLASSES.forEach(c => statusEl.classList.remove(c));
  statusEl.classList.add(level);
}

function appendCompilerOutput(text) {
  compilerOutputEl.textContent += text;
  compilerOutputEl.scrollTop = compilerOutputEl.scrollHeight;
}

function clearOutputs() {
  compilerOutputEl.textContent = "";
  programOutputEl.textContent  = "";
}

/* ── Worker lifecycle ──────────────────────────────────────────────────── */
function initWorker() {
  const baseUrl = getBaseUrl();
  // Resolve the worker script URL relative to index.html so that it works
  // on GitHub Pages subpaths and during local development alike.
  const workerUrl = baseUrl + "compiler-worker.js";

  try {
    worker = new Worker(workerUrl);
  } catch (err) {
    setStatus("Failed to start compiler worker", "error");
    appendCompilerOutput(
      "ERROR: Could not create Web Worker from " + workerUrl + "\n" +
      err.message + "\n\n" +
      "If you are opening index.html directly from the filesystem (file://),\n" +
      "some browsers block Workers. Use a local HTTP server instead.\n" +
      "See README.md for instructions.\n"
    );
    btnCompile.disabled = true;
    return;
  }

  worker.addEventListener("message", handleWorkerMessage);

  worker.addEventListener("error", (event) => {
    setStatus("Worker error", "error");
    appendCompilerOutput(
      "Worker uncaught error: " + (event.message || String(event)) + "\n"
    );
    enableControls(true);
  });

  // Ask the worker to initialise the toolchain immediately so it is warm
  // by the time the user clicks Compile.
  setStatus("Loading toolchain…", "loading");
  worker.postMessage({ type: "init", baseUrl });
}

/* ── Worker message handler ────────────────────────────────────────────── */
function handleWorkerMessage(event) {
  const msg = event.data;

  switch (msg.type) {
    case "ready":
      // The worker has finished loading the compiler bundle.
      workerReady = true;
      setStatus("Toolchain ready", "success");
      enableControls(true);
      break;

    case "init-error":
      // The worker could not load the compiler bundle.
      setStatus("Toolchain load failed", "error");
      appendCompilerOutput(
        "ERROR: The compiler toolchain could not be loaded.\n" +
        (msg.message || "") + "\n\n" +
        "Make sure the vendor/emception/ assets are present.\n" +
        "See README.md → 'Placing vendor compiler assets' for instructions.\n"
      );
      btnCompile.disabled = true;
      break;

    case "status":
      // Informational messages emitted during compilation.
      if (msg.level === "error") {
        appendCompilerOutput("[error] " + msg.message + "\n");
      } else {
        appendCompilerOutput(msg.message + "\n");
      }
      break;

    case "compile-result":
      enableControls(true);
      if (msg.ok) {
        compiledArtifact = msg.artifact;
        btnRun.disabled  = false;
        setStatus("Compile succeeded ✓", "success");
      } else {
        compiledArtifact = null;
        btnRun.disabled  = true;
        setStatus("Compile failed ✗", "error");
      }
      break;

    case "run-result":
      enableControls(true);
      setStatus(msg.ok ? "Run complete" : "Run failed", msg.ok ? "success" : "error");
      programOutputEl.textContent =
        (msg.stdout || "") + (msg.stderr ? "\n[stderr]\n" + msg.stderr : "");
      break;

    default:
      console.warn("run-c-do: unknown message from worker:", msg);
  }
}

/* ── Button handlers ───────────────────────────────────────────────────── */
function enableControls(enabled) {
  btnCompile.disabled = !enabled;
  // Run is only ever enabled if we also have a compiled artifact.
  btnRun.disabled = !enabled || !compiledArtifact;
}

btnCompile.addEventListener("click", () => {
  if (!worker) return;

  clearOutputs();
  compiledArtifact = null;
  btnRun.disabled  = true;
  enableControls(false);
  setStatus("Compiling…", "compiling");

  const source  = editorEl.value;
  const baseUrl = getBaseUrl();

  worker.postMessage({ type: "compile", source, baseUrl });
});

btnRun.addEventListener("click", () => {
  if (!worker || !compiledArtifact) return;

  programOutputEl.textContent = "";
  enableControls(false);
  setStatus("Running…", "running");

  worker.postMessage({ type: "run", artifact: compiledArtifact });
});

/* ── Bootstrap ─────────────────────────────────────────────────────────── */
// Disable controls until the worker reports it is ready.
enableControls(false);
setStatus("Initialising…", "loading");
initWorker();
