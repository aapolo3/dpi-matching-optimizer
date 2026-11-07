// Loads website/app.js in a vm with stubbed DOM + Firebase (no emulator, no network)
// to check that admin exports/builds read live caches, not first-snapshot data.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";

function stubEl() {
  const fn = function () {};
  const p = new Proxy(fn, {
    get(_t, k) {
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "length") return 0;
      if (k === "then") return undefined;
      if (k === Symbol.iterator) return function* () {};
      return p;
    },
    set() { return true; },
    apply() { return p; },
  });
  return p;
}

function harness({ failSrc } = {}) {
  const listeners = {};
  const loaded = []; // script srcs appended, in order
  let authCb;
  const db = {
    collection(name) {
      return {
        onSnapshot(ok, err) { listeners[name] = { ok, err }; return () => { listeners[name] = null; }; },
        doc() {
          return { get: async () => ({ exists: true, data: () => ({ role: "admin" }) }) };
        },
      };
    },
  };
  const firebase = {
    initializeApp: () => ({}),
    auth: Object.assign(() => ({ onAuthStateChanged: (cb) => { authCb = cb; } }), {
      GoogleAuthProvider: function () {},
    }),
    firestore: Object.assign(() => db, { FieldValue: { serverTimestamp: () => 0 } }),
    storage: () => ({}),
  };
  const window = {
    FIREBASE_CONFIG: {},
    DpiCohort: {
      HOST_COLUMNS: [], STUDENT_COLUMNS: [],
      projectDocToRow: (p) => ({ id: p.id }),
      studentDocToRow: (s) => ({ id: s.id }),
      objectsToTable: (rows) => rows,
      buildCohort: (hosts, students) => ({ hosts, students }),
    },
    addEventListener() {},
  };
  const base = stubEl();
  const studentsList = { innerHTML: "" };
  // Appended scripts load (or fail) on the next tick, like a browser would.
  const bodyOps = {
    appendChild(el) {
      loaded.push(el.src);
      setTimeout(() => {
        if (failSrc && failSrc.has(el.src)) {
          failSrc.delete(el.src); // fail once, so a retry can succeed
          el.onerror();
        } else {
          el.onload();
        }
      }, 0);
    },
  };
  const body = new Proxy(base, { get: (t, k) => (k in bodyOps ? bodyOps[k] : t[k]) });
  const document = new Proxy(base, {
    get(t, k) {
      if (k === "createElement") return () => ({});
      if (k === "body") return body;
      if (k === "getElementById") return (id) => (id === "admin-students-list" ? studentsList : base);
      return t[k];
    },
  });
  const ctx = vm.createContext({ window, document, firebase, console, setTimeout, clearTimeout, URL, Promise, Date });
  vm.runInContext(fs.readFileSync("website/app.js", "utf8"), ctx);
  const snap = (docs) => ({ docs: docs.map((d) => ({ id: d.id, data: () => ({ ...d, id: undefined }) })) });
  return { window, listeners, loaded, snap, studentsList, signIn: (uid) => authCb(uid ? { uid, email: "a@b.c" } : null) };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

test("build reflects snapshots that arrive after the first", async () => {
  const h = harness();
  await h.signIn("admin1");
  await tick();
  // Build must start listeners itself (admin role loaded) and wait for first snapshots.
  const first = h.window.DpiAdminData.buildCohortFromFirestore();
  await tick();
  h.listeners.projects.ok(h.snap([{ id: "p1" }]));
  h.listeners.students.ok(h.snap([{ id: "s1" }]));
  const a = await first;
  assert.equal(a.students.length, 1);
  h.listeners.students.ok(h.snap([{ id: "s1" }, { id: "s2" }]));
  const b = await h.window.DpiAdminData.buildCohortFromFirestore();
  assert.equal(b.students.length, 2);
});

test("call pending at auth change rejects instead of hanging", async () => {
  const h = harness();
  await h.signIn("admin1");
  await tick();
  await h.window.DpiAdminData.loadAdminBundle();
  const pending = h.window.DpiAdminData.buildCohortFromFirestore();
  const outcome = pending.then(() => "resolved", (e) => e.message);
  await tick(); // let it get past the bundle load and into the roster wait
  await h.signIn(null);
  assert.equal(await outcome, "Admin session changed");
});

test("listener error reaches the caller instead of a session-changed error", async () => {
  const h = harness();
  await h.signIn("admin1");
  await tick();
  await h.window.DpiAdminData.loadAdminBundle();
  const pending = h.window.DpiAdminData.buildCohortFromFirestore();
  const outcome = pending.then(() => "resolved", (e) => e.message);
  await tick();
  h.listeners.projects.err(new Error("quota exceeded"));
  assert.equal(await outcome, "quota exceeded");
  // Listeners were still torn down, so the next call subscribes again and works.
  const retry = h.window.DpiAdminData.buildCohortFromFirestore();
  await tick();
  h.listeners.projects.ok(h.snap([{ id: "p1" }]));
  h.listeners.students.ok(h.snap([{ id: "s1" }]));
  assert.equal((await retry).students.length, 1);
});

test("non-list projectChoices cannot inject HTML or break the roster", async () => {
  const h = harness();
  await h.signIn("admin1");
  await tick();
  await h.window.DpiAdminData.loadAdminBundle();
  const payload = "<img src=x onerror=alert(1)>";
  const pending = h.window.DpiAdminData.buildCohortFromFirestore();
  await tick();
  h.listeners.projects.ok(h.snap([]));
  h.listeners.students.ok(h.snap([
    { id: "s1", projectChoices: { length: payload } },
    { id: "s2", projectChoices: payload },
    { id: "s3", projectChoices: [{ docId: "p1" }, { docId: "p2" }] },
  ]));
  const built = await pending;
  assert.equal(built.students.length, 3);
  const html = h.studentsList.innerHTML;
  assert.equal(html.includes("onerror"), false, html);
  assert.equal((html.match(/ 0 ranked project/g) || []).length, 2);
  assert.equal((html.match(/ 2 ranked project/g) || []).length, 1);
});

const BUNDLE = [
  "vendor/xlsx-0.20.3.full.min.js?v=1",
  "xlsx-cohort.js?v=4",
  "matcher.js?v=8",
  "alternate-solvers.js?v=2",
  "match-demo.js?v=11",
];

test("loadAdminBundle loads scripts in order and memoizes", async () => {
  const h = harness();
  const a = h.window.DpiAdminData.loadAdminBundle();
  const b = h.window.DpiAdminData.loadAdminBundle();
  assert.equal(a, b);
  await a;
  await h.window.DpiAdminData.loadAdminBundle();
  assert.deepEqual(h.loaded, BUNDLE);
});

test("loadAdminBundle rejects on script error and a later call retries", async () => {
  const h = harness({ failSrc: new Set(["matcher.js?v=8"]) });
  await assert.rejects(h.window.DpiAdminData.loadAdminBundle(), /Could not load matcher\.js/);
  // Nothing after the failed script was requested.
  assert.deepEqual(h.loaded, BUNDLE.slice(0, 3));
  await h.window.DpiAdminData.loadAdminBundle();
  assert.deepEqual(h.loaded.slice(3), BUNDLE.slice(2)); // earlier scripts not re-run
});
