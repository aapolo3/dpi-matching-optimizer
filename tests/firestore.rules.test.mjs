import { readFileSync } from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

const OWNER = "owner1";
const OWNER_EMAIL = "owner1@example.com";
const ADMIN = "admin1";
const ADMIN_EMAIL = "admin1@example.com";
const MAX_TEXT = 20000;

let env;

function ownerDb() {
  return env
    .authenticatedContext(OWNER, { email: OWNER_EMAIL })
    .firestore();
}

function adminDb() {
  return env
    .authenticatedContext(ADMIN, { email: ADMIN_EMAIL })
    .firestore();
}

function base(extra = {}) {
  return {
    ownerUid: OWNER,
    ownerEmail: OWNER_EMAIL,
    status: "draft",
    ...extra,
  };
}

// Owner creates must stamp createdAt with the server time, as the app does.
function created(extra = {}) {
  return base({ createdAt: serverTimestamp(), ...extra });
}

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

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
  await seed(`users/${ADMIN}`, {
    email: ADMIN_EMAIL,
    displayName: "Admin",
    role: "admin",
  });
  await seed(`users/${OWNER}`, {
    email: OWNER_EMAIL,
    displayName: "Owner",
    role: "student",
  });
});

test("student cannot set matchedProject", async () => {
  const ref = doc(ownerDb(), "students/s1");
  await assertFails(setDoc(ref, created({ matchedProject: "X" })));
  await assertFails(setDoc(ref, created({ matchedProjectId: "p1" })));
  await seed("students/s1", base());
  await assertFails(updateDoc(ref, { matchedProject: "X" }));
  await assertFails(updateDoc(ref, { matchedProjectId: "p1" }));
});

test("student cannot self-set reviewStatus matched on create or update", async () => {
  const ref = doc(ownerDb(), "students/s1");
  await assertFails(setDoc(ref, created({ reviewStatus: "matched" })));
  await seed("students/s1", base());
  await assertFails(updateDoc(ref, { reviewStatus: "matched" }));
  await seed("students/s1", base({ reviewStatus: "submitted" }));
  await assertFails(updateDoc(ref, { reviewStatus: "matched" }));
});

test("host cannot self-approve via reviewStatus", async () => {
  const ref = doc(ownerDb(), "projects/p1");
  await assertFails(setDoc(ref, created({ reviewStatus: "approved" })));
  await seed("projects/p1", base({ reviewStatus: "submitted" }));
  await assertFails(updateDoc(ref, { reviewStatus: "approved" }));
});

test("owner cannot remove an admin-set reviewStatus", async () => {
  await seed("students/s1", base({ reviewStatus: "denied" }));
  await assertFails(
    updateDoc(doc(ownerDb(), "students/s1"), { reviewStatus: deleteField() })
  );
});

test("host cannot set assignedInterns", async () => {
  const ref = doc(ownerDb(), "projects/p1");
  await assertFails(setDoc(ref, created({ assignedInterns: [] })));
  await seed("projects/p1", base());
  await assertFails(updateDoc(ref, { assignedInterns: [{ studentId: "s1" }] }));
});

test("host cannot set approvedByName", async () => {
  const ref = doc(ownerDb(), "projects/p1");
  await assertFails(setDoc(ref, created({ approvedByName: "Me" })));
  await seed("projects/p1", base());
  await assertFails(updateDoc(ref, { approvedByName: "Me" }));
});

test("host cannot set approvedAt, approvedByUid, or approvedByEmail", async () => {
  const ref = doc(ownerDb(), "projects/p1");
  await seed("projects/p1", base());
  for (const field of ["approvedAt", "approvedByUid", "approvedByEmail"]) {
    await assertFails(setDoc(doc(ownerDb(), "projects/p2"), created({ [field]: "x" })));
    await assertFails(updateDoc(ref, { [field]: "x" }));
  }
});

test("owner cannot spoof ownerEmail", async () => {
  for (const coll of ["projects", "students"]) {
    const ref = doc(ownerDb(), `${coll}/d1`);
    await assertFails(setDoc(ref, created({ ownerEmail: "boss@example.com" })));
    await seed(`${coll}/d1`, base());
    await assertFails(updateDoc(ref, { ownerEmail: "boss@example.com" }));
  }
});

