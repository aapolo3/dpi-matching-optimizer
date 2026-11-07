// Runs the vendored SheetJS plus website/xlsx-cohort.js in a vm to check that
// the demo workbooks still parse into a cohort (catches SheetJS API breakage).
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

function load() {
  const window = {};
  const ctx = vm.createContext({ window, console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, Date, setTimeout });
  vm.runInContext(fs.readFileSync("website/vendor/xlsx-0.20.3.full.min.js", "utf8"), ctx);
  vm.runInContext(fs.readFileSync("website/xlsx-cohort.js", "utf8"), ctx);
  return { ctx, cohort: window.DpiCohort, XLSX: vm.runInContext("XLSX", ctx) };
}

const file = (path) => {
  const b = fs.readFileSync(path);
  return { name: path, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
};

test("SheetJS is 0.20.3", () => {
  assert.equal(load().XLSX.version, "0.20.3");
});

test("demo workbooks parse into a cohort", async () => {
  const { cohort } = load();
  const hosts = await cohort.readWorkbook(file("demo/generated_hosts.xlsx"));
  const students = await cohort.readWorkbook(file("demo/generated_students.xlsx"));
  assert.equal(hosts.rows.length, 36);
  assert.equal(students.rows.length, 150);
  const built = cohort.buildCohort(hosts, students);
  assert.equal(built.cohort.projects.length, 36);
  assert.equal(built.cohort.users_students.length, 150);
});

test("workbook write/read round trip", () => {
  const { XLSX } = load();
  const ws = XLSX.utils.aoa_to_sheet([["a", "b"], [1, "x"]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "S");
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  const back = XLSX.read(out, { type: "array" });
  assert.equal(JSON.stringify(XLSX.utils.sheet_to_json(back.Sheets.S, { header: 1 })), '[["a","b"],[1,"x"]]');
});
