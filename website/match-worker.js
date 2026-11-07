/**
 * Web Worker that runs DpiMatcher.runMatch off the main thread.
 *
 * No network, database or DOM access here: it only receives a cohort + options and posts
 * back the (structured-cloneable) result. The importScripts versions must match
 * ADMIN_BUNDLE in app.js; tests/match-worker.test.mjs enforces that.
 */
"use strict";

let loadError = null;
try {
  importScripts("matcher.js?v=8", "alternate-solvers.js?v=2");
} catch (err) {
  loadError = err;
}

self.onmessage = function (event) {
  try {
    if (loadError) throw loadError;
    const { data, options } = event.data;
    const result = self.DpiMatcher.runMatch(data, options);
    self.postMessage({ ok: true, result });
  } catch (err) {
    self.postMessage({ ok: false, error: (err && err.message) || String(err) });
  }
};
