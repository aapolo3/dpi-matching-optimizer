# Security and Performance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the backend access-control gaps found in the audit and cut needless Firestore reads and page weight, without changing what legitimate users can do.

**Architecture:** Firestore and Storage rules stay the only backend, now covered by emulator tests. A new `catalog/{projectId}` collection holds the fields students need, and `projects` becomes owner/admin-only. Admin code loads on demand, and the matcher moves to a Web Worker.

**Tech Stack:** Vanilla JS, Firebase compat SDK 11.6.0, Firestore and Storage rules, `@firebase/rules-unit-testing`, `node:test`, Firebase emulators (Java is installed).

**Spec:** None on disk. The user approved batches 1-3 in chat on 2026-11-05. This plan's Goal and Global Constraints are the authority.

## Global Constraints

- No deploy, no live-data write, and no console change during execution. These are listed under "After merge" for the user to confirm.
- No push or merge without user approval.
- Existing drafts and submitted applications must still load and save after the rules change.
- Field names in `catalog` match `projects`: `projectTitle`, `companyName`, `createdAt`, `status`, `ownerUid`.
- Student rank numbering must stay the same: sort by `createdAt` with `sortByCreatedAt`, numbered from 1.
- Do not add `hasOnly` key allowlists. Legacy docs may hold other keys and owners would be locked out. Use admin-field denylists and size caps.
- Bump the `?v=` query on every changed script tag in `website/index.html`.
- Match runs stay previews and write nothing to Firestore.

## Review Focus

- A legacy doc with no `reviewStatus`, or with extra keys, saved by its owner: the save succeeds. Test in Task 1.
- A host moves a submitted project back to draft: it leaves the student catalog. Test in Task 6.
- An admin deletes a project: its catalog entry goes too. Test in Task 6.
- An admin exports or builds a cohort before the first snapshot arrives: the action waits for data and never exports empty. Covered in Task 3.
- Google popup sign-in under the new CSP and headers: it still completes. Manual check in Task 5.

---

### Task 1: Firestore rules lockdown with emulator tests

**Files:**
- Create: `package.json`, `tests/firestore.rules.test.mjs`
- Modify: `firestore.rules`, `.gitignore` (add `node_modules/`)

**Interfaces:**
- Produces: `npm test` runs `firebase emulators:exec --only firestore,storage --project demo-dpi "node --test tests/"`. `firebase-tools` is an exact-pinned devDependency.

Rules to add:
- Project admin fields, owner-denied: `assignedInterns`, `approvedByName`, plus every other field written at `website/app.js:1979-2001`. Read those lines and list them all.
- Student admin fields, owner-denied: `matchedProject`, `matchedProjectId`.
- `reviewStatus` for owners: on create, absent or `'submitted'`. On update, unchanged, or absent before and `'submitted'` after.
- `ownerEmail == request.auth.token.email` on owner create and update. On `users/{uid}`, pin `email` to the token for owners.
- Size caps: every string field an owner writes `<= 20000` characters, enforced on the long free-text fields found in the form readers. Keep doc key count `<= 100`.

Also change `website/app.js:758` and `:1054` so `reviewStatus` is set only when absent. An unrecognized legacy value is left alone, because the rule would reject the write.

- [ ] **Step 1: Write failing tests.** Names: `student cannot set matchedProject`, `student cannot self-set reviewStatus matched on create or update`, `host cannot set assignedInterns`, `host cannot set approvedByName`, `owner cannot spoof ownerEmail`, `owner cannot change users email`, `oversized text rejected`, `legacy doc with extra keys and no reviewStatus saves`, `admin can set reviewStatus and assignedInterns`, `user cannot self-promote`.
- [ ] **Step 2:** Run `npm test`. Expected: the denial tests FAIL.
- [ ] **Step 3:** Implement the rules and the `app.js` change. Update the header comment in `firestore.rules`, which says these fields are app-enforced.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit: `fix(rules): block owner writes to admin fields`.

### Task 2: Storage lockdown with fixed filenames

**Files:**
- Create: `tests/storage.rules.test.mjs`
- Modify: `storage.rules`, `website/app.js:541-545,594-597`, the logo file input `accept` in `website/index.html`

Fixed paths: `students/{uid}/resume/resume.pdf`, `students/{uid}/transcript/transcript.pdf`, `projects/{uid}/logo/logo`. The rules enforce these names on write only, so existing files stay readable and deletable. Remove `image/svg+xml` from logos. Keep PDF logos. Keep the stored original filename for display if the UI shows one.

