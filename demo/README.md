# Barebone matching demo

CLI that reads the two compiled application workbooks, builds a weighted
compatibility matrix, and solves an ILP with Google OR-Tools.

Workbooks are the only cohort format on disk. The JSON shape still exists, but
only in memory: `xlsx_to_cohort.py` converts the workbooks and hands the result
straight to the solver.

## Setup

```bash
cd demo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

OR-Tools and SciPy live in `.venv` — always run generator/matcher with that env (or the helper scripts below).

## Run

Output is **Markdown** (tables + headers) so it highlights well in `bat`:

```bash
# generate a reproducible cohort, then match it
./generate.sh --seed 42
./run.sh generated_hosts.xlsx generated_students.xlsx | bat -l md
```

Same thing without the helper scripts:

```bash
source .venv/bin/activate
python data_generator.py --seed 42
python match_demo.py --hosts generated_hosts.xlsx --students generated_students.xlsx
```

The generator checks CBC feasibility and eases GPA floors or headcounts if needed so the cohort is solvable (not `INFEASIBLE`). Use `--no-feasibility-repair` only if you want a hard/unsolvable stress case on purpose.

Rerunning the same `--seed` reproduces the same workbooks, including the same skills — as long as `skill_catalog.json` has not changed.

**Large sets (default):** summary first → top-3 eligible matches per student → failure *counts* → one flat assignments table → short rejection notes.
**Small sets** (≤60 pairs): still shows the full matrix automatically.

## Matching real workbooks

The same command works on the files the admin board exports, or external ones
such as the STI reference sheets:

```bash
python match_demo.py \
  --hosts "../reference sheets/STI 2026 - Project Submissions for Matching project.xlsx" \
  --students "../reference sheets/STI 2026 - Matching Project Needs and Matching.xlsx"
```

To check what the converter reads without solving:

```bash
python xlsx_to_cohort.py --hosts hosts.xlsx --students students.xlsx
```

Columns are resolved through an alias table, so workbooks with different headers
convert without editing them first. Anything the converter has to assume is
printed as a warning: preferred skills nobody in the pool has, missing GPAs,
unknown project numbers in a student's rankings.

### Columns the converter looks for

| Workbook | Needed | Also used when present |
| --- | --- | --- |
| Hosts | project title (or title + description), technical skills/tools | project number, company name, supervisor email, interns needed, minimum GPA, topic category, intern logistics |
| Students | full name (or first + last), skills | student number, GPA, areas of interest, availability for summer 9-to-5, project choices, "any of the above" |

Host skill lists become **preferred skills**: every tool named is stored with
`quantity_required: 0`, because hosts describe what they would like their interns
to know rather than how many interns must know each thing.

The workbook round trip preserves ranking *order* rather than exact interest
levels: the workbook stores a preference list and the converter re-derives 10, 9,
8, and so on.

## Scoring

Stage 1 scores each student against each project, using the admin sliders:

| Slider | Default | Meaning |
| --- | --- | --- |
| `--pref` | 8 | How highly the student ranked this project |
| `--skills` | 6 | Share of the project's preferred skills this student personally has |
| `--topics` | 4 | Whether the project's topic is one the student asked for |

Stage 2 grades the assembled team, as a small bonus on top — individual fit still
drives the match:

| Term | Flag | Default | Meaning |
| --- | --- | --- | --- |
| Coverage | `--team-coverage` | 0.12 | Per project, share of preferred skills at least one member brings |

Stage 2 only rewards **coverage** (does the team bring the preferred tools?). Shared skills between teammates are no longer scored.

### Skill policy

```bash
python match_demo.py --hosts h.xlsx --students s.xlsx --skill-policy all-soft
python match_demo.py --hosts h.xlsx --students s.xlsx --skill-policy must-cover
```

`all-soft` (default) lets preferred skills move scores only. `must-cover` requires
a holder on the team for every preferred skill; when no assignment can satisfy
that — common, since hosts name five tools for teams of two — the solver maximizes
coverage instead and reports which skills it had to skip.

### Alternate solvers

The ILP is the production solver. The others exist to make the tradeoffs visible:

```bash
python match_demo.py --hosts h.xlsx --students s.xlsx --solver hungarian
python match_demo.py --hosts h.xlsx --students s.xlsx --solver gale-shapley
python match_demo.py --hosts h.xlsx --students s.xlsx --solver hybrid
python match_demo.py --hosts h.xlsx --students s.xlsx --solver compare-all
```

| Solver | Optimises for | Notes |
| --- | --- | --- |
| `ilp` | Total compatibility plus team bonuses | Global optimum, handles variable team sizes natively |
| `hungarian` | Total compatibility, seat by seat | No notion of a team; coverage is audited afterwards |
| `gale-shapley` | Stability against student bids | Best average bid rank, worst skill coverage |
| `hybrid` | Both, in phases | Gale-Shapley → skill-gap repair swaps → Hungarian fill; prints a phase log |

`compare-all` prints a side-by-side table of every solver before the usual report.

## Skill catalog

`skill_catalog.json` is the single source of truth for the generator's 21 skills,
their topic pools, and the reference mention counts used to weight sampling. To
see what else the reference workbooks mention:

```bash
python skill_audit.py --reference "../reference sheets"
```

That writes `skill_audit_report.md`, ranking every skill named in either workbook
and flagging which ones the converter already recognises.

## What the matcher supports

**Supported now:** GPA hard gate, availability hard gate, interest-level
preference, individual skill fit, topic fit, any-project-fits bonus, headcounts,
team skill coverage, optional must-cover policy.

**Not in this demo yet:** teammate avoidances, admin locks.

### Availability rule

Two dataset shapes are supported:

1. **Boolean, what the workbooks carry:** student field `available_summer_9_to_5`.
   Projects may set `requires_summer_9_to_5` (default **true**).
   If required and the student is `false` → hard fail.

2. **Hour windows:** project `mandatory_schedule` vs student `availability`.
   Student must fully cover the window: `student_start <= project_start` and `student_end >= project_end`.
   If a project has no schedule, the check is skipped.
