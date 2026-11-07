import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const raw = readFileSync(new URL("../firebase.json", import.meta.url), "utf8");

test("firebase.json parses and has no auth block", () => {
  const cfg = JSON.parse(raw);
  assert.equal("auth" in cfg, false);
});

test("firebase.json contains no email address", () => {
  assert.equal(raw.includes("@"), false);
});

test("CSP forbids framing", () => {
  const cfg = JSON.parse(raw);
  const csp = cfg.hosting.headers
    .flatMap((h) => h.headers)
    .find((h) => h.key === "Content-Security-Policy");
  assert.ok(csp, "CSP header present");
  assert.ok(csp.value.includes("frame-ancestors 'none'"));
});

test("hosting ignores stray Finder duplicates", () => {
  assert.ok(JSON.parse(raw).hosting.ignore.includes("**/* 2.*"));
});

test("unversioned config and worker scripts revalidate", () => {
  for (const source of ["/firebase-config.js", "/match-worker.js"]) {
    const rule = JSON.parse(raw).hosting.headers.find((h) => h.source === source);
    assert.ok(rule, source);
    assert.deepEqual(rule.headers, [{ key: "Cache-Control", value: "no-cache" }]);
  }
});

const html = readFileSync(new URL("../website/index.html", import.meta.url), "utf8");

// The opening tag of the control whose attribute is exactly name="value".
function controlTag(attr, value) {
  const tags = html.match(/<(?:input|textarea)\b[^>]*>/g) || [];
  const found = tags.filter((t) => t.includes(`${attr}="${value}"`));
  assert.equal(found.length, 1, `${attr}=${value}`);
  return found[0];
}

test("capped controls carry maxlength matching the rules", () => {
  for (const name of ["description", "internLogistics", "technicalSkills", "officeCulture", "notes"]) {
    assert.ok(controlTag("name", name).includes('maxlength="20000"'), name);
  }
  for (const name of ["chicagoEcosystem", "whyInternship", "additionalAcademics", "courseworkOther"]) {
    assert.ok(controlTag("data-student-field", name).includes('maxlength="20000"'), name);
  }
  for (const name of ["projectTitle", "companyName"]) {
    assert.ok(controlTag("name", name).includes('maxlength="300"'), name);
  }
});

test("firebase-config.js tag is versioned", () => {
  assert.match(html, /<script src="firebase-config\.js\?v=\d+"><\/script>/);
});