test("owner cannot change users email", async () => {
  const ref = doc(ownerDb(), `users/${OWNER}`);
  await assertFails(updateDoc(ref, { email: "boss@example.com" }));
  await assertSucceeds(updateDoc(ref, { displayName: "New Name" }));
  const fresh = env
    .authenticatedContext("new1", { email: "new1@example.com" })
    .firestore();
  await assertFails(
    setDoc(doc(fresh, "users/new1"), {
      email: "boss@example.com",
      displayName: "New",
      role: "student",
    })
  );
});

test("oversized text rejected", async () => {
  const big = "x".repeat(MAX_TEXT + 1);
  const ok = "x".repeat(MAX_TEXT);
  const cases = [
    ["projects", "description"],
    ["projects", "internLogistics"],
    ["projects", "technicalSkills"],
    ["projects", "officeCulture"],
    ["projects", "notes"],
    ["students", "chicagoEcosystem"],
    ["students", "whyInternship"],
    ["students", "additionalAcademics"],
    ["students", "courseworkOther"],
  ];
  for (const [coll, field] of cases) {
    const ref = doc(ownerDb(), `${coll}/${field}`);
    await assertFails(setDoc(ref, created({ [field]: big })));
    await assertSucceeds(setDoc(ref, created({ [field]: ok })));
    await assertFails(updateDoc(ref, { [field]: big }));
  }
});

test("doc with more than 100 keys rejected", async () => {
  const many = {};
  for (let i = 0; i < 101; i += 1) many[`k${i}`] = 1;
  await assertFails(setDoc(doc(ownerDb(), "students/s1"), created(many)));
});

test("legacy doc with extra keys and no reviewStatus saves", async () => {
  for (const coll of ["projects", "students"]) {
    await seed(`${coll}/old`, {
      ownerUid: OWNER,
      status: "draft",
      retiredField: "keep me",
      legacyNumber: 7,
      firstName: "Old",
    });
    const ref = doc(ownerDb(), `${coll}/old`);
    await assertSucceeds(
      updateDoc(ref, { ownerEmail: OWNER_EMAIL, status: "draft", notes: "n" })
    );
    await assertSucceeds(
      updateDoc(ref, {
        ownerEmail: OWNER_EMAIL,
        status: "submitted",
        reviewStatus: "submitted",
      })
    );
    await assertSucceeds(getDoc(ref));
  }
});

test("reviewed docs still save when reviewStatus is left alone", async () => {
  await seed(
    "projects/p1",
    base({
      status: "submitted",
      reviewStatus: "approved",
      assignedInterns: [{ studentId: "s1" }],
      approvedByName: "Admin",
    })
  );
  await seed(
    "students/s1",
    base({
      status: "submitted",
      reviewStatus: "matched",
      matchedProject: "P",
      matchedProjectId: "p1",
    })
  );
  // An unrecognized legacy value must also survive an owner save.
  await seed("students/s2", base({ status: "submitted", reviewStatus: "pending" }));
  for (const path of ["projects/p1", "students/s1", "students/s2"]) {
    await assertSucceeds(
      updateDoc(doc(ownerDb(), path), {
        ownerUid: OWNER,
        ownerEmail: OWNER_EMAIL,
        status: "submitted",
        notes: "edited",
      })
    );
  }
});

test("owner can create draft and submitted docs", async () => {
  for (const coll of ["projects", "students"]) {
    await assertSucceeds(setDoc(doc(ownerDb(), `${coll}/a`), created()));
    await assertSucceeds(
      setDoc(
        doc(ownerDb(), `${coll}/b`),
        created({ status: "submitted", reviewStatus: "submitted" })
      )
    );
  }
});

test("new user profile can be created", async () => {
  const fresh = env
    .authenticatedContext("new1", { email: "new1@example.com" })
    .firestore();
  await assertSucceeds(
    setDoc(doc(fresh, "users/new1"), {
      email: "new1@example.com",
      displayName: "New",
      photoURL: "",
      role: "host",
    })
  );
});