- [ ] **Step 1: Write failing tests.** `arbitrary filename rejected`, `resume.pdf accepted`, `svg logo rejected`, `png logo accepted`, `other user cannot read`, `legacy filename still readable by owner`, `over 10MB rejected`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the rules and upload paths. Remove `sanitizeFileName` if it has no remaining callers.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `fix(storage): fixed upload paths and no svg logos`.

### Task 3: Reuse admin caches

**Files:** Modify `website/app.js` (lines 170, 239-244, 1199-1208, 1609-1650, 2165, 2204, 2284, 2406)

**Interfaces:**
- Produces: `adminRosterReady(): Promise<{projects, students}>`, which resolves after both listeners have delivered their first snapshot and returns the current caches.

Changes:
- Listeners start on first admin view entry and stop only on auth change, not on view leave.
- `exportWorkbook`, `buildCohortFromFirestore` and `loadAdminRoster` use `adminRosterReady()`.
- Delete `fetchAllProjects` and `fetchAllStudents`.
- Refresh re-renders from the cache.
- A listener error rejects `adminRosterReady`, and callers show their existing error status.

- [ ] **Step 1:** Confirm cached docs have the same shape as the `fetchAll*` results (`{id, ...data}`), and match them if not.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify against emulators with seeded data in the browser: open admin, leave, return, Refresh, export, build. Expected: read count is one per doc, and export contents are unchanged.
- [ ] **Step 4:** Commit: `perf(admin): reuse roster listeners for exports and builds`.

### Task 4: Lazy-load the admin bundle and update SheetJS

**Files:**
- Modify: `website/index.html:1285-1291`, `website/app.js`, `website/match-demo.js` if it binds at load, `website/xlsx-cohort.js` only if the new version needs it
- Delete: `website/vendor/solver.js`, `website/vendor/xlsx.full.min.js`
- Create: `website/vendor/xlsx-0.20.3.full.min.js`, from `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`

**Interfaces:**
- Produces: `loadAdminBundle(): Promise<void>` in `app.js`. It is memoized and appends in order: xlsx, `xlsx-cohort.js`, `matcher.js`, `alternate-solvers.js`, `match-demo.js`. It rejects on script error, and a later call can retry.

Call it on entry to the `admin` view, and await it in `exportWorkbook`, `buildCohortFromFirestore` and any `app.js` use of `DpiCohort`. Check `app.js` for `DpiCohort` or `XLSX` use outside admin paths. If `match-demo.js` waits on `DOMContentLoaded`, make it also initialize when the document is already loaded.

- [ ] **Step 1:** Fetch SheetJS and confirm its version banner reads 0.20.3. Grep to confirm `solver.js` has no references outside comments.
- [ ] **Step 2:** Implement.
- [ ] **Step 3:** Verify in the browser: student and host views make no request for xlsx or matcher files. Admin export, workbook upload with `demo/generated_*.xlsx`, and a match run all work.
- [ ] **Step 4:** Commit: `perf: lazy-load admin bundle and update SheetJS`.

### Task 5: Track hosting config, headers, deploy script

**Files:** Modify `.gitignore`, `firebase.json` (now tracked), `scripts/deploy-firebase.sh`, `docs/website.md:299`

