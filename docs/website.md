# Website handbook

Handoff for the live DPI Matching Optimizer site. Read this first if you are taking over the product.

**Live URLs**

- https://dpi-matching-optimizer.web.app
- https://dpi-matching-optimizer.firebaseapp.com

**Firebase project:** `dpi-matching-optimizer`

The site pairs undergraduate students with Discovery Institute Partners / Summer Tech Internship (STI) host projects. Students and hosts sign in with Google and save their own applications. Admins review the roster, export Excel workbooks, and run a cohort matcher in the browser.

There is **no backend server**. Firestore rules and Storage rules *are* the API.

---

## Tech stack

| Layer | What ships |
| --- | --- |
| UI | Vanilla HTML / CSS / JS SPA in [`website/`](../website/) — no React, no build step (the root `package.json` is test tooling only) |
| Auth | Firebase Auth, Google Sign-In only |
| Database | Cloud Firestore (`users`, `projects`, `catalog`, `students`) |
| Files | Firebase Storage (student PDFs, host logos) |
| Hosting | Firebase Hosting, site `dpi-matching-optimizer` |
| Excel | SheetJS (`website/vendor/xlsx-0.20.3.full.min.js`, lazy-loaded for admins) |
| Browser matcher | Custom JS in [`website/matcher.js`](../website/matcher.js) — exact search or heuristic, **not** Google OR-Tools |
| CLI matcher | Python in [`demo/`](../demo/) with Google OR-Tools CBC, openpyxl, SciPy |

The original design docs describe React + FastAPI + PostgreSQL. That stack was never generated. Matching *math* in those docs still applies; the shipped implementation is this Firebase SPA plus the Python CLI twin.

### Script load order

From the bottom of [`website/index.html`](../website/index.html):

1. Firebase compat SDK 11.6.0 (app, app-check, auth, firestore, storage) from `gstatic.com`
2. `firebase-config.js?v=N` — public web config
3. `app.js?v=N` — auth, forms, admin board

Admin-only scripts are not in the HTML. `loadAdminBundle()` in `app.js` appends them in order on first admin use (memoized, retries after an error): `vendor/xlsx-0.20.3.full.min.js`, `xlsx-cohort.js` (Excel / Firestore → cohort JSON), `matcher.js` (scoring + assignment, `window.DpiMatcher`), `alternate-solvers.js` (Hungarian, Gale–Shapley, hybrid), `match-demo.js` (admin matcher UI). Their `?v=` queries live in the `ADMIN_BUNDLE` list.

Several of those tags use `?v=` cache-bust query params. **Bump the number** after you change the corresponding JS or CSS file, or browsers may keep serving a stale copy.

---

## Repo map

```text
dpi-matching-optimizer/
├── website/                 LIVE APP (Firebase Hosting public dir)
│   ├── index.html           all screens in one file
│   ├── styles.css
│   ├── app.js               auth, forms, Firestore, admin board
│   ├── firebase-config.js   public web config (safe to ship)
│   ├── matcher.js           browser scorer + solver
│   ├── alternate-solvers.js Hungarian / Gale–Shapley / hybrid
│   ├── match-demo.js        admin matcher panel
│   ├── xlsx-cohort.js       Excel ↔ cohort converter (keep in sync with Python)
│   ├── images/
│   └── vendor/              SheetJS 0.20.3 (admin only)
├── demo/                    CLI matcher (OR-Tools CBC)
├── docs/                    this handbook + matching math
├── firestore.rules          data access (this is the API)
├── storage.rules
├── firebase.json
├── scripts/deploy-firebase.sh
└── reference sheets/        real STI 2026 workbooks — treat as sensitive
```

[`reference sheets/`](../reference%20sheets/) contains real 2026 application data. Do not commit copies elsewhere or paste rows into tickets.

---

## Screens (no URL router)

Firebase Hosting rewrites every path to `/index.html`, but the app does **not** read the URL. [`showView()`](../website/app.js) shows one `<main class="view">` at a time by toggling `.is-active`.

| View | Audience | What it does |
| --- | --- | --- |
| `landing` | public | Hero, “Start application”, “Apply to host”. **“See past projects” has no handler.** |
| `apply-1` | student | Profile: identity, residency, academics, resume + transcript PDFs |
| `apply-2` | student | Skills (six rated tools), interests, coursework, essays |
| `apply-3` | student | Logistics, acknowledgements, rank submitted projects, “any project fits” |
| `apply-4` | student | Review, save draft / submit |
| `host` | host | Project application + logo upload |
| `admin` | admin | Roster, Excel export, student Kanban, cohort matcher |
| `admin-project` | admin | One project: completeness, suggested matches, approve / assign / archive |

Header: **My application** → `apply-1`, **My project** → `host`, **Admin** → `admin` (admins only). Logo click returns to landing.