test("admin can set reviewStatus and assignedInterns", async () => {
  await seed("projects/p1", base({ status: "submitted" }));
  await seed("students/s1", base({ status: "submitted" }));
  const db = adminDb();
  await assertSucceeds(
    updateDoc(doc(db, "projects/p1"), {
      reviewStatus: "approved",
      approvedAt: "now",
      approvedByUid: ADMIN,
      approvedByName: "Admin",
      approvedByEmail: ADMIN_EMAIL,
      assignedInterns: [{ studentId: "s1" }],
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, "students/s1"), {
      reviewStatus: "matched",
      matchedProject: "P",
      matchedProjectId: "p1",
    })
  );
});

test("user cannot self-promote", async () => {
  await assertFails(
    updateDoc(doc(ownerDb(), `users/${OWNER}`), { role: "admin" })
  );
  const fresh = env
    .authenticatedContext("new1", { email: "new1@example.com" })
    .firestore();
  await assertFails(
    setDoc(doc(fresh, "users/new1"), {
      email: "new1@example.com",
      displayName: "New",
      role: "admin",
    })
  );
});

// --- Public catalog split -------------------------------------------------

const STRANGER = "stranger1";
const STRANGER_EMAIL = "stranger1@example.com";

function strangerDb() {
  return env
    .authenticatedContext(STRANGER, { email: STRANGER_EMAIL })
    .firestore();
}

function catalogEntry(extra = {}) {
  return {
    projectTitle: "T",
    companyName: "C",
    status: "submitted",
    ownerUid: OWNER,
    createdAt: null,
    ...extra,
  };
}

function submittedProject(extra = {}) {
  return base({
    status: "submitted",
    reviewStatus: "submitted",
    projectTitle: "T",
    companyName: "C",
    supervisorEmail: "boss@example.com",
    ...extra,
  });
}

test("signed-in stranger cannot read submitted project", async () => {
  await seed("projects/p1", submittedProject());
  await assertFails(getDoc(doc(strangerDb(), "projects/p1")));
  await assertFails(
    getDocs(query(collection(strangerDb(), "projects"), where("status", "==", "submitted")))
  );
});

test("owner and admin can still read projects", async () => {
  await seed("projects/p1", submittedProject());
  await assertSucceeds(getDoc(doc(ownerDb(), "projects/p1")));
  await assertSucceeds(getDoc(doc(adminDb(), "projects/p1")));
  await assertSucceeds(
    getDocs(query(collection(ownerDb(), "projects"), where("ownerUid", "==", OWNER)))
  );
  await assertSucceeds(getDocs(collection(adminDb(), "projects")));
});

test("signed-in stranger can read submitted catalog entry", async () => {
  await seed("catalog/p1", catalogEntry());
  await assertSucceeds(getDoc(doc(strangerDb(), "catalog/p1")));
  await assertSucceeds(
    getDocs(query(collection(strangerDb(), "catalog"), where("status", "==", "submitted")))
  );
});

test("signed-out user cannot read catalog", async () => {
  await seed("catalog/p1", catalogEntry());
  await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(), "catalog/p1")));
});

test("stranger cannot read draft catalog entry", async () => {
  await seed("catalog/p1", catalogEntry({ status: "draft" }));
  await assertFails(getDoc(doc(strangerDb(), "catalog/p1")));
  await assertFails(getDocs(collection(strangerDb(), "catalog")));
});

test("owner can check own draft entry and an absent entry", async () => {
  await seed("catalog/p1", catalogEntry({ status: "draft" }));
  await assertSucceeds(getDoc(doc(ownerDb(), "catalog/p1")));
  await assertSucceeds(getDoc(doc(ownerDb(), "catalog/absent")));
});

test("catalog rejects extra field like supervisorEmail", async () => {
  await seed("projects/p1", submittedProject());
  const extra = catalogEntry({ supervisorEmail: "boss@example.com" });
  await assertFails(setDoc(doc(ownerDb(), "catalog/p1"), extra));
  await assertFails(setDoc(doc(adminDb(), "catalog/p1"), extra));
});

