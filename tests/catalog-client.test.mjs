// Runs the real website/app.js against the Firestore emulator and real rules,
// with a stubbed DOM. new Function (not vm) keeps app.js in this realm, because
// the Firestore SDK rejects plain objects from another realm.
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment } from "@firebase/rules-unit-testing";
import firebaseCompat from "firebase/compat/app";
import "firebase/compat/firestore";
import { Timestamp, doc, getDoc, getDocs, collection, setDoc } from "firebase/firestore";

const HOST = "host1";
const ADMIN = "admin1";
const STUDENT = "student1";
const email = (uid) => `${uid}@example.com`;
const appSource = readFileSync("website/app.js", "utf8");

let env;

function stub() {
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

function element() {
  const props = { listeners: {}, textContent: "", innerHTML: "" };
  props.addEventListener = (type, cb) => { (props.listeners[type] ||= []).push(cb); };
  const fallback = stub();
  return new Proxy(props, {
    get: (t, k) => (k in t ? t[k] : fallback[k]),
    set(t, k, v) { t[k] = v; return true; },
  });
}

// Boots app.js as uid. form holds the host form's text field values.
async function boot(uid, form = {}, studentFields = {}) {
  const els = {};
  const byId = (id) => (els[id] ||= element());
  byId("host-form").elements = {
    namedItem: (name) => ({ value: form[name] || "" }),
  };
  let authCb;
  const db = env.authenticatedContext(uid, { email: email(uid) }).firestore();
  const firebase = {
    initializeApp: () => ({}),
    auth: Object.assign(() => ({ onAuthStateChanged: (cb) => { authCb = cb; } }), {
      GoogleAuthProvider: function () {},
    }),
    firestore: Object.assign(() => db, firebaseCompat.firestore),
    storage: () => ({}),
  };
  const window = {
    FIREBASE_CONFIG: {},
    addEventListener() {},
    scrollTo() {},
    DpiCohort: { HOST_COLUMNS: [], STUDENT_COLUMNS: [] },
  };
  const document = new Proxy(stub(), {
    get(t, k) {
      if (k === "getElementById") return byId;
      if (k === "querySelector") return () => null;
      if (k === "querySelectorAll") {
        return (selector) => selector === "[data-student-field]"
          ? Object.entries(studentFields).map(([name, value]) => ({ getAttribute: () => name, value }))
          : [];
      }
      if (k === "createElement") return () => ({});
      return t[k];
    },
  });
  const alert = (msg) => { throw new Error("alert: " + msg); };
  new Function("window", "document", "firebase", "alert", appSource)(
    window, document, firebase, alert
  );
  await authCb({ uid, email: email(uid), displayName: uid });
  const fire = async (id, type) => {
    for (const cb of byId(id).listeners[type]) {
      cb({ preventDefault() {} });
    }
    await settled(byId("host-form-status"));
  };
  return {
    window,
    byId,
    form,
    openHost: async () => {
      window.__demoGo("host");
      await waitFor(() => byId("host-form-status").textContent);
      byId("host-form-status").textContent = "";
    },
    submit: () => fire("host-form", "submit"),
    saveDraft: () => fire("btn-save-draft", "click"),
  };
}

async function waitFor(check) {
  for (let i = 0; i < 300; i += 1) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out waiting");
}

async function poll(check) {
  for (let i = 0; i < 300; i += 1) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out polling");
}

// Saves report through the status line. Rethrow failures so a test can see them.
async function settled(statusEl) {
  await waitFor(() => statusEl.textContent);
  const text = statusEl.textContent;
  statusEl.textContent = "";
  if (!/^(Project submitted|Draft saved)/.test(text)) throw new Error("save failed: " + text);
}

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

async function read(path) {
  let snap;
  await env.withSecurityRulesDisabled(async (ctx) => {
    snap = await getDoc(doc(ctx.firestore(), path));
  });
  return snap.exists() ? snap.data() : null;
}

async function catalogIds() {
  let ids;
  await env.withSecurityRulesDisabled(async (ctx) => {
    ids = (await getDocs(collection(ctx.firestore(), "catalog"))).docs.map((d) => d.id);
  });
  return ids.sort();
}

function studentQuery(uid = STUDENT) {
  return env
    .authenticatedContext(uid, { email: email(uid) })
    .firestore()
    .collection("catalog")
    .where("status", "==", "submitted")
    .get();
}

function legacyProject(extra = {}) {
  return {
    ownerUid: HOST,
    ownerEmail: email(HOST),
    status: "submitted",
    projectTitle: "Legacy",
    companyName: "Old Co",
    retiredField: "keep me",
    ...extra,
  };
}

const FIVE = ["companyName", "createdAt", "ownerUid", "projectTitle", "status"];

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-dpi",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
  });
});

