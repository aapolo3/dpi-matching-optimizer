"""
Barebone matching demo.

Reads the two compiled application workbooks, builds a compatibility matrix,
solves an ILP with Google OR-Tools CBC, and prints draft assignments.

The live website uses website/matcher.js instead — same scoring rules, but a
custom exact/heuristic search, not this CBC solver. Do not assume they return
the same assignments.

Usage:
  python match_demo.py --hosts hosts.xlsx --students students.xlsx | bat -l md
  python match_demo.py --hosts h.xlsx --students s.xlsx --skill-policy must-cover
  python match_demo.py --hosts h.xlsx --students s.xlsx --solver compare-all
  python match_demo.py --hosts h.xlsx --students s.xlsx --full-matrix --all-failures
"""

from __future__ import annotations

import argparse
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any

from ortools.linear_solver import pywraplp

# ---------------------------------------------------------------------------
# Defaults (admin sliders 0–10)
# ---------------------------------------------------------------------------
DEFAULT_WEIGHTS = {
    "preference": 8.0,
    "skills": 6.0,
    "topics": 4.0,
}
ANY_PROJECT_BONUS_BETA = 0.10  # +10% soft score for unbidded projects

# Stage 2 team bonuses. Deliberately small: individual fit drives the match, and
# these only break ties between teams that score about the same person by person.
TEAM_COVERAGE_WEIGHT = 0.12  # per project, when every preferred skill is covered
DEFAULT_OVERLAP_SLIDER = 0.0  # overlap reward disabled; kept for CLI overrides only

# Price of a skill left uncovered when `must-cover` cannot be satisfied outright.
# Large enough to dominate individual fit, so coverage is maximized first.
UNCOVERED_SKILL_PENALTY = 10.0

# Map project mandatory_schedule.days -> student availability hour fields
_DAY_FIELDS = {
    "weekdays": ("weekdays_start_hour", "weekdays_end_hour"),
    "weekday": ("weekdays_start_hour", "weekdays_end_hour"),
    "weekends": ("weekends_start_hour", "weekends_end_hour"),
    "weekend": ("weekends_start_hour", "weekends_end_hour"),
}

def normalize_weights(raw: dict[str, float]) -> dict[str, float]:
    total = sum(raw.values())
    if total <= 0:
        n = len(raw)
        return {k: 1.0 / n for k in raw}
    return {k: v / total for k, v in raw.items()}


def index_dataset(data: dict[str, Any]) -> dict[str, Any]:
    skills = {s["skill_id"]: s["skill_name"] for s in data["skills_dictionary"]}
    companies = {c["company_id"]: c for c in data["companies"]}
    projects = {p["project_id"]: p for p in data["projects"]}
    students = {s["student_id"]: s for s in data["users_students"]}

    student_skills: dict[int, set[int]] = defaultdict(set)
    for row in data["student_skills"]:
        student_skills[row["student_id"]].add(row["skill_id"])

    # project_id -> list of (skill_id, quantity_required)
    project_reqs: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for row in data["project_requirements"]:
        project_reqs[row["project_id"]].append(
            (row["skill_id"], int(row["quantity_required"]))
        )

    # student_id -> {project_id: bid}
    bids: dict[int, dict[int, dict[str, Any]]] = defaultdict(dict)
    any_fits: dict[int, bool] = defaultdict(bool)
    for bid in data["student_bids"]:
        sid, pid = bid["student_id"], bid["project_id"]
        bids[sid][pid] = bid
        if bid.get("any_project_fits"):
            any_fits[sid] = True

    return {
        "skills": skills,
        "companies": companies,
        "projects": projects,
        "students": students,
        "student_skills": student_skills,
        "project_reqs": project_reqs,
        "bids": bids,
        "any_fits": any_fits,
    }


# ---------------------------------------------------------------------------
# Team skills
# ---------------------------------------------------------------------------
def preferred_skills(idx: dict[str, Any], pid: int) -> set[int]:
    """Skills the host named for a project. Quantities are not host input."""
    return {skill_id for skill_id, _qty in idx["project_reqs"].get(pid, [])}


def overlap_weight(coverage_weight: float, overlap_slider: float) -> float:
    """Turn the 0–10 overlap slider into a bonus weight relative to coverage.

    At 10 a second holder of a skill is worth as much as covering that skill in
    the first place; at 0 overlap earns nothing.
    """
    return coverage_weight * max(0.0, min(10.0, overlap_slider)) / 10.0


