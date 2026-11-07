"""Alternate stage 2 matchers for comparison against the production ILP.

The ILP in `match_demo.py` stays the real solver. These exist so the tradeoffs
are visible: Hungarian optimises seat by seat, Gale-Shapley optimises for
stability against student bids, and the hybrid pipeline runs Gale-Shapley first
and then repairs the skill gaps it leaves behind.

All three take the same compatibility matrix the ILP takes and return the same
`(status, assignments)` shape, so the report and metrics are directly comparable.
"""

from __future__ import annotations

from collections import defaultdict
from typing import Any

from match_demo import (
    DEFAULT_OVERLAP_SLIDER,
    TEAM_COVERAGE_WEIGHT,
    solve,
    team_bonus,
    team_skill_metrics,
)

Assignment = tuple[int, int, float]
MAX_REPAIR_ATTEMPTS = 50


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------
def _capacity(idx: dict[str, Any]) -> dict[int, int]:
    return {
        pid: int(project["interns_needed"]) for pid, project in idx["projects"].items()
    }


def _slots(idx: dict[str, Any], capacity: dict[int, int] | None = None) -> list[int]:
    """One entry per open seat. A 2-intern project contributes two entries."""
    capacity = capacity or _capacity(idx)
    return [pid for pid, seats in capacity.items() for _ in range(seats)]


def check_team_quotas(idx: dict[str, Any], assignments: list[Assignment]) -> list[str]:
    """Preferred skills no member of the assigned team brings."""
    return team_skill_metrics(idx, assignments)["uncovered"]


def _objective(
    idx: dict[str, Any],
    assignments: list[Assignment],
    coverage_weight: float,
    overlap_slider: float,
) -> float:
    individual = sum(score for _sid, _pid, score in assignments)
    return individual + team_bonus(idx, assignments, coverage_weight, overlap_slider)


# ---------------------------------------------------------------------------
# Hungarian — optimal 1:1 on expanded seats
# ---------------------------------------------------------------------------
def _hungarian_assign(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    students: list[int],
    slots: list[int],
) -> list[Assignment]:
    if not students or not slots:
        return []
    try:
        import numpy as np
        from scipy.optimize import linear_sum_assignment
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency hint
        raise SystemExit(
            "The Hungarian solver needs scipy.\n"
            "  cd demo && .venv/bin/pip install -r requirements.txt"
        ) from exc

    # linear_sum_assignment minimizes, so eligible pairs carry negative cost and
    # ineligible ones cost 0 — never worth taking unless nothing else is left.
    cost = np.zeros((len(students), len(slots)))
    for i, sid in enumerate(students):
        for j, pid in enumerate(slots):
            score = C.get((sid, pid), 0.0)
            if score > 0:
                cost[i][j] = -score

    rows, cols = linear_sum_assignment(cost)
    assignments: list[Assignment] = []
    for i, j in zip(rows, cols):
        sid, pid = students[i], slots[j]
        score = C.get((sid, pid), 0.0)
        if score > 0:
            assignments.append((sid, pid, score))
    return assignments


def solve_hungarian(
    idx: dict[str, Any], C: dict[tuple[int, int], float]
) -> tuple[str, list[Assignment]]:
    """Maximum-weight 1:1 matching of students to individual seats.

    Optimal per seat, but it has no notion of a team, so skill coverage is
    whatever falls out and is only audited afterwards.
    """
    assignments = _hungarian_assign(
        idx, C, sorted(idx["students"]), _slots(idx)
    )
    return ("OPTIMAL" if assignments else "INFEASIBLE"), assignments


# ---------------------------------------------------------------------------
# Gale-Shapley — hospital/residents deferred acceptance
# ---------------------------------------------------------------------------
def _student_ranking(
    idx: dict[str, Any], C: dict[tuple[int, int], float], sid: int
) -> list[int]:
    """Projects a student would accept, best first.

    Bids come first in the order the student ranked them; eligible projects they
    never ranked follow by compatibility, which is what makes "any project fits"
    students placeable.
    """
    bids = idx["bids"].get(sid, {})
    ranked = sorted(
        (pid for pid in bids if C.get((sid, pid), 0.0) > 0),
        key=lambda pid: -float(bids[pid].get("interest_level", 0)),
    )
    unranked = sorted(
        (
            pid
            for pid in idx["projects"]
            if pid not in bids and C.get((sid, pid), 0.0) > 0
        ),
        key=lambda pid: -C[(sid, pid)],
    )
    return ranked + unranked