after(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  await seed(`users/${ADMIN}`, { email: email(ADMIN), displayName: "A", role: "admin" });
  await seed(`users/${HOST}`, { email: email(HOST), displayName: "H", role: "host" });
  await seed(`users/${STUDENT}`, { email: email(STUDENT), displayName: "S", role: "student" });
});

test("new submitted project writes a matching catalog entry", async () => {
  const h = await boot(HOST, { projectTitle: "New", companyName: "Co" });
  await h.openHost();
  await h.submit();
  const [id] = await catalogIds();
  const entry = await read(`catalog/${id}`);
  const project = await read(`projects/${id}`);
  assert.deepEqual(Object.keys(entry).sort(), FIVE);
  assert.equal(entry.projectTitle, "New");
  assert.equal(entry.status, "submitted");
  assert.ok(entry.createdAt);
  assert.equal(entry.createdAt.toMillis(), project.createdAt.toMillis());
});

test("new draft writes no catalog entry", async () => {
  const h = await boot(HOST, { projectTitle: "New" });
  await h.openHost();
  await h.saveDraft();
  assert.deepEqual(await catalogIds(), []);
});

test("host moves submitted project to draft and it leaves the student catalog query", async () => {
  const h = await boot(HOST, { projectTitle: "New", companyName: "Co" });
  await h.openHost();
  await h.submit();
  const [id] = await catalogIds();
  const before = await read(`catalog/${id}`);
  assert.equal((await studentQuery()).size, 1);
  await h.saveDraft();
  assert.equal((await studentQuery()).size, 0);
  const entry = await read(`catalog/${id}`);
  assert.equal((await read(`projects/${id}`)).status, "draft");
  assert.equal(entry.status, "draft");
  assert.equal(entry.createdAt.toMillis(), before.createdAt.toMillis());
  await h.submit();
  assert.equal((await studentQuery()).size, 1);
  assert.equal((await read(`catalog/${id}`)).createdAt.toMillis(), before.createdAt.toMillis());
});

test("legacy host saves before the backfill without failing", async () => {
  const created = Timestamp.fromMillis(5000);
  await seed("projects/draft", legacyProject({ status: "draft", createdAt: created }));
  const h = await boot(HOST, { projectTitle: "Edited", companyName: "Old Co" });
  await h.openHost();
  await h.saveDraft();
  assert.equal((await read("projects/draft")).projectTitle, "Edited");
  assert.deepEqual(await catalogIds(), []);
  await h.submit();
  const entry = await read("catalog/draft");
  assert.equal(entry.status, "submitted");
  assert.equal(entry.createdAt.toMillis(), 5000);
});

test("legacy host with no createdAt can save and submit", async () => {
  await seed("projects/old", legacyProject({ status: "draft" }));
  const h = await boot(HOST, { projectTitle: "Edited" });
  await h.openHost();
  await h.submit();
  const entry = await read("catalog/old");
  assert.equal(entry.createdAt, null);
  assert.equal((await read("projects/old")).createdAt, undefined);
});