def team_skill_metrics(
    idx: dict[str, Any],
    assignments: list[tuple[int, int, float]],
) -> dict[str, Any]:
    """Coverage and overlap of preferred skills across each assembled team."""
    members: dict[int, list[int]] = defaultdict(list)
    for sid, pid, _score in assignments:
        members[pid].append(sid)

    covered = 0
    overlaps = 0
    total = 0
    uncovered: list[str] = []
    per_project: dict[int, dict[str, Any]] = {}

    for pid in idx["projects"]:
        prefs = preferred_skills(idx, pid)
        if not prefs:
            continue
        team = members.get(pid, [])
        p_covered = 0
        p_overlaps = 0
        missing: list[str] = []
        missing_ids: list[int] = []
        for skill_id in sorted(prefs):
            holders = sum(
                1 for sid in team if skill_id in idx["student_skills"].get(sid, set())
            )
            name = idx["skills"].get(skill_id, str(skill_id))
            if holders >= 1:
                p_covered += 1
            else:
                missing.append(name)
                missing_ids.append(skill_id)
                uncovered.append(f"{idx['projects'][pid]['project_title']}: {name}")
            if holders >= 2:
                p_overlaps += 1
        per_project[pid] = {
            "covered": p_covered,
            "overlaps": p_overlaps,
            "size": len(prefs),
            "missing": missing,
            "missing_ids": missing_ids,
        }
        covered += p_covered
        overlaps += p_overlaps
        total += len(prefs)

    return {
        "covered": covered,
        "overlaps": overlaps,
        "total": total,
        "coverage_pct": (covered / total) if total else 1.0,
        "uncovered": uncovered,
        "per_project": per_project,
    }


def team_bonus(
    idx: dict[str, Any],
    assignments: list[tuple[int, int, float]],
    coverage_weight: float,
    overlap_slider: float,
) -> float:
    """Stage 2 score for an assignment, on the same scale for every solver."""
    w_ovl = overlap_weight(coverage_weight, overlap_slider)
    metrics = team_skill_metrics(idx, assignments)
    bonus = 0.0
    for p in metrics["per_project"].values():
        bonus += (coverage_weight * p["covered"] + w_ovl * p["overlaps"]) / p["size"]
    return bonus


# ---------------------------------------------------------------------------
# Soft features in [0, 1]
# ---------------------------------------------------------------------------
def feature_preference(sid: int, pid: int, idx: dict[str, Any]) -> float:
    bid = idx["bids"].get(sid, {}).get(pid)
    if not bid:
        return 0.0
    # interest_level assumed 0–10
    return max(0.0, min(1.0, float(bid["interest_level"]) / 10.0))


def feature_skills(sid: int, pid: int, idx: dict[str, Any]) -> float:
    """Fraction of the project's preferred skills this student personally has.

    Depth counts: someone bringing 4 of 6 preferred tools scores 0.67 and beats
    two applicants who each bring one. Team-level coverage is scored separately,
    in the ILP objective, so this stays a purely individual measure.
    """
    needed = preferred_skills(idx, pid)
    if not needed:
        return 1.0
    have = idx["student_skills"].get(sid, set())
    return len(needed & have) / len(needed)


def feature_topics(sid: int, pid: int, idx: dict[str, Any]) -> float:
    prefs = {t.lower() for t in idx["students"][sid].get("topic_preferences", [])}
    category = str(idx["projects"][pid].get("topic_category", "")).lower()
    if not prefs or not category:
        return 0.0
    if category in prefs:
        return 1.0
    # light partial credit for substring overlap (e.g. "Data" vs nothing)
    if any(category in p or p in category for p in prefs):
        return 0.5
    return 0.0


FEATURES = {
    "preference": feature_preference,
    "skills": feature_skills,
    "topics": feature_topics,
}


def hard_gate_gpa(sid: int, pid: int, idx: dict[str, Any]) -> bool:
    gpa = float(idx["students"][sid]["gpa"])
    minimum = float(idx["projects"][pid].get("min_gpa_required", 0.0))
    return gpa >= minimum