HTML forms bind through `data-*` attributes (`data-go`, `data-student-field`, `data-choice`, `data-multi`, `data-ack`, `data-board-status`). Renaming one of those without updating `app.js` silently breaks the form.

---

## Auth and roles

Google Sign-In popup (`prompt: select_account`). Anonymous and email/password are off.

First successful sign-in creates `users/{uid}` with:

- `email`, `displayName`, `photoURL`
- `role`: `student` or `host`, taken from `pendingRole` (which button they used)
- `createdAt`

**Role is sticky.** Owners cannot change their own `role` (Firestore rules). Admin is not self-serve:

1. The person signs in once (creates the `users` doc).
2. In the Firebase console, set `users/{uid}.role` to `admin`.

The Admin button is hidden unless `role === "admin"`. Non-admins who hit it get an alert.

---

## Data model

### `users/{uid}`

| Field | Notes |
| --- | --- |
| `email`, `displayName`, `photoURL` | From Google |
| `role` | `student` \| `host` \| `admin`. Create allows only student/host |

### `projects/{id}`

Written by the host (`ownerUid`). One project per Google account in the current UI (load queries `ownerUid == auth.uid`, limit 1).

| Field | Notes |
| --- | --- |
| `status` | Form machine: `draft` \| `submitted`. Owners can keep editing after submit |
| `reviewStatus` | Admin machine: `submitted` \| `approved` \| `changes_requested` \| `archived` |
| `assignedInterns` | Array of `{ studentId, fullName, major, year, matchPercent, assignedAt }` |
| Host form fields | `projectTitle`, `companyName`, `technicalSkills`, `internLogistics`, … |
| Not on the form | min GPA, topic category, intern count — inferred at convert time |

Full project docs are readable only by the owner and admins.

### `catalog/{id}`

Public subset of a project, with the same id, so students can rank without seeing contact details or assigned interns. Fields are exactly `projectTitle`, `companyName`, `status`, `ownerUid`, `createdAt`, copied from the project in the same batch as each save. Signed-in users can read submitted entries. A draft save only marks an existing entry as `draft`.

After the first deploy of these rules, an admin must run `await DpiAdminData.backfillCatalog()` once from the browser console. Until then, students see no projects that were submitted before the deploy. It is idempotent and returns the number of submitted entries upserted. It also repairs drift: it deletes entries whose project is gone and copies the current status onto entries of projects that are no longer submitted. The app never calls it.

Pages left open across that deploy fail or go stale until reloaded: student pages get permission-denied on the project list, and host pages get permission-denied when saving a project that has a catalog entry.

**Deleting a project:** there is no delete button, so admins delete in the Firebase console. Delete `catalog/{id}` with the project, or rerun `backfillCatalog` afterward. Otherwise the deleted project stays in the student list.

### `students/{id}`

Written by the applicant (`ownerUid`). Owner or admin can read.

| Field | Notes |
| --- | --- |
| `status` | `draft` \| `submitted` |
| `reviewStatus` | `waitlisted` \| `submitted` \| `denied` \| `reviewing` \| `matched` |
| `matchedProject` / `matchedProjectId` | Set by `assignStudentToProject`, not by the cohort matcher |
| `projectChoices` | Ranked `{ docId, projectId, title }` from the submitted-project catalog |
| `skillProficiency` | Map of the six UI skills → Beginner / Competent / Advanced |
| `availableSummer` | Currently **hardcoded `true`** on save |

Newly submitted apps default `reviewStatus` to `"submitted"`.

`reviewStatus` and `assignedInterns` are **app-enforced**, not rule-enforced. Rules only check owner, `status` in `{draft, submitted}`, and admin.

### Storage

| Path | Who | Limits |
| --- | --- | --- |
| `students/{uid}/resume\|transcript/{file}` | owner or admin | PDF, under 10 MB |
| `projects/{uid}/logo/{file}` | owner or admin | PNG / JPEG / SVG / WebP / PDF, under 10 MB |

---

## Admin board

Live listeners on `projects` and `students` while the admin views are open. Leaving those views unsubscribes.

**Student Kanban** columns: waitlisted, submitted, denied, reviewing, matched. Dragging a card only writes `reviewStatus`. That is **not** a placement.

**Real assignment** happens on the project detail page via `assignStudentToProject`:

- appends to `projects.assignedInterns`
- sets the student `reviewStatus` to `matched` and stores `matchedProjectId`

Unassign reverses that.

**Suggested match %** on the project page (`estimateMatchPercent`) is a decorative 32–97% skill-token heuristic. It is **not** the matcher score \(C_{sp}\).

---

## Matching on the site

Admins can:

1. **Build from Firestore** — live applications → in-memory cohort → solver.
2. **Upload two `.xlsx` files** — admin exports, or external sheets such as the STI reference workbooks. If files are chosen, they beat a staged Firestore cohort.