def blocking_pairs(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    assignments: list[Assignment],
) -> int:
    """Student–project pairs that would both rather have each other.

    Zero means the match is stable: no student can name a project that would
    have preferred them over someone it took.
    """
    capacity = _capacity(idx)
    rankings = {sid: _student_ranking(idx, C, sid) for sid in idx["students"]}
    placed = {sid: pid for sid, pid, _score in assignments}
    members: dict[int, list[int]] = defaultdict(list)
    for sid, pid, _score in assignments:
        members[pid].append(sid)

    count = 0
    for sid, ranking in rankings.items():
        current = placed.get(sid)
        current_rank = ranking.index(current) if current in ranking else len(ranking)
        for pid in ranking[:current_rank]:
            team = members.get(pid, [])
            if len(team) < capacity[pid]:
                count += 1
                continue
            worst = min((C[(other, pid)] for other in team), default=0.0)
            if C[(sid, pid)] > worst:
                count += 1
    return count


def solve_gale_shapley(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    proposer: str = "student",
) -> tuple[str, list[Assignment]]:
    """Deferred acceptance with project capacity.

    Students propose down their bid order; a project holds its best applicants up
    to headcount and releases the rest. The result is stable, which means nobody
    can point at a project that would rather have had them — but it optimises
    nothing globally.
    """
    if proposer != "student":
        raise ValueError("only student-proposing deferred acceptance is implemented")

    capacity = _capacity(idx)
    rankings = {sid: _student_ranking(idx, C, sid) for sid in idx["students"]}
    held: dict[int, list[int]] = {pid: [] for pid in idx["projects"]}
    next_choice: dict[int, int] = defaultdict(int)

    free = [sid for sid, ranking in rankings.items() if ranking]
    while free:
        sid = free.pop()
        ranking = rankings[sid]
        while next_choice[sid] < len(ranking):
            pid = ranking[next_choice[sid]]
            next_choice[sid] += 1
            if capacity[pid] <= 0:
                continue
            team = held[pid]
            team.append(sid)
            # Projects rank applicants by compatibility: real hosts do not rank.
            team.sort(key=lambda s: -C[(s, pid)])
            if len(team) > capacity[pid]:
                rejected = team.pop()
                if rejected != sid:
                    free.append(rejected)
                    break
                continue
            break

    assignments = [
        (sid, pid, C[(sid, pid)]) for pid, team in held.items() for sid in team
    ]
    return ("FEASIBLE" if assignments else "INFEASIBLE"), assignments


# ---------------------------------------------------------------------------
# Hybrid — Gale-Shapley, then skill repair, then Hungarian fill
# ---------------------------------------------------------------------------
def _repair_skill_gaps(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    assignments: list[Assignment],
    *,
    skill_policy: str,
    coverage_weight: float,
    overlap_slider: float,
) -> tuple[list[Assignment], int]:
    """Swap teammates to close skill gaps Gale-Shapley left open.

    Under `must-cover` a swap is worth making whenever it covers a skill nobody
    on the team had. Under `all-soft` it has to pay for itself: the combined
    individual-plus-team score must go up.
    """
    working = list(assignments)
    swaps = 0
    attempts = 0

    def score() -> float:
        return _objective(idx, working, coverage_weight, overlap_slider)

    while attempts < MAX_REPAIR_ATTEMPTS:
        metrics = team_skill_metrics(idx, working)
        placed = {sid for sid, _pid, _score in working}
        gaps = [
            (pid, skill_id)
            for pid, p in metrics["per_project"].items()
            for skill_id in p["missing_ids"]
        ]
        if not gaps:
            break

        improved = False
        for pid, skill_id in gaps:
            attempts += 1
            if attempts > MAX_REPAIR_ATTEMPTS:
                break

            incumbents = sorted(
                (a for a in working if a[1] == pid), key=lambda a: a[2]
            )
            candidates = sorted(
                (
                    sid
                    for sid in idx["students"]
                    if sid not in placed
                    and C.get((sid, pid), 0.0) > 0
                    and skill_id in idx["student_skills"].get(sid, set())
                ),
                key=lambda sid: -C[(sid, pid)],
            )
            if not incumbents or not candidates:
                continue

            before = score()
            outgoing = incumbents[0]
            incoming = candidates[0]
            trial = [a for a in working if a != outgoing]
            trial.append((incoming, pid, C[(incoming, pid)]))

            after = _objective(idx, trial, coverage_weight, overlap_slider)
            accept = after > before + 1e-9
            if skill_policy == "must-cover":
                covered_before = team_skill_metrics(idx, working)["covered"]
                covered_after = team_skill_metrics(idx, trial)["covered"]
                accept = covered_after > covered_before
            if accept:
                working = trial
                placed.discard(outgoing[0])
                placed.add(incoming)
                swaps += 1
                improved = True
                break

        if not improved:
            break

    return working, swaps