def hard_gate_availability(
    sid: int, pid: int, idx: dict[str, Any]
) -> tuple[bool, str | None]:
    """
    Availability hard gate — supports two dataset shapes:

    1) Boolean, what the workbooks carry: student.available_summer_9_to_5.
       Projects may set requires_summer_9_to_5 (default True).
       If required and student is false → ineligible.

    2) Hour windows: project.mandatory_schedule vs student.availability.
       Student window must fully cover the project's mandatory hours.
       If the project has no mandatory_schedule, the gate is skipped.
    """
    student = idx["students"][sid]
    project = idx["projects"][pid]

    # --- Boolean summer 9–5 flag ---
    if "available_summer_9_to_5" in student:
        requires = project.get("requires_summer_9_to_5", True)
        if requires and not bool(student["available_summer_9_to_5"]):
            return False, "not available summer 9-to-5"
        return True, None

    # --- Legacy schedule windows ---
    schedule = project.get("mandatory_schedule")
    if not schedule:
        return True, None

    avail = student.get("availability")
    if not avail:
        return False, "no availability provided for mandatory schedule"

    day_key = str(schedule.get("days", "")).strip().lower()
    fields = _DAY_FIELDS.get(day_key)
    if fields is None:
        return False, f"unknown schedule days '{schedule.get('days')}'"

    start_key, end_key = fields
    stu_start = avail.get(start_key)
    stu_end = avail.get(end_key)
    if stu_start is None or stu_end is None:
        return False, f"unavailable on {day_key}"

    proj_start = int(schedule["start_hour"])
    proj_end = int(schedule["end_hour"])
    stu_start_i = int(stu_start)
    stu_end_i = int(stu_end)

    # Full coverage: student window must contain [proj_start, proj_end]
    if stu_start_i <= proj_start and stu_end_i >= proj_end:
        return True, None

    return (
        False,
        (
            f"schedule mismatch ({day_key} "
            f"available {stu_start_i}-{stu_end_i}, "
            f"project needs {proj_start}-{proj_end})"
        ),
    )


def compatibility(
    sid: int,
    pid: int,
    idx: dict[str, Any],
    weights: dict[str, float],
    beta: float,
) -> tuple[float, dict[str, Any]]:
    detail: dict[str, Any] = {"hard_pass": False, "features": {}, "bonus": 0.0}

    if not hard_gate_gpa(sid, pid, idx):
        detail["reason"] = "GPA below minimum"
        return 0.0, detail

    ok_avail, avail_reason = hard_gate_availability(sid, pid, idx)
    if not ok_avail:
        detail["reason"] = avail_reason or "availability mismatch"
        return 0.0, detail

    detail["hard_pass"] = True
    soft = 0.0
    for name, fn in FEATURES.items():
        val = fn(sid, pid, idx)
        detail["features"][name] = round(val, 4)
        soft += weights[name] * val

    # Any-project-fits: bonus only on projects the student did NOT bid on
    bidded = pid in idx["bids"].get(sid, {})
    if idx["any_fits"].get(sid) and not bidded and soft > 0:
        bonus = beta * soft
        detail["bonus"] = round(bonus, 4)
        soft += bonus

    detail["soft"] = round(soft, 4)
    return soft, detail


def build_matrix(
    idx: dict[str, Any],
    weights: dict[str, float],
    beta: float,
) -> tuple[dict[tuple[int, int], float], dict[tuple[int, int], dict[str, Any]]]:
    C: dict[tuple[int, int], float] = {}
    details: dict[tuple[int, int], dict[str, Any]] = {}
    for sid in idx["students"]:
        for pid in idx["projects"]:
            score, detail = compatibility(sid, pid, idx, weights, beta)
            C[(sid, pid)] = score
            details[(sid, pid)] = detail
    return C, details

# ---------------------------------------------------------------------------
# ILP
# ---------------------------------------------------------------------------
def solve(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    *,
    skill_policy: str = "all-soft",
    coverage_weight: float = TEAM_COVERAGE_WEIGHT,
    overlap_slider: float = DEFAULT_OVERLAP_SLIDER,
) -> tuple[str, list[tuple[int, int, float]]]:
    """Solve stage 2 with OR-Tools CBC.

    `must-cover` first tries genuine hard coverage constraints. Cohorts often
    cannot satisfy them — hosts name five tools for teams of two — so rather than
    answering a bare INFEASIBLE the solve is retried with coverage as a heavily
    penalised goal, and the skills it still had to skip are reported.
    """
    status, assignments = _solve_ilp(
        idx,
        C,
        skill_policy=skill_policy,
        coverage_weight=coverage_weight,
        overlap_slider=overlap_slider,
    )
    if skill_policy == "must-cover" and status == "INFEASIBLE":
        print(
            "warning: no assignment covers every preferred skill; maximizing "
            "coverage instead (see the team skill coverage table).",
            file=sys.stderr,
        )
        status, assignments = _solve_ilp(
            idx,
            C,
            skill_policy="max-cover",
            coverage_weight=coverage_weight,
            overlap_slider=overlap_slider,
        )
    return status, assignments


