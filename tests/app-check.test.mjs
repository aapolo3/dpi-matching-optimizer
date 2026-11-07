// Runs the real website/app.js with a recording firebase stub to check App Check
// wiring: dormant on an empty key, activated before any other service otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync("website/app.js", "utf8");

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

function boot(config, { withAppCheck = true } = {}) {
  const calls = [];
  const log = (name) => calls.push(name);
  const service = (name, extra = {}) =>
    Object.assign(() => { log(name); return { onAuthStateChanged() {} }; }, extra);
  const firebase = {
    initializeApp: () => { log("initializeApp"); return {}; },
    auth: service("auth", { GoogleAuthProvider: function () {} }),
    firestore: service("firestore", { FieldValue: {} }),
    storage: service("storage"),
  };
  if (withAppCheck) {
    firebase.appCheck = () => ({
      activate(key, auto) { calls.push(`appCheck.activate:${key.key}:${auto}`); },
    });
    firebase.appCheck.ReCaptchaEnterpriseProvider = function (key) { this.key = key; calls.push(`provider:${key}`); };
  }
  const window = { FIREBASE_CONFIG: config, addEventListener() {}, scrollTo() {}, DpiCohort: {} };
  const document = new Proxy(stub(), {
    get(t, k) {
      if (k === "getElementById") return () => stub();
      if (k === "querySelector") return () => null;
      if (k === "querySelectorAll") return () => [];
      if (k === "createElement") return () => ({});
      return t[k];
    },
  });
  try {
    new Function("window", "document", "firebase", "alert", appSource)(window, document, firebase, () => {});
  } catch (_e) { /* boot past init is not under test */ }
  return calls;
}

test("empty appCheckSiteKey never touches appCheck", () => {
  for (const config of [{ appCheckSiteKey: "" }, {}, { appCheckSiteKey: "   " }]) {
    const calls = boot(config);
    assert.ok(calls.includes("initializeApp"));
    assert.ok(!calls.some((c) => c.startsWith("appCheck") || c.startsWith("provider")), JSON.stringify(calls));
  }
});

test("set key activates App Check before auth, firestore and storage", () => {
  const calls = boot({ appCheckSiteKey: "site-key" });
  const at = calls.findIndex((c) => c.startsWith("appCheck.activate"));
  assert.ok(at >= 0, "activate not called");
  assert.ok(calls.includes("provider:site-key"));
  assert.equal(calls[at], "appCheck.activate:site-key:true");
  assert.ok(calls.indexOf("initializeApp") < at);
  for (const svc of ["auth", "firestore", "storage"]) {
    assert.ok(calls.indexOf(svc) > at, `${svc} ran before activate: ${JSON.stringify(calls)}`);
  }
});

test("set key with App Check SDK missing does not break boot", () => {
  const calls = boot({ appCheckSiteKey: "site-key" }, { withAppCheck: false });
  assert.ok(calls.includes("auth") && calls.includes("firestore"));
});