Headers:
- All paths: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Cross-Origin-Opener-Policy: same-origin-allow-popups`.
- All paths: CSP with `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`, `worker-src 'self'`, `script-src` for self, gstatic, `apis.google.com` and the reCAPTCHA hosts, plus `connect-src`, `frame-src`, `img-src`, `style-src` and `font-src` for what the app uses. Grep `index.html` for inline scripts and styles first.
- `/vendor/**`: `Cache-Control: public, max-age=31536000, immutable` (filenames are versioned from Task 4).
- `/images/**`: `max-age=604800`.
- `**/*.html` and `/`: `no-cache`.

Deploy script: exact-pin `firebase-tools` to the Task 1 version, and use `--only firestore,storage,hosting`. The `auth` block was deleted from `firebase.json` at the user's request, so sign-in settings are managed in the Firebase console. `firebase.json` is gitignored and absent from new worktrees: copy it from the main checkout before tracking it, and confirm it contains no `auth` block or email.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify with `firebase emulators:start --only hosting,auth`. Check the headers with `curl -I`. Google sign-in, admin view and upload raise no CSP console errors.
- [ ] **Step 3:** Commit: `chore: track firebase.json, add security and cache headers`.

### Task 6: Split the public catalog from protected project docs

**Files:**
- Modify: `firestore.rules`, `tests/firestore.rules.test.mjs`, `website/app.js:737-776,894-911` and any project delete path, `README.md`, `docs/website.md`

**Interfaces:**
- Produces: `catalog/{projectId}` with exactly `projectTitle`, `companyName`, `status`, `ownerUid`, `createdAt`.
- Produces: `window.DpiAdminData.backfillCatalog(): Promise<number>`, admin-only and idempotent. It upserts one catalog doc per submitted project and returns the count. It is never called automatically.

Rules:
- `projects` read: owner or admin only.
- `catalog` read: signed-in, where `status == 'submitted'`.
- `catalog` write: admin, or the owner of the matching `projects/{id}`, using `getAfter` so a batch can create both. `keys().hasOnly` the five fields is allowed here because the collection is new.

Client:
- `saveHostProject` writes the project and catalog doc in one `WriteBatch`. `createdAt` is copied from the project and never reset on update. A draft save sets catalog `status: 'draft'` only if an entry exists, so it drops out of the query.
- `loadProjectCatalog` queries `catalog`.
- `assignStudentToProject` and the admin export keep reading `projects`.

- [ ] **Step 1: Write failing tests.** `signed-in stranger cannot read submitted project`, `signed-in stranger can read submitted catalog entry`, `stranger cannot read draft catalog entry`, `catalog rejects extra field like supervisorEmail`, `non-owner cannot write catalog`, `owner batch creates project and catalog`, `admin delete removes catalog entry`.
- [ ] **Step 2:** Run `npm test`. Expected: FAIL.
- [ ] **Step 3:** Implement the rules, client changes and `backfillCatalog`. Update the README access table.
- [ ] **Step 4:** Run `npm test`. Expected: PASS.
- [ ] **Step 5:** Verify on emulators: seed legacy projects, run the backfill twice, and confirm one entry per project with the same rank order as before. Confirm saved student rankings still resolve by `docId`.
- [ ] **Step 6:** Commit: `fix(security): serve student catalog from protected split`.

### Task 7: Run the matcher in a Web Worker

**Files:**
- Create: `website/match-worker.js`
- Modify: `website/match-demo.js:741-754`, `website/matcher.js` and `website/alternate-solvers.js` only if their global reference needs to resolve in a worker

**Interfaces:**
- Consumes: `DpiMatcher.runMatch(data, options)`.
- Produces: `runMatchInWorker(data, options): Promise<result>` in `match-demo.js`. The worker uses `importScripts` for both solver files, posts `{ok, result}` or `{ok:false, error}`, and is terminated after each run. Worker load failure rejects, and the caller shows the existing error status.

Confirm `result` survives structured clone: check for functions in it. Main-thread helpers (`groupByProject`, `teamSkillMetrics`) still need `matcher.js` loaded.

- [ ] **Step 1: Write a test.** `tests/match-worker.test.mjs` loads the solver in a `node:vm` context with `self` as the global, runs `runMatch` on a small fixed cohort twice, and asserts `structuredClone(result)` deep-equals the result.
- [ ] **Step 2:** Run it. Expected: PASS once global resolution is fixed.
- [ ] **Step 3:** Implement the worker and swap the call.
- [ ] **Step 4:** Verify in the browser with `demo/generated_*.xlsx`: UI stays responsive during the run, and score and assignments match a run on the previous commit, using the same inputs and the deterministic solver.
- [ ] **Step 5:** Commit: `perf(matcher): run solver in a web worker`.

### Task 8: App Check client wiring

**Files:** Modify `website/index.html`, `website/app.js` (Firebase init), `website/firebase-config.js`, `docs/website.md`

Add `firebase-app-check-compat.js` 11.6.0. Add `appCheckSiteKey: ""` to the config. Activate with `ReCaptchaEnterpriseProvider` before any Firestore, Auth or Storage call, only when the key is non-empty. Document the console steps in the handbook: create the key, then monitor metrics, then enforce.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Verify in the browser: with an empty key the app runs unchanged and loads no reCAPTCHA.
- [ ] **Step 3:** Commit: `feat: add optional App Check initialization`.

---

## After merge (user confirms each, none run during execution)

1. Check live rules against the repo in the console, since live Storage rules may have drifted.
2. Deploy rules and hosting together with `./scripts/deploy-firebase.sh`. Old open tabs will fail project reads until reloaded.
3. Run `DpiAdminData.backfillCatalog()` from an admin session right after deploying. **Students see an empty project list until this finishes.**
4. Create the reCAPTCHA key, set `appCheckSiteKey`, and enforce App Check once metrics look clean.

## Known gaps left open

- No per-user doc count limit. It needs `students/{uid}` doc IDs and a data migration. App Check is the interim brake.
- Storage `contentType` remains client-declared, and download URLs remain bearer links.
- Heuristic solver still has no time budget. The worker stops it freezing the UI, but a run can be long.
- SRI on gstatic scripts, the hero image, and fonts are not in this plan.