Both paths go through [`xlsx-cohort.js`](../website/xlsx-cohort.js) (`window.DpiCohort`), then [`matcher.js`](../website/matcher.js).

**Running a match is a preview.** It does not write placements to Firestore. Use the project page to assign people.

### Stage 1 — pair score

Same idea as [matching-math.md](matching-math.md):

\[
C_{sp} = H_{sp} \cdot \big( w_{\text{pref}} f_{\text{pref}} + w_{\text{skills}} f_{\text{skills}} + w_{\text{topics}} f_{\text{topics}} + B_{sp} \big)
\]

- Hard gates: GPA ≥ project minimum; availability (see trap below). Fail → score 0.
- Soft features in [0, 1]. Default slider weights 8 / 6 / 4 (preference / skills / topics), then normalized.
- “Any project fits” bonus: +10% of the soft score on projects the student did **not** rank.

The admin matcher UI does **not** expose those sliders. `match-demo.js` calls `runMatch` with solver, top-K, and a time budget only.

### Stage 2 — the “ILP” label

The dropdown says “ILP (maximize fit)”. The browser solver is **not** Google OR-Tools:

| Cohort size | What `matcher.js` actually runs |
| --- | --- |
| ≤14 students **and** ≤12 seats | Exact branch-and-bound (`solveExact`), ~8s budget |
| Larger | Greedy by scarcity + local swaps (`solveHeuristic`) |

Top-K alternates (default 5) are true next-best only in exact mode. Heuristic mode diversifies by banning a pair from the previous solution.

`skillPolicy` (`all-soft` / `must-cover`) is accepted on `runMatch` but **ignored** on the default ILP path. Only hybrid and compare-all honor it.

Team skill **coverage** bonus defaults to 0.12. Teammate **overlap** is still coded in `teamSkillBonus` but the default slider is 0.

### Alternate solvers

Hungarian, Gale–Shapley, hybrid (GS → skill-gap repair → Hungarian fill), and compare-all. Hosts do not rank students; Gale–Shapley ranks projects by \(C_{sp}\). These are for comparison, not production.

### Python twin

[`demo/match_demo.py`](../demo/match_demo.py) is the production-quality solver: Google OR-Tools CBC, plus CLI flags for weights and `skill-policy`. Scoring rules should stay aligned with `matcher.js`; the search algorithm will not.

---

## Excel round-trip

[`xlsx-cohort.js`](../website/xlsx-cohort.js) and [`demo/xlsx_to_cohort.py`](../demo/xlsx_to_cohort.py) must stay in lockstep. If you change aliases, skill extraction, or ranking math, change **both**.

Column aliases let app exports and the STI Qualtrics workbooks convert even though headers differ. Exact header matches win; aliases ≥12 characters can also match by prefix.

**Project numbers** are assigned by `createdAt` order in `assignProjectNumbers`. Export **both** workbooks from the same admin session so student rankings line up with host rows. Student docs store `projectId` from the submitted-only catalog; export remaps via `docId` across all projects, so a stale `projectId` on the student doc is expected.

Ranking → `interest_level`: ordered choices get `max(4, 10 - rank)` (1st = 10, 2nd = 9, …). Extra “Project N” checkbox columns get 7.

Host skills are stored with `quantity_required: 0` (wishlist, not quotas).

Intern count: dedicated column if present, else parse `"N interns"` from logistics text, else 1. Topic: column if present, else inferred from title / description / skills. Min GPA defaults to 0 when missing.

---

## Form vs matcher fields

| Matcher wants | What the live forms actually collect |
| --- | --- |
| Student skills | Six rated pills (Python, SQL, Excel, Figma, R, Tableau). The generator catalog has 21 skills; reference workbooks name many more |
| `availableSummer` | Hardcoded `true` — the form does not ask |
| Project min GPA | Not on the host form → 0 |
| Topic category | Not on the host form → inferred at convert time |
| Interns needed | Not a dedicated field → parsed from logistics |

### Availability trap

The matcher treats omitted `requires_summer_9_to_5` as **true**. The converter **sets it to `false`** on every converted project, which turns the availability gate off for app exports and Firestore builds. Combined with `availableSummer: true` on save, live/app cohorts rarely fail the availability hard gate.

---

## Local run

No build step. **Do not open `index.html` as `file://`** — Google OAuth will fail.

```bash
cd "/path/to/dpi-matching-optimizer"

# Hosting emulator (still uses live Auth / Firestore / Storage)
npx -y firebase-tools@latest emulators:start --only hosting

# or any static server
python3 -m http.server 8080 --directory website
```

Authorized OAuth redirects already include `http://localhost` and `http://127.0.0.1`. You still need the live Firebase project unless you add Auth/Firestore/Storage emulators later.

