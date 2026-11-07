// The solver must resolve its global as `self` (Web Worker) as well as `window`,
// and runMatch's result must survive postMessage (structured clone).
import test from "node:test";
import assert from "node:assert/strict";
import legacy from "node:assert";
import vm from "node:vm";
import fs from "node:fs";

function readFile(path) {
  const b = fs.readFileSync(path);
  return { name: path, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}

async function fixedCohort() {
  const window = {};
  const ctx = vm.createContext({ window, console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Date, setTimeout });
  vm.runInContext(fs.readFileSync("website/vendor/xlsx-0.20.3.full.min.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("website/xlsx-cohort.js", "utf8"), ctx);
  const C = window.DpiCohort;
  const hosts = await C.readWorkbook(readFile("demo/generated_hosts.xlsx"));
  const students = await C.readWorkbook(readFile("demo/generated_students.xlsx"));
  return C.buildCohort(hosts, students).cohort;
}

// Worker-like context: `self` is the global, no `window`.
function workerContext() {
  const self = {};
  const ctx = vm.createContext({ self, console, Date, performance, setTimeout });
  for (const f of ["matcher.js", "alternate-solvers.js"]) {
    vm.runInContext(fs.readFileSync("website/" + f, "utf8"), ctx, { filename: f });
  }
  return self;
}

test("solvers load with self as the global and results structured-clone", async () => {
  const cohort = await fixedCohort();
  const self = workerContext();
  assert.equal(typeof self.DpiMatcher.runMatch, "function");
  assert.equal(typeof self.DpiAlternateSolvers.solveHungarian, "function");
  // hungarian is deterministic (no time budget), so two runs must agree.
  const opts = { topK: 1, solver: "hungarian" };
  const a = self.DpiMatcher.runMatch(structuredClone(cohort), opts);
  const b = self.DpiMatcher.runMatch(structuredClone(cohort), opts);
  assert.ok(a.solutions.length > 0);
  // vm objects have another realm's prototypes, so use the loose comparison.
  legacy.deepEqual(structuredClone(a), a);
  assert.deepEqual(a.solutions[0].assignments, b.solutions[0].assignments);
  assert.equal(a.solutions[0].score, b.solutions[0].score);
});

test("worker importScripts versions match ADMIN_BUNDLE and worker has no Firebase", () => {
  const app = fs.readFileSync("website/app.js", "utf8");
  const worker = fs.readFileSync("website/match-worker.js", "utf8");
  const demo = fs.readFileSync("website/match-demo.js", "utf8");
  const bundle = app.match(/const ADMIN_BUNDLE = \[([\s\S]*?)\];/)[1];
  const imported = worker.match(/importScripts\(([^)]*)\)/)[1].match(/[\w.-]+\.js\?v=\d+/g);
  assert.equal(imported.length, 2);
  for (const src of imported) assert.ok(bundle.includes('"' + src + '"'), src + " not in ADMIN_BUNDLE");
  assert.ok(!/firebase|firestore/i.test(worker));
  const wsrc = demo.match(/MATCH_WORKER_SRC = "([^"]+)"/)[1];
  assert.equal(wsrc, "match-worker.js?v=1");
});