async function seedLegacySet() {
  await seed("projects/z-first", legacyProject({ projectTitle: "Z", createdAt: Timestamp.fromMillis(1000) }));
  await seed("projects/a-second", legacyProject({ projectTitle: "A", createdAt: Timestamp.fromMillis(2000) }));
  await seed("projects/m-none", legacyProject({ projectTitle: "M" }));
  await seed("projects/hidden", legacyProject({ status: "draft", createdAt: Timestamp.fromMillis(1) }));
}

test("backfill is idempotent and keeps rank order and docId", async () => {
  await seedLegacySet();
  const admin = await boot(ADMIN);
  assert.equal(await admin.window.DpiAdminData.backfillCatalog(), 3);
  const firstRun = await read("catalog/z-first");
  assert.equal(await admin.window.DpiAdminData.backfillCatalog(), 3);
  assert.deepEqual(await catalogIds(), ["a-second", "m-none", "z-first"]);
  assert.deepEqual(Object.keys(await read("catalog/m-none")).sort(), FIVE);
  assert.equal((await read("catalog/z-first")).createdAt.toMillis(), firstRun.createdAt.toMillis());

  // A ranking saved before the split must still resolve by docId.
  await seed("students/s1", {
    ownerUid: STUDENT,
    ownerEmail: email(STUDENT),
    status: "draft",
    projectChoices: [{ docId: "a-second", projectId: 3, title: "A" }],
  });

  // Old numbering: createdAt ascending, missing first, ties by id.
  const student = await boot(STUDENT);
  const list = student.byId("student-project-choices");
  student.window.__demoGo("apply-3");
  await waitFor(() => /is-chosen/.test(String(list.innerHTML || "")));
  const order = [...list.innerHTML.matchAll(/data-project-doc="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, ["m-none", "z-first", "a-second"]);
  assert.match(list.innerHTML, /Old Co/);
  assert.match(list.innerHTML, /is-chosen" data-project-doc="a-second"/);
});

test("backfill handles more docs than one rules access budget", async () => {
  for (let i = 0; i < 30; i += 1) {
    await seed(`projects/p${i}`, legacyProject());
  }
  const admin = await boot(ADMIN);
  assert.equal(await admin.window.DpiAdminData.backfillCatalog(), 30);
  assert.equal((await catalogIds()).length, 30);
});

test("non-admin cannot run the backfill", async () => {
  await seedLegacySet();
  const h = await boot(HOST);
  await assert.rejects(h.window.DpiAdminData.backfillCatalog(), /Admin/);
  assert.deepEqual(await catalogIds(), []);
});

test("backfill is not called on boot", async () => {
  await seedLegacySet();
  await boot(ADMIN);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(await catalogIds(), []);
});

test("admin approve that flips a draft to submitted updates the catalog in step", async () => {
  await seed("projects/d1", legacyProject({ status: "draft", createdAt: Timestamp.fromMillis(7000) }));
  const admin = await boot(ADMIN);
  admin.window.__demoGo("admin");
  await waitFor(() => String(admin.byId("admin-projects-list").innerHTML || "").includes("d1"));
  const card = { getAttribute: () => "d1" };
  admin.byId("admin-projects-list").listeners.click[0]({ target: { closest: () => card } });
  const approve = { id: "apd-btn-approve", getAttribute: () => null };
  const target = { closest: (sel) => (sel === "button" ? approve : null) };
  for (const cb of admin.byId("view-admin-project").listeners.click) cb({ target });
  await poll(async () => (await read("catalog/d1")) !== null);
  assert.equal((await read("projects/d1")).status, "submitted");
  const entry = await read("catalog/d1");
  assert.equal(entry.status, "submitted");
  assert.equal(entry.createdAt.toMillis(), 7000);
});

test("backfill deletes orphans and demotes entries of unsubmitted projects", async () => {
  await seedLegacySet();
  const entry = { projectTitle: "X", companyName: "", ownerUid: HOST, createdAt: null };
  await seed("catalog/gone", { ...entry, status: "submitted" });
  await seed("catalog/gone-draft", { ...entry, status: "draft" });
  await seed("catalog/hidden", { ...entry, status: "submitted" });
  const admin = await boot(ADMIN);
  for (let run = 0; run < 2; run += 1) {
    assert.equal(await admin.window.DpiAdminData.backfillCatalog(), 3);
    assert.deepEqual(await catalogIds(), ["a-second", "hidden", "m-none", "z-first"]);
    assert.equal((await read("catalog/hidden")).status, "draft");
    assert.equal((await studentQuery()).size, 3);
  }
});

test("backfill creates no entry for a draft that never had one", async () => {
  await seed("projects/d1", legacyProject({ status: "draft" }));
  const admin = await boot(ADMIN);
  assert.equal(await admin.window.DpiAdminData.backfillCatalog(), 0);
  assert.deepEqual(await catalogIds(), []);
});

async function hostSaveError(h, save) {
  const message = await save().then(() => "", (err) => err.message);
  assert.match(message, /^save failed: /);
  return message;
}

test("over-cap host save names the field and writes nothing", async () => {
  for (const [form, label, cap] of [
    [{ projectTitle: "x".repeat(301) }, "Project Title", 300],
    [{ projectTitle: "T", companyName: "x".repeat(301) }, "Company Name", 300],
    [{ projectTitle: "T", notes: "x".repeat(20001) }, "Additional notes", 20000],
  ]) {
    const h = await boot(HOST, form);
    await h.openHost();
    const message = await hostSaveError(h, h.submit);
    assert.ok(message.includes(label), message);
    assert.ok(message.includes(cap.toLocaleString("en-US")), message);
    assert.equal(/permissions/i.test(message), false);
    assert.deepEqual(await catalogIds(), []);
  }
});

test("legacy over-cap project gets the named message and stays unchanged", async () => {
  const long = "x".repeat(301);
  await seed("projects/old", legacyProject({ projectTitle: long }));
  const h = await boot(HOST, { projectTitle: long, notes: "edit" });
  await h.openHost();
  const message = await hostSaveError(h, h.saveDraft);
  assert.ok(message.includes("Project Title"), message);
  assert.equal((await read("projects/old")).notes, undefined);
});

test("host fields exactly at the cap save", async () => {
  const h = await boot(HOST, {
    projectTitle: "x".repeat(300),
    companyName: "y".repeat(300),
    description: "z".repeat(20000),
  });
  await h.openHost();
  await h.submit();
  const [id] = await catalogIds();
  assert.equal((await read(`catalog/${id}`)).projectTitle.length, 300);
});

test("over-cap student save names the field and writes nothing", async () => {
  const h = await boot(STUDENT, {}, { whyInternship: "x".repeat(20001) });
  for (const cb of h.byId("btn-student-save-draft").listeners.click) cb({ preventDefault() {} });
  const status = h.byId("student-review-status");
  await waitFor(() => status.textContent);
  assert.match(status.textContent, /Why this internship/);
  let count;
  await env.withSecurityRulesDisabled(async (ctx) => {
    count = (await getDocs(collection(ctx.firestore(), "students"))).size;
  });
  assert.equal(count, 0);
});

test("student at the cap saves through the real rules", async () => {
  const h = await boot(STUDENT, {}, { whyInternship: "x".repeat(20000) });
  for (const cb of h.byId("btn-student-save-draft").listeners.click) cb({ preventDefault() {} });
  const status = h.byId("student-review-status");
  await waitFor(() => status.textContent);
  assert.match(status.textContent, /^Draft saved/);
});

test("saving an existing project keeps createdAt", async () => {
  const created = Timestamp.fromMillis(5000);
  await seed("projects/old", legacyProject({ createdAt: created, status: "draft" }));
  const h = await boot(HOST, { projectTitle: "Edited" });
  await h.openHost();
  await h.submit();
  assert.equal((await read("projects/old")).createdAt.toMillis(), 5000);
  assert.equal((await read("catalog/old")).createdAt.toMillis(), 5000);
});