test("catalog rejects a missing field", async () => {
  await seed("projects/p1", submittedProject());
  const { createdAt, ...missing } = catalogEntry();
  await assertFails(setDoc(doc(ownerDb(), "catalog/p1"), missing));
});

test("non-owner cannot write catalog", async () => {
  await seed("projects/p1", submittedProject());
  await seed("catalog/p1", catalogEntry());
  const entry = catalogEntry({ ownerUid: STRANGER });
  await assertFails(setDoc(doc(strangerDb(), "catalog/p1"), entry));
  await assertFails(setDoc(doc(strangerDb(), "catalog/p1"), catalogEntry()));
  await assertFails(setDoc(doc(strangerDb(), "catalog/none"), entry));
});

test("owner cannot put catalog out of step with the project", async () => {
  await seed("projects/p1", submittedProject({ status: "draft" }));
  const db = ownerDb();
  await assertFails(setDoc(doc(db, "catalog/p1"), catalogEntry()));
  await seed("projects/p1", submittedProject());
  await assertFails(setDoc(doc(db, "catalog/p1"), catalogEntry({ projectTitle: "Other" })));
  await assertFails(setDoc(doc(db, "catalog/p1"), catalogEntry({ createdAt: new Date(0) })));
  await assertSucceeds(setDoc(doc(db, "catalog/p1"), catalogEntry()));
});

test("owner cannot delete a catalog entry alone", async () => {
  await seed("projects/p1", submittedProject());
  await seed("catalog/p1", catalogEntry());
  await assertFails(deleteDoc(doc(ownerDb(), "catalog/p1")));
});

test("owner batch creates project and catalog", async () => {
  const db = ownerDb();
  const batch = writeBatch(db);
  const now = serverTimestamp();
  batch.set(doc(db, "projects/p1"), submittedProject({ createdAt: now }));
  batch.set(doc(db, "catalog/p1"), catalogEntry({ createdAt: now }));
  await assertSucceeds(batch.commit());
  let project;
  let entry;
  await env.withSecurityRulesDisabled(async (ctx) => {
    project = await getDoc(doc(ctx.firestore(), "projects/p1"));
    entry = await getDoc(doc(ctx.firestore(), "catalog/p1"));
  });
  assert.equal(
    entry.data().createdAt.toMillis(),
    project.data().createdAt.toMillis()
  );
});

test("catalog write fails when the project stays absent", async () => {
  await assertFails(setDoc(doc(ownerDb(), "catalog/p1"), catalogEntry()));
});

test("admin delete removes catalog entry", async () => {
  await seed("projects/p1", submittedProject());
  await seed("catalog/p1", catalogEntry());
  const db = adminDb();
  const batch = writeBatch(db);
  batch.delete(doc(db, "projects/p1"));
  batch.delete(doc(db, "catalog/p1"));
  await assertSucceeds(batch.commit());
  let entry;
  await env.withSecurityRulesDisabled(async (ctx) => {
    entry = await getDoc(doc(ctx.firestore(), "catalog/p1"));
  });
  assert.equal(entry.exists(), false);
});

test("lone project update fails when a catalog entry exists", async () => {
  await seed("projects/p1", submittedProject());
  await seed("catalog/p1", catalogEntry());
  const ref = doc(ownerDb(), "projects/p1");
  await assertFails(updateDoc(ref, { status: "draft" }));
  await assertFails(updateDoc(ref, { projectTitle: "Other" }));
  await assertFails(updateDoc(ref, { companyName: "Other" }));
  await assertSucceeds(updateDoc(ref, { notes: "unrelated edit" }));
});

test("host with no catalog entry can still save alone", async () => {
  await seed("projects/p1", submittedProject());
  const ref = doc(ownerDb(), "projects/p1");
  await assertSucceeds(updateDoc(ref, { status: "draft", projectTitle: "Other" }));
});

test("owner batch moves project and catalog together", async () => {
  await seed("projects/p1", submittedProject());
  await seed("catalog/p1", catalogEntry());
  const db = ownerDb();
  const batch = writeBatch(db);
  batch.update(doc(db, "projects/p1"), { status: "draft" });
  batch.set(doc(db, "catalog/p1"), catalogEntry({ status: "draft" }));
  await assertSucceeds(batch.commit());
});