def _solve_ilp(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    *,
    skill_policy: str,
    coverage_weight: float,
    overlap_slider: float,
) -> tuple[str, list[tuple[int, int, float]]]:
    """
    Maximize sum C[s,p] * x[s,p] plus the team coverage bonus.

    Constraints:
    - each student at most one project
    - each project exact headcount
    - C==0 => x==0
    - `must-cover` makes every preferred skill need a holder on the team,
      `max-cover` prices missing coverage far above any individual fit, and
      `all-soft` lets skills only move the score
    """
    solver = pywraplp.Solver.CreateSolver("CBC")
    if solver is None:
        raise RuntimeError("CBC solver unavailable")

    students = list(idx["students"])
    projects = list(idx["projects"])
    w_ovl = overlap_weight(coverage_weight, overlap_slider)

    x = {}
    for sid in students:
        for pid in projects:
            if C[(sid, pid)] <= 0:
                continue
            x[(sid, pid)] = solver.BoolVar(f"x_{sid}_{pid}")

    objective = [C[(sid, pid)] * var for (sid, pid), var in x.items()]

    # One project per student
    for sid in students:
        vars_s = [x[(sid, pid)] for pid in projects if (sid, pid) in x]
        if vars_s:
            solver.Add(solver.Sum(vars_s) <= 1)

    # Exact headcount
    for pid in projects:
        need = int(idx["projects"][pid]["interns_needed"])
        vars_p = [x[(sid, pid)] for sid in students if (sid, pid) in x]
        if need > 0 and len(vars_p) < need:
            return "INFEASIBLE", []
        solver.Add(solver.Sum(vars_p) == need)

    # Team skill terms. Bonuses are divided by the number of preferred skills so
    # a project asking for seven tools cannot outweigh one asking for four.
    for pid in projects:
        prefs = preferred_skills(idx, pid)
        if not prefs:
            continue
        for skill_id in sorted(prefs):
            holders = [
                x[(sid, pid)]
                for sid in students
                if (sid, pid) in x and skill_id in idx["student_skills"].get(sid, set())
            ]
            if not holders:
                # Nobody eligible has it: no bonus to earn, and forcing coverage
                # would only report INFEASIBLE instead of a usable assignment.
                continue
            if skill_policy == "must-cover":
                solver.Add(solver.Sum(holders) >= 1)

            covered = solver.BoolVar(f"cov_{pid}_{skill_id}")
            solver.Add(covered <= solver.Sum(holders))
            weight = (
                UNCOVERED_SKILL_PENALTY
                if skill_policy == "max-cover"
                else coverage_weight / len(prefs)
            )
            objective.append(weight * covered)

            if w_ovl > 0 and len(holders) >= 2:
                shared = solver.BoolVar(f"ovl_{pid}_{skill_id}")
                solver.Add(2 * shared <= solver.Sum(holders))
                objective.append(w_ovl / len(prefs) * shared)

    solver.Maximize(solver.Sum(objective))
    status = solver.Solve()
    status_name = {
        pywraplp.Solver.OPTIMAL: "OPTIMAL",
        pywraplp.Solver.FEASIBLE: "FEASIBLE",
        pywraplp.Solver.INFEASIBLE: "INFEASIBLE",
        pywraplp.Solver.UNBOUNDED: "UNBOUNDED",
        pywraplp.Solver.ABNORMAL: "ABNORMAL",
        pywraplp.Solver.NOT_SOLVED: "NOT_SOLVED",
    }.get(status, str(status))

    assignments: list[tuple[int, int, float]] = []
    if status in (pywraplp.Solver.OPTIMAL, pywraplp.Solver.FEASIBLE):
        for (sid, pid), var in x.items():
            if var.solution_value() > 0.5:
                assignments.append((sid, pid, C[(sid, pid)]))

    return status_name, assignments


