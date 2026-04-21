/**
 * serve-local.js — run-c-do local development server
 *
 * Serves the project at http://localhost:8080 with the Cross-Origin
 * isolation headers required by certain Emception builds that use
 * SharedArrayBuffer internally.
 *
 * Usage:
 *   node serve-local.js
 *
 * Requirements: Node.js >= 14 (no extra dependencies needed).
 */

"use strict";

const http = require("http");
const fs   = require("fs");
const path = require("path");

const PORT    = process.env.PORT || 8080;
const ROOT    = __dirname;

/** Map file extensions to MIME types. */
const MIME = {
  ".html":  "text/html; charset=utf-8",
  ".css":   "text/css; charset=utf-8",
  ".js":    "application/javascript; charset=utf-8",
  ".mjs":   "application/javascript; charset=utf-8",
  ".wasm":  "application/wasm",
  ".json":  "application/json; charset=utf-8",
  ".data":  "application/octet-stream",
  ".map":   "application/json; charset=utf-8",
  ".txt":   "text/plain; charset=utf-8",
  ".md":    "text/markdown; charset=utf-8",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".ico":   "image/x-icon",
};

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, "http://localhost");
  let   filePath  = path.join(ROOT, parsedUrl.pathname);

  // Serve index.html for bare directory requests.
  if (filePath.endsWith(path.sep) || (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory())) {
    filePath = path.join(filePath, "index.html");
  }

  // Security: prevent path traversal outside the project root.
  const relative = path.relative(ROOT, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === "ENOENT") {
        res.writeHead(404);
        res.end("404 Not Found: " + parsedUrl.pathname);
      } else {
        res.writeHead(500);
        res.end("Server error: " + err.message);
      }
      return;
    }

    const ext      = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type":                mimeType,
      // These two headers enable SharedArrayBuffer in the browser.
      // They are required by some Emception bundle variants.
      "Cross-Origin-Opener-Policy":  "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`run-c-do local server running at http://localhost:${PORT}`);
  console.log("Press Ctrl+C to stop.");
});