**Promote an admin:** sign in once → Firestore `users/{uid}` → set `role` to `admin`.

---

## Tests

```bash
npm install
JAVA_HOME=/opt/homebrew/opt/openjdk@17 PATH="$JAVA_HOME/bin:$PATH" npm test
```

`npm test` runs `tests/*.test.mjs` against the Firestore and Storage emulators, with project `demo-dpi` and no live access. The emulators need **Java 17**. The paths above are for Homebrew's `openjdk@17`; if `java -version` already reports 17, plain `npm test` works.

---

## Deploy

```bash
./scripts/deploy-firebase.sh
```

That script runs `firebase login --reauth` with the pinned `firebase-tools@14.27.0`, then:

```text
deploy --only firestore,storage,hosting --project dpi-matching-optimizer
```

`firebase.json` is tracked and sets the security and cache headers (CSP, nosniff, COOP, long cache for `/vendor/**`). It has no `auth` block: sign-in providers and authorized domains are managed in the Firebase console. If you add a new third-party host to the page, add it to the CSP in `firebase.json`.

After JS/CSS edits, bump the `?v=` query params in `index.html`.

### App Check (optional, off by default)

App Check is the abuse brake for Firestore and Storage. The client wiring ships dormant: with `appCheckSiteKey: ""` in `firebase-config.js`, `app.js` never calls `firebase.appCheck()` and no reCAPTCHA loads. Turn it on in this order:

1. **Create the key.** In Google Cloud / Firebase console, create a reCAPTCHA Enterprise key for the site domains, then register it under Firebase console > App Check > Apps > Web (reCAPTCHA Enterprise). Put the site key in `appCheckSiteKey`, bump the `firebase-config.js?v=` query in `index.html` (do this every time the key changes), and deploy hosting.
2. **Monitor metrics.** In App Check > APIs, watch Firestore, Storage and Authentication requests. Wait until verified requests dominate and unverified ones are only old tabs or known clients.
3. **Enforce.** Only then enable enforcement per API. Enforcing early blocks real users.

`app.js` activates App Check right after `initializeApp` and before the Auth, Firestore and Storage handles are created, with token auto-refresh on. The CSP in `firebase.json` already covers the reCAPTCHA and App Check hosts.

### After-merge steps

Run these by hand, in order. Nothing here has been run yet.

1. **PRE-DEPLOY CHECK: sign-in under the CSP.** `firebase.json` sends `frame-ancestors 'none'` on `**`, on the same Hosting site as `authDomain`, and Firebase Auth embeds `/__/auth/iframe` from that site. This has not been tested against real sign-in. Deploy to a preview channel with `firebase hosting:channel:deploy csp-check --project dpi-matching-optimizer`, add the channel domain to the authorized domains if needed, and complete a real Google sign-in there, watching the console for CSP errors. If the iframe is blocked, exclude `/__/**` from the CSP header's `source` and test again. Do not deploy to live until sign-in works.
2. **Remove stray duplicates.** Delete the untracked `website/app 2.js` and `firestore 2.rules` after checking nothing in them is needed. The hosting ignore `**/* 2.*` keeps such files from deploying, but they stay confusing in the tree.
3. **Check live data for over-cap docs, read-only.** Before deploying the rules, read `projects` and `students` and list docs that break the new limits: `projectTitle` or `companyName` not a string or over 300 characters, capped long text over 20,000, `projectChoices` not a list. Owners of those docs get a named error until they shorten the field. A submitted project with a bad title or company also makes the whole `backfillCatalog` batch fail, because catalog rules apply to admins too. Have those fixed first.
4. **Compare live rules with the repo** in the console, since live Storage rules may have drifted.
5. **Deploy** rules and hosting together with `./scripts/deploy-firebase.sh`. Old open tabs fail project reads until reloaded.
6. **Backfill.** Run `await DpiAdminData.backfillCatalog()` from an admin session right after deploying. Students see an empty project list until it finishes.
7. **App Check.** Follow the steps above once the site is stable.

---

## What is not built

- Teammate avoidances and admin locks (described in the architecture plan)
- Writing solver output back to Firestore
- `skillPolicy` on the default browser ILP path
- Box report sync
- React / FastAPI / PostgreSQL
- “See past projects” on the landing page
- Auth / Firestore / Storage emulators

---

## Where else to read

| Doc | Use it for |
| --- | --- |
| [weighting-guide.md](weighting-guide.md) | Explaining the 0–10 sliders to colleagues |
| [matching-math.md](matching-math.md) | Formula sheet for \(C_{sp}\) and the ILP |
| [architecture-plan.md](architecture-plan.md) | Original design (planned stack, not what ships) |
| [../demo/README.md](../demo/README.md) | CLI setup, CBC solver, skill catalog, generator |
| [../README.md](../README.md) | Short project overview |