# ---------------------------------------------------------------------------
# Reporting (Markdown — looks good with: ... | bat -l md)
# ---------------------------------------------------------------------------
SMALL_MATRIX_CELLS = 60  # auto full matrix only when students×projects ≤ this


def rejection_reason(
    sid: int,
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    details: dict[tuple[int, int], dict[str, Any]],
) -> str:
    """Short explanation for why a student was left unassigned."""
    eligible = [pid for pid in idx["projects"] if C[(sid, pid)] > 0]
    if not eligible:
        reason_counts: dict[str, int] = defaultdict(int)
        for pid in idx["projects"]:
            d = details[(sid, pid)]
            if not d["hard_pass"]:
                reason = d.get("reason", "ineligible")
                if reason.startswith("schedule mismatch"):
                    reason = "schedule mismatch"
                reason_counts[reason] += 1
        if reason_counts:
            parts = [
                f"{r} ×{n}"
                for r, n in sorted(reason_counts.items(), key=lambda x: -x[1])
            ]
            return "ineligible for all projects — " + "; ".join(parts[:4])
        return "no positive compatibility with any project"

    ranked = sorted(eligible, key=lambda pid: C[(sid, pid)], reverse=True)
    best = ranked[0]
    top = ", ".join(
        f"{idx['projects'][pid]['project_title']} ({C[(sid, pid)]:.2f})"
        for pid in ranked[:3]
    )
    extra = f" (+{len(ranked) - 3} more)" if len(ranked) > 3 else ""
    return (
        f"eligible but not selected — best options: {top}{extra}; "
        f"top C={C[(sid, best)]:.3f} — seats went to stronger fits"
    )


def _md_table(headers: list[str], rows: list[list[str]]) -> None:
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        print("| " + " | ".join(row) + " |")


def print_feature_breakdown(
    idx: dict[str, Any],
    details: dict[tuple[int, int], dict[str, Any]],
    *,
    only_positive: bool = True,
) -> None:
    print("## Feature breakdown")
    print()
    if only_positive:
        print(
            "_Showing pairs that passed hard gates. "
            "Add `--all-pairs` to include failures._"
        )
        print()
    rows: list[list[str]] = []
    for (sid, pid), d in sorted(details.items()):
        if only_positive and not d["hard_pass"]:
            continue
        name = idx["students"][sid]["name"]
        title = idx["projects"][pid]["project_title"]
        if not d["hard_pass"]:
            rows.append([name, title, "fail", d.get("reason", "—"), "—", "—"])
            continue
        feats = d.get("features", {})
        feat_s = ", ".join(f"{k}={v}" for k, v in feats.items())
        rows.append(
            [
                name,
                title,
                "pass",
                feat_s or "—",
                f"{d.get('bonus', 0.0):.4f}",
                f"{d.get('soft', 0.0):.4f}",
            ]
        )
    if not rows:
        print("_No rows to show._")
        print()
        return
    _md_table(
        ["Student", "Project", "Hard", "Features", "Bonus", "Soft C"],
        rows,
    )
    print()


def _print_at_a_glance(
    idx: dict[str, Any],
    status: str,
    assignments: list[tuple[int, int, float]],
    details: dict[tuple[int, int], dict[str, Any]],
    team: dict[str, Any],
    bonus: float,
) -> float:
    n_students = len(idx["students"])
    n_projects = len(idx["projects"])
    seats = sum(int(p["interns_needed"]) for p in idx["projects"].values())
    assigned_ids = {sid for sid, _, _ in assignments}
    n_assigned = len(assigned_ids)
    hard_fails = sum(1 for d in details.values() if not d["hard_pass"])
    filled_projects = len({pid for _, pid, _ in assignments})
    individual = sum(score for _, _, score in assignments)
    total = individual + bonus

    print("## At a glance")
    print()
    _md_table(
        ["Metric", "Value"],
        [
            ["Students", str(n_students)],
            ["Projects", str(n_projects)],
            ["Seats to fill", str(seats)],
            ["Assigned", str(n_assigned)],
            ["Unassigned", str(n_students - n_assigned)],
            ["Projects with assignees", f"{filled_projects} / {n_projects}"],
            ["Unfilled projects", str(n_projects - filled_projects)],
            ["Hard-gate fail pairs", str(hard_fails)],
            [
                "Preferred skills covered",
                f"{team['covered']} / {team['total']} ({team['coverage_pct']:.0%})",
            ],
            ["Solver", f"`{status}`"],
            ["Individual score", f"`{individual:.3f}`"],
            ["Team bonus", f"`{bonus:.3f}`"],
            ["Total objective", f"`{total:.3f}`"],
        ],
    )
    print()
    return total