def solve_hybrid(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    *,
    skill_policy: str = "all-soft",
    coverage_weight: float = TEAM_COVERAGE_WEIGHT,
    overlap_slider: float = DEFAULT_OVERLAP_SLIDER,
) -> tuple[str, list[Assignment], dict[str, Any]]:
    """Gale-Shapley for bid order, then skill repair, then Hungarian for leftovers."""
    _status, assignments = solve_gale_shapley(idx, C)
    violations_before = len(check_team_quotas(idx, assignments))
    phases: dict[str, Any] = {
        "gale_shapley": {
            "placed": len(assignments),
            "blocking_pairs": blocking_pairs(idx, C, assignments),
        }
    }

    assignments, swaps = _repair_skill_gaps(
        idx,
        C,
        assignments,
        skill_policy=skill_policy,
        coverage_weight=coverage_weight,
        overlap_slider=overlap_slider,
    )
    violations_after = len(check_team_quotas(idx, assignments))
    phases["quota_repair"] = {
        "swaps": swaps,
        "violations_before": violations_before,
        "violations_after": violations_after,
    }

    filled = _capacity(idx)
    for _sid, pid, _score in assignments:
        filled[pid] -= 1
    open_slots = [pid for pid, short in filled.items() if short > 0 for _ in range(short)]
    placed = {sid for sid, _pid, _score in assignments}
    spare = [sid for sid in sorted(idx["students"]) if sid not in placed]

    fill = _hungarian_assign(idx, C, spare, open_slots)
    assignments.extend(fill)
    phases["hungarian_fill"] = {"filled_slots": len(fill)}
    phases["final_violations"] = check_team_quotas(idx, assignments)

    return ("FEASIBLE" if assignments else "INFEASIBLE"), assignments, phases


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------
def _average_bid_rank(idx: dict[str, Any], assignments: list[Assignment]) -> float | None:
    """Mean position of the assigned project in the student's own ranking."""
    ranks: list[int] = []
    for sid, pid, _score in assignments:
        bids = idx["bids"].get(sid, {})
        if pid not in bids:
            continue
        ordered = sorted(
            bids, key=lambda p: -float(bids[p].get("interest_level", 0))
        )
        ranks.append(ordered.index(pid) + 1)
    return sum(ranks) / len(ranks) if ranks else None


def _summarize(
    idx: dict[str, Any],
    label: str,
    status: str,
    assignments: list[Assignment],
    coverage_weight: float,
    overlap_slider: float,
) -> dict[str, Any]:
    metrics = team_skill_metrics(idx, assignments)
    seats = sum(_capacity(idx).values())
    return {
        "label": label,
        "status": status,
        "assignments": assignments,
        "individual": sum(score for _s, _p, score in assignments),
        "objective": _objective(idx, assignments, coverage_weight, overlap_slider),
        "placed": len(assignments),
        "seats": seats,
        "coverage_pct": metrics["coverage_pct"],
        "overlaps": metrics["overlaps"],
        "uncovered": len(metrics["uncovered"]),
        "avg_rank": _average_bid_rank(idx, assignments),
    }