test("owner create fails alone when an entry exists at that id", async () => {
  await seed("catalog/p1", catalogEntry());
  await assertFails(setDoc(doc(ownerDb(), "projects/p1"), submittedProject({ createdAt: serverTimestamp(), projectTitle: "Other" })));
  await assertSucceeds(setDoc(doc(ownerDb(), "projects/p2"), created()));
});

test("admin can list draft catalog entries, others cannot", async () => {
  await seed("catalog/p1", catalogEntry({ status: "draft" }));
  await assertSucceeds(getDocs(collection(adminDb(), "catalog")));
  await assertFails(getDocs(collection(ownerDb(), "catalog")));
});

test("owner projectChoices, if present, must be a list", async () => {
  const ref = doc(ownerDb(), "students/s1");
  for (const bad of ["<img src=x onerror=alert(1)>", 3, { length: "<b>x</b>" }]) {
    await assertFails(setDoc(ref, created({ projectChoices: bad })));
  }
  await assertSucceeds(setDoc(ref, created({ projectChoices: [{ docId: "p1" }] })));
  await assertFails(updateDoc(ref, { projectChoices: { length: "<b>x</b>" } }));
  await assertSucceeds(updateDoc(ref, { projectChoices: [] }));
  await assertSucceeds(setDoc(doc(ownerDb(), "students/s2"), created()));
});

test("project title and company are strings capped at 300", async () => {
  const ok = "x".repeat(300);
  const big = "x".repeat(301);
  for (const field of ["projectTitle", "companyName"]) {
    const ref = doc(ownerDb(), `projects/${field}`);
    await assertFails(setDoc(ref, created({ [field]: big })));
    await assertFails(setDoc(ref, created({ [field]: 7 })));
    await assertSucceeds(setDoc(ref, created({ [field]: ok })));
    await assertFails(updateDoc(ref, { [field]: big }));
    await assertFails(updateDoc(ref, { [field]: 7 }));
  }
});

test("catalog title and company are strings capped at 300, admin included", async () => {
  await seed("projects/p1", submittedProject());
  for (const field of ["projectTitle", "companyName"]) {
    for (const bad of ["x".repeat(301), 7]) {
      await assertFails(setDoc(doc(adminDb(), "catalog/p1"), catalogEntry({ [field]: bad })));
    }
  }
  await assertSucceeds(
    setDoc(doc(adminDb(), "catalog/p1"), catalogEntry({ projectTitle: "x".repeat(300) }))
  );
});

test("owner create must stamp createdAt with the server time", async () => {
  for (const coll of ["projects", "students"]) {
    const ref = doc(ownerDb(), `${coll}/a`);
    await assertFails(setDoc(ref, created({ createdAt: new Date(0) })));
    await assertFails(setDoc(ref, created({ createdAt: "2020" })));
    await assertFails(setDoc(ref, base()));
    await assertSucceeds(setDoc(ref, created()));
  }
});

test("owner project update cannot change or remove createdAt", async () => {
  const when = new Date(5000);
  await seed("projects/p1", base({ createdAt: when }));
  const ref = doc(ownerDb(), "projects/p1");
  await assertFails(updateDoc(ref, { createdAt: new Date(0) }));
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp() }));
  await assertFails(updateDoc(ref, { createdAt: deleteField() }));
  await assertSucceeds(updateDoc(ref, { notes: "edited" }));
  await assertSucceeds(updateDoc(ref, { createdAt: when, notes: "same value" }));
  await assertSucceeds(updateDoc(doc(adminDb(), "projects/p1"), { createdAt: new Date(9) }));
});

test("legacy project without createdAt still saves but cannot add one", async () => {
  await seed("projects/old", base());
  const ref = doc(ownerDb(), "projects/old");
  await assertSucceeds(updateDoc(ref, { notes: "edited" }));
  await assertFails(updateDoc(ref, { createdAt: new Date(0) }));
});