def _print_top_matches(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    top_k: int,
) -> None:
    print(f"## Top {top_k} matches per student")
    print()
    print("_Only scores **> 0** (eligible). Full grid: `--full-matrix`._")
    print()
    rows: list[list[str]] = []
    for sid, stu in idx["students"].items():
        ranked = sorted(
            ((pid, C[(sid, pid)]) for pid in idx["projects"] if C[(sid, pid)] > 0),
            key=lambda t: t[1],
            reverse=True,
        )[:top_k]
        if not ranked:
            rows.append([stu["name"], "—", "no eligible projects"])
            continue
        for pid, score in ranked:
            rows.append(
                [stu["name"], idx["projects"][pid]["project_title"], f"{score:.3f}"]
            )
    _md_table(["Student", "Project", "C"], rows)
    print()


def _print_full_matrix(idx: dict[str, Any], C: dict[tuple[int, int], float]) -> None:
    print("## Compatibility matrix `C[s,p]`")
    print()
    print("_Closer to **1.0** = stronger fit. **0** = hard-gate fail or no soft fit._")
    print()
    proj_ids = list(idx["projects"])
    headers = ["Student"] + [idx["projects"][pid]["project_title"] for pid in proj_ids]
    rows = [
        [stu["name"]] + [f"{C[(sid, pid)]:.3f}" for pid in proj_ids]
        for sid, stu in idx["students"].items()
    ]
    _md_table(headers, rows)
    print()


def _print_hard_failures(
    idx: dict[str, Any],
    details: dict[tuple[int, int], dict[str, Any]],
    *,
    show_all: bool,
) -> None:
    print("## Hard gate failures")
    print()
    failures = [
        (sid, pid, details[(sid, pid)].get("reason", "hard fail"))
        for (sid, pid), d in details.items()
        if not d["hard_pass"]
    ]
    if not failures:
        print("_None._")
        print()
        return

    by_reason: dict[str, int] = defaultdict(int)
    for _, _, reason in failures:
        key = reason
        if reason.startswith("schedule mismatch"):
            key = "schedule mismatch"
        by_reason[key] += 1

    print(f"**{len(failures)}** student–project pairs blocked.")
    print()
    _md_table(
        ["Reason", "Count"],
        [[r, str(n)] for r, n in sorted(by_reason.items(), key=lambda x: -x[1])],
    )
    print()

    if not show_all:
        print("_Detail omitted. Pass `--all-failures` to list every pair._")
        print()
        return

    _md_table(
        ["Student", "Project", "Reason"],
        [
            [
                idx["students"][sid]["name"],
                idx["projects"][pid]["project_title"],
                reason,
            ]
            for sid, pid, reason in failures
        ],
    )
    print()


def _print_team_skills(idx: dict[str, Any], team: dict[str, Any]) -> None:
    """How well each assembled team covers the host's wish list."""
    print("### Team skill coverage")
    print()
    rows = [
        [
            idx["projects"][pid]["project_title"],
            f"{p['covered']} / {p['size']}",
            ", ".join(p["missing"]) if p["missing"] else "—",
        ]
        for pid, p in team["per_project"].items()
    ]
    if not rows:
        print("_No projects list preferred skills._")
        print()
        return
    _md_table(["Project", "Covered", "Nobody brings"], rows)
    print()