def compare_solvers(
    idx: dict[str, Any],
    C: dict[tuple[int, int], float],
    *,
    skill_policy: str = "all-soft",
    coverage_weight: float = TEAM_COVERAGE_WEIGHT,
    overlap_slider: float = DEFAULT_OVERLAP_SLIDER,
) -> dict[str, Any]:
    """Run every stage 2 algorithm on one compatibility matrix."""
    opts = {"coverage_weight": coverage_weight, "overlap_slider": overlap_slider}

    results: dict[str, Any] = {}
    for key, policy in (("ilp", skill_policy), ("ilp_must_cover", "must-cover")):
        if key == "ilp_must_cover" and skill_policy == "must-cover":
            continue
        status, assignments = solve(idx, C, skill_policy=policy, **opts)
        results[key] = _summarize(
            idx, f"ILP ({policy})", status, assignments, coverage_weight, overlap_slider
        )

    status, assignments = solve_hungarian(idx, C)
    results["hungarian"] = _summarize(
        idx, "Hungarian", status, assignments, coverage_weight, overlap_slider
    )

    status, assignments = solve_gale_shapley(idx, C)
    results["gale_shapley"] = _summarize(
        idx, "Gale-Shapley", status, assignments, coverage_weight, overlap_slider
    )

    status, assignments, phases = solve_hybrid(
        idx, C, skill_policy=skill_policy, **opts
    )
    results["hybrid"] = _summarize(
        idx, "Hybrid", status, assignments, coverage_weight, overlap_slider
    )
    results["hybrid"]["phases"] = phases
    return results


def print_comparison(comparison: dict[str, Any]) -> None:
    """Side-by-side table of every solver, in Markdown."""
    order = [key for key in comparison if key in
             ("ilp", "ilp_must_cover", "hungarian", "gale_shapley", "hybrid")]
    runs = [comparison[key] for key in order]

    print("## Solver comparison")
    print()
    print(
        "_Same compatibility matrix, different stage 2. Total objective is "
        "individual fit plus the team bonuses._"
    )
    print()

    def rank(run: dict[str, Any]) -> str:
        return "—" if run["avg_rank"] is None else f"{run['avg_rank']:.2f}"

    rows = [
        ["Status", *[f"`{r['status']}`" for r in runs]],
        ["Total objective", *[f"{r['objective']:.3f}" for r in runs]],
        ["Individual score", *[f"{r['individual']:.3f}" for r in runs]],
        ["Seats filled", *[f"{r['placed']} / {r['seats']}" for r in runs]],
        ["Preferred skills covered", *[f"{r['coverage_pct']:.0%}" for r in runs]],
        ["Uncovered skills", *[str(r["uncovered"]) for r in runs]],
        ["Avg bid rank (lower is better)", *[rank(r) for r in runs]],
    ]
    headers = ["Metric", *[r["label"] for r in runs]]
    print("| " + " | ".join(headers) + " |")
    print("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        print("| " + " | ".join(row) + " |")
    print()

    hybrid = comparison.get("hybrid")
    if hybrid and hybrid.get("phases"):
        print_phase_log(hybrid["phases"])


def print_phase_log(phases: dict[str, Any]) -> None:
    """What each hybrid phase contributed."""
    gs = phases.get("gale_shapley", {})
    repair = phases.get("quota_repair", {})
    fill = phases.get("hungarian_fill", {})

    print("## Hybrid phase log")
    print()
    print(
        f"1. **Gale-Shapley** placed {gs.get('placed', 0)} student(s); "
        f"{gs.get('blocking_pairs', 0)} blocking pair(s) remain."
    )
    print(
        f"2. **Quota repair** made {repair.get('swaps', 0)} swap(s), taking "
        f"uncovered skills from {repair.get('violations_before', 0)} to "
        f"{repair.get('violations_after', 0)}."
    )
    print(f"3. **Hungarian fill** seated {fill.get('filled_slots', 0)} leftover slot(s).")
    print()
    remaining = phases.get("final_violations") or []
    if remaining:
        preview = ", ".join(remaining[:6])
        suffix = "" if len(remaining) <= 6 else f", +{len(remaining) - 6} more"
        print(f"_Still uncovered: {preview}{suffix}._")
        print()
