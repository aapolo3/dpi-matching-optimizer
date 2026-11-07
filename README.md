# DPI Matching Optimizer

Custom internship matching platform that pairs undergraduate students with small startup projects.

**Stack:** Vanilla HTML/CSS/JS · Firebase Auth (Google) · Cloud Firestore · Firebase Storage · Firebase Hosting · browser matcher in JS · CLI matcher with Google OR-Tools CBC

The live UI is [`website/`](website/). There is no React, FastAPI, or PostgreSQL in production.

## Documentation

Start with the website handbook if you are taking over the site:

- **[Website handbook (handoff)](docs/website.md)** — stack, screens, roles, data model, matching, deploy
- [Weighting guide (for colleagues)](docs/weighting-guide.md)
- [Matching math reference](docs/matching-math.md)
- [Architecture & weighting plan](docs/architecture-plan.md) — original design; the React/FastAPI stack was never generated
- [Visuals](docs/visuals/) — slider diagram, formula screenshot, Mermaid flows
- [CLI matcher](demo/README.md) — `python match_demo.py` against the two compiled workbooks

## Status

- Live site: https://dpi-matching-optimizer.web.app
- Deploy: `./scripts/deploy-firebase.sh` (hosting, firestore, auth). Deploy Storage separately if [`storage.rules`](storage.rules) change.
- **Promote an admin:** after the user signs in once, open Firestore → `users/{uid}` and set `role` to `admin`

## Applications and matching data flow

Students and project hosts sign in with Google and fill in their own application,
which is saved to Firestore under the account that created it.

| Collection | Written by | Readable by |
| --- | --- | --- |
| `students/{id}` | the applicant (`ownerUid`) | that applicant and admins |
| `projects/{id}` | the host (`ownerUid`) | that host and admins |
| `catalog/{id}` | the host, in one batch with the project, or admins | any signed-in user for submitted entries; holds only `projectTitle`, `companyName`, `status`, `ownerUid`, `createdAt` so students can rank |

Admins get two compiled workbook exports from the admin board — one per audience —
and can run the matcher two ways:

1. **Build from Firestore** — read live applications and match immediately.
2. **Upload the two workbooks** — the exported files, or external ones such as the
   STI reference sheets.

Excel is the only cohort format on disk. Both paths go through the same converter,
implemented once per runtime and kept in sync:
[`website/xlsx-cohort.js`](website/xlsx-cohort.js) for the browser and
[`demo/xlsx_to_cohort.py`](demo/xlsx_to_cohort.py) for the CLI. It resolves columns
through an alias table, so app exports and the reference workbooks both convert
even though their headers differ.

Because project numbers are assigned by creation order at export time, export both
workbooks from the same admin session so the student rankings line up with the
host rows.

A match run on the admin board is a **preview**. It does not write placements to
Firestore. Assign people on the project detail page.