def print_report(
    idx: dict[str, Any],
    weights: dict[str, float],
    raw_sliders: dict[str, float],
    C: dict[tuple[int, int], float],
    details: dict[tuple[int, int], dict[str, Any]],
    status: str,
    assignments: list[tuple[int, int, float]],
    dataset_name: str = "",
    *,
    full_matrix: bool = False,
    top_k: int = 3,
    all_failures: bool = False,
    skill_policy: str = "all-soft",
    coverage_weight: float = TEAM_COVERAGE_WEIGHT,
    overlap_slider: float = DEFAULT_OVERLAP_SLIDER,
    solver_name: str = "ilp",
) -> None:
    title = dataset_name or "match run"
    n_students = len(idx["students"])
    n_projects = len(idx["projects"])
    cells = n_students * n_projects
    team = team_skill_metrics(idx, assignments)
    bonus = team_bonus(idx, assignments, coverage_weight, overlap_slider)

    print(f"# Matching report — `{title}`")
    print()
    print(f"_{n_students} students × {n_projects} projects ({cells} pairs)_")
    print()
    print(f"_Solver `{solver_name}` · skill policy `{skill_policy}`_")
    print()

    total = _print_at_a_glance(idx, status, assignments, details, team, bonus)

    print("## Weights")
    print()
    print("_Stage 1 scores each student against each project._")
    print()
    _md_table(
        ["Factor", "Slider (0–10)", "Normalized"],
        [[k, f"{raw_sliders[k]:.1f}", f"{weights[k]:.2%}"] for k in raw_sliders],
    )
    print()
    print("_Stage 2 grades the assembled team, as a small bonus on top._")
    print()
    _md_table(
        ["Team term", "Setting", "Weight per project"],
        [
            [
                "Coverage — each preferred skill someone brings",
                f"{coverage_weight:.2f} fixed",
                f"{coverage_weight:.3f}",
            ],
        ],
    )
    print()

    show_full = full_matrix or cells <= SMALL_MATRIX_CELLS
    if show_full:
        _print_full_matrix(idx, C)
    else:
        _print_top_matches(idx, C, top_k)

    _print_hard_failures(
        idx, details, show_all=all_failures or cells <= SMALL_MATRIX_CELLS
    )

    print(f"## Solver status: `{status}`")
    print()
    assigned_ids = {sid for sid, _pid, _score in assignments}

    if status not in ("OPTIMAL", "FEASIBLE"):
        print("> No feasible assignment under current constraints.")
        print()
        print("## Rejected / unassigned")
        print()
        for sid, stu in idx["students"].items():
            print(f"- **{stu['name']}** — {rejection_reason(sid, idx, C, details)}")
        print()
        return

    print("## Draft assignments")
    print()
    by_project: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for sid, pid, score in assignments:
        by_project[pid].append((sid, score))

    assign_rows: list[list[str]] = []
    unfilled: list[str] = []
    for pid, proj in idx["projects"].items():
        company = idx["companies"][proj["company_id"]]["company_name"]
        members = by_project.get(pid, [])
        if not members:
            unfilled.append(
                f"{proj['project_title']} ({company}, need {proj['interns_needed']})"
            )
            continue
        for sid, score in members:
            stu = idx["students"][sid]
            sk = [
                idx["skills"][skid]
                for skid in sorted(idx["student_skills"].get(sid, set()))
            ]
            assign_rows.append(
                [
                    proj["project_title"],
                    company,
                    stu["name"],
                    f"{stu['gpa']}",
                    ", ".join(sk) if sk else "—",
                    f"{score:.3f}",
                ]
            )

    if assign_rows:
        assign_rows.sort(key=lambda r: (r[0], r[2]))
        _md_table(
            ["Project", "Company", "Student", "GPA", "Skills", "C"],
            assign_rows,
        )
    else:
        print("_No assignments._")
    print()

    if unfilled:
        print("### Unfilled projects")
        print()
        for line in unfilled:
            print(f"- {line}")
        print()

    _print_team_skills(idx, team)

    print(f"**Total objective:** `{total:.3f}`")
    print()
    print(
        "_Individual compatibility for the chosen assignments plus the team "
        "coverage bonus — what the ILP maximizes._"
    )
    print()

    print("## Rejected / unassigned")
    print()
    rejected = [sid for sid in idx["students"] if sid not in assigned_ids]
    if not rejected:
        print("_None — every student was assigned._")
    else:
        for sid in rejected:
            stu = idx["students"][sid]
            print(f"- **{stu['name']}** — {rejection_reason(sid, idx, C, details)}")
    print()

    if not show_full:
        print("---")
        print()
        print(
            "_Tips:_ `--full-matrix` · `--all-failures` · "
            f"`--top {top_k}` · `--dump-matrix`"
        )
        print()


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Barebone ILP matching demo")
    p.add_argument(
        "--hosts",
        required=True,
        type=str,
        help="Compiled project host applications (.xlsx)",
    )
    p.add_argument(
        "--students",
        required=True,
        type=str,
        help="Compiled student applications (.xlsx)",
    )
    p.add_argument("--pref", type=float, default=DEFAULT_WEIGHTS["preference"])
    p.add_argument("--skills", type=float, default=DEFAULT_WEIGHTS["skills"])
    p.add_argument("--topics", type=float, default=DEFAULT_WEIGHTS["topics"])
    p.add_argument(
        "--overlap",
        type=float,
        default=DEFAULT_OVERLAP_SLIDER,
        metavar="0-10",
        help=argparse.SUPPRESS,  # overlap reward removed; flag kept for experiments
    )
    p.add_argument(
        "--team-coverage",
        type=float,
        default=TEAM_COVERAGE_WEIGHT,
        help=(
            "Bonus per project when the team covers every preferred skill "
            f"(default {TEAM_COVERAGE_WEIGHT})"
        ),
    )
    p.add_argument(
        "--skill-policy",
        choices=("all-soft", "must-cover"),
        default="all-soft",
        help=(
            "all-soft: preferred skills only move scores. "
            "must-cover: every preferred skill needs a holder on the team."
        ),
    )
    p.add_argument(
        "--solver",
        choices=("ilp", "hungarian", "gale-shapley", "hybrid", "compare-all"),
        default="ilp",
        help="Stage 2 algorithm; compare-all runs every one side by side",
    )
    p.add_argument(
        "--beta",
        type=float,
        default=ANY_PROJECT_BONUS_BETA,
        help="Any-project-fits bonus fraction (default 0.10)",
    )
    p.add_argument(
        "--full-matrix",
        action="store_true",
        help="Print the full student×project compatibility grid",
    )
    p.add_argument(
        "--top",
        type=int,
        default=3,
        metavar="K",
        help="Top-K eligible matches per student when matrix is collapsed (default 3)",
    )
    p.add_argument(
        "--all-failures",
        action="store_true",
        help="List every hard-gate failure pair (default: counts only on large sets)",
    )
    p.add_argument(
        "--dump-matrix",
        action="store_true",
        help="Print per-pair feature breakdown (eligible pairs by default)",
    )
    p.add_argument(
        "--all-pairs",
        action="store_true",
        help="With --dump-matrix, include hard-gate failures too",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()

    raw_sliders = {
        "preference": args.pref,
        "skills": args.skills,
        "topics": args.topics,
    }
    weights = normalize_weights(raw_sliders)

    from xlsx_to_cohort import build_cohort, read_table

    for label, given in (("--hosts", args.hosts), ("--students", args.students)):
        if not Path(given).exists():
            print(f"Workbook not found for {label}: {given}", file=sys.stderr)
            return 1

    data, warnings = build_cohort(
        read_table(Path(args.hosts)),
        read_table(Path(args.students)),
    )
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    source_name = f"{Path(args.hosts).name} + {Path(args.students).name}"

    idx = index_dataset(data)
    C, details = build_matrix(idx, weights, beta=args.beta)

    if args.dump_matrix:
        print_feature_breakdown(
            idx, details, only_positive=not args.all_pairs
        )

    solver_opts = {
        "skill_policy": args.skill_policy,
        "coverage_weight": args.team_coverage,
        "overlap_slider": args.overlap,
    }

    if args.solver == "compare-all":
        from alternate_solvers import compare_solvers, print_comparison

        comparison = compare_solvers(idx, C, **solver_opts)
        print_comparison(comparison)
        chosen = comparison["ilp"]
        status, assignments = chosen["status"], chosen["assignments"]
    elif args.solver == "ilp":
        status, assignments = solve(idx, C, **solver_opts)
    else:
        from alternate_solvers import (
            print_phase_log,
            solve_gale_shapley,
            solve_hungarian,
            solve_hybrid,
        )

        if args.solver == "hungarian":
            status, assignments = solve_hungarian(idx, C)
        elif args.solver == "gale-shapley":
            status, assignments = solve_gale_shapley(idx, C)
        else:
            status, assignments, phases = solve_hybrid(idx, C, **solver_opts)
            print_phase_log(phases)

    print_report(
        idx,
        weights,
        raw_sliders,
        C,
        details,
        status,
        assignments,
        dataset_name=source_name,
        full_matrix=args.full_matrix,
        top_k=max(1, args.top),
        all_failures=args.all_failures,
        skill_policy=args.skill_policy,
        coverage_weight=args.team_coverage,
        overlap_slider=args.overlap,
        solver_name=args.solver,
    )
    return 0 if status in ("OPTIMAL", "FEASIBLE", "HEURISTIC") else 2


if __name__ == "__main__":
    raise SystemExit(main())
