import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, setDoc } from "firebase/firestore";
import { ref, uploadBytes, getBytes, deleteObject } from "firebase/storage";

const OWNER = "owner1";
const OTHER = "other1";
const ADMIN = "admin1";
const MB = 1024 * 1024;

let env;

const store = (uid) => env.authenticatedContext(uid).storage();
const pdf = { contentType: "application/pdf" };
const bytes = (n = 10) => new Uint8Array(n);

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-dpi",
    firestore: { rules: readFileSync("firestore.rules", "utf8") },
    storage: { rules: readFileSync("storage.rules", "utf8") },
  });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `users/${ADMIN}`), {
      email: "admin1@example.com",
      role: "admin",
    });
    await uploadBytes(
      ref(ctx.storage(), `students/${OWNER}/resume/old name (1).pdf`),
      bytes(),
      pdf
    );
    await uploadBytes(
      ref(ctx.storage(), `students/${OWNER}/resume/resume.pdf`),
      bytes(),
      pdf
    );
  });
});

after(async () => {
  await env.cleanup();
});

test("arbitrary filename rejected", async () => {
  await assertFails(
    uploadBytes(ref(store(OWNER), `students/${OWNER}/resume/evil.pdf`), bytes(), pdf)
  );
  await assertFails(
    uploadBytes(ref(store(OWNER), `projects/${OWNER}/logo/evil.png`), bytes(), {
      contentType: "image/png",
    })
  );
});

test("resume.pdf accepted", async () => {
  await assertSucceeds(
    uploadBytes(ref(store(OWNER), `students/${OWNER}/resume/resume.pdf`), bytes(), pdf)
  );
  await assertSucceeds(
    uploadBytes(
      ref(store(OWNER), `students/${OWNER}/transcript/transcript.pdf`),
      bytes(),
      pdf
    )
  );
});

test("svg logo rejected", async () => {
  await assertFails(
    uploadBytes(ref(store(OWNER), `projects/${OWNER}/logo/logo`), bytes(), {
      contentType: "image/svg+xml",
    })
  );
});

test("png logo accepted", async () => {
  await assertSucceeds(
    uploadBytes(ref(store(OWNER), `projects/${OWNER}/logo/logo`), bytes(), {
      contentType: "image/png",
    })
  );
});

test("other user cannot read", async () => {
  await assertFails(getBytes(ref(store(OTHER), `students/${OWNER}/resume/resume.pdf`)));
});

test("admin can read", async () => {
  await assertSucceeds(getBytes(ref(store(ADMIN), `students/${OWNER}/resume/resume.pdf`)));
});

test("legacy filename still readable and deletable by owner", async () => {
  const r = ref(store(OWNER), `students/${OWNER}/resume/old name (1).pdf`);
  await assertSucceeds(getBytes(r));
  await assertSucceeds(deleteObject(r));
});

test("over 10MB rejected", async () => {
  await assertFails(
    uploadBytes(
      ref(store(OWNER), `students/${OWNER}/resume/resume.pdf`),
      bytes(10 * MB + 1),
      pdf
    )
  );
});
