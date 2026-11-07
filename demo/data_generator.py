"""Generate cohort workbooks for the ILP matching demo.

Writes the two compiled workbooks that mirror the admin Excel exports, so the
workbook -> cohort -> solver path can be exercised without Firestore. Cohorts
only exist on disk as `.xlsx`; the JSON shape stays in memory.

Skill counts follow the STI reference workbooks: hosts name 4-7 preferred tools,
students list 4-8 skills with a median of 5. See `skill_catalog.json` for the
catalog and `skill_audit.py` for where its mention counts come from.
"""

from __future__ import annotations

import argparse
import json
import random
import statistics
from collections import defaultdict
from pathlib import Path
from typing import Any

from xlsx_to_cohort import HOST_COLUMNS, STUDENT_COLUMNS, write_table

# --- Tunable stress knobs ---
PYTHON_SQL_BOTTLENECK_RATE = 0.45
UNAVAILABLE_RATE = 0.10
ANY_PROJECT_FITS_RATE = 0.30
TOPIC_ALIGNED_SHARE = 0.60  # fraction of a student's skills drawn from their topics

CATALOG_PATH = Path(__file__).with_name("skill_catalog.json")


def _load_catalog(path: Path = CATALOG_PATH) -> dict[str, Any]:
    catalog = json.loads(path.read_text())
    enabled = {name for name in catalog["enabled"]}
    skills = [s for s in catalog["skills"] if s["skill_name"] in enabled]

    category_skills: dict[str, list[int]] = {topic: [] for topic in catalog["topics"]}
    for skill in skills:
        for topic in skill["topics"]:
            category_skills[topic].append(skill["skill_id"])

    return {
        "dictionary": [
            {"skill_id": s["skill_id"], "skill_name": s["skill_name"]} for s in skills
        ],
        "topics": list(catalog["topics"]),
        "category_skills": category_skills,
        # Reference mention counts double as sampling weights, with a floor so a
        # skill nobody listed in 2026 can still show up in a generated cohort.
        "weights": {s["skill_id"]: max(1.0, float(s["student_mentions"])) for s in skills},
    }


_CATALOG = _load_catalog()
SKILLS_DICTIONARY = _CATALOG["dictionary"]
TOPICS = _CATALOG["topics"]
CATEGORY_SKILLS = _CATALOG["category_skills"]
STUDENT_SKILL_WEIGHTS = _CATALOG["weights"]
ALL_SKILL_IDS = [s["skill_id"] for s in SKILLS_DICTIONARY]


def _build_companies(n: int = 10) -> list[dict[str, Any]]:
    return [
        {
            "company_id": 101 + i,
            "company_name": f"Company {chr(65 + i)}",
            "mission": "Innovation",
        }
        for i in range(n)
    ]


def _weighted_sample(pool: list[int], k: int) -> list[int]:
    """Sample `k` skill ids without replacement, favouring common skills."""
    remaining = list(pool)
    picked: list[int] = []
    while remaining and len(picked) < k:
        weights = [STUDENT_SKILL_WEIGHTS.get(sid, 1.0) for sid in remaining]
        chosen = random.choices(remaining, weights=weights, k=1)[0]
        picked.append(chosen)
        remaining.remove(chosen)
    return picked


def _project_skill_rows(pool: list[int]) -> list[int]:
    """Preferred skills for one project — 4-7, matching the reference median."""
    n = random.choice([4, 4, 5, 5, 6, 7])
    return random.sample(pool, k=min(len(pool), n))


def generate_projects(
    num_projects: int, companies: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    projects: list[dict[str, Any]] = []
    project_requirements: list[dict[str, Any]] = []

    for i in range(num_projects):
        p_id = 201 + i
        category = random.choice(TOPICS)
        interns = random.choice([1, 2, 2, 3])  # bias toward 2

        projects.append(
            {
                "project_id": p_id,
                "company_id": random.choice(companies)["company_id"],
                "project_title": f"{category} Initiative {i + 1}",
                "interns_needed": interns,
                "min_gpa_required": random.choice([2.5, 2.8, 3.0, 3.2, 3.5]),
                "topic_category": category,
            }
        )

        # Hosts list tools they would like the team to know, never per-seat
        # counts, so headcount does not cap how many skills a project may name.
        for skill_id in _project_skill_rows(CATEGORY_SKILLS[category]):
            project_requirements.append(
                {
                    "project_id": p_id,
                    "skill_id": skill_id,
                    "quantity_required": 0,
                }
            )

    return projects, project_requirements


def _pick_bid_projects(
    student_topics: list[str], projects: list[dict[str, Any]], n_bids: int
) -> list[dict[str, Any]]:
    """Bias bids toward preferred topics; allow stretch bids."""
    preferred = [p for p in projects if p["topic_category"] in student_topics]
    other = [p for p in projects if p["topic_category"] not in student_topics]

    n_pref = min(len(preferred), max(1, n_bids - 1))
    n_stretch = min(len(other), n_bids - n_pref)
    # If not enough preferred, fill from others (and vice versa)
    picks: list[dict[str, Any]] = []
    if preferred:
        picks.extend(random.sample(preferred, k=min(n_pref, len(preferred))))
    remaining = n_bids - len(picks)
    pool = [p for p in other if p not in picks] if remaining else []
    if remaining > 0 and pool:
        picks.extend(random.sample(pool, k=min(remaining, len(pool))))
    remaining = n_bids - len(picks)
    if remaining > 0:
        leftover = [p for p in projects if p not in picks]
        if leftover:
            picks.extend(random.sample(leftover, k=min(remaining, len(leftover))))
    return picks


def _student_skill_ids(topic_prefs: list[str]) -> set[int]:
    """A student's skill set — 4-8 skills, mostly aligned to their topics.

    Most skills come from the pools behind the topics the student wants, which is
    what makes teams cover a host's wish list; the rest come from the whole
    catalog so cohorts keep the stray Swift or Tableau holder the real data has.
    """
    target = random.choice([4, 5, 5, 5, 6, 6, 7, 8])  # median 5, mean ~5.6

    chosen: list[int] = []
    if random.random() < PYTHON_SQL_BOTTLENECK_RATE:
        chosen = [1, 3]  # Python + SQL, the pair hosts ask for most often

    topic_pool = [
        sid
        for sid in dict.fromkeys(s for t in topic_prefs for s in CATEGORY_SKILLS[t])
        if sid not in chosen
    ]
    n_topic = max(0, round(TOPIC_ALIGNED_SHARE * target) - len(chosen))
    chosen += _weighted_sample(topic_pool, n_topic)

    general = [sid for sid in ALL_SKILL_IDS if sid not in chosen]
    chosen += _weighted_sample(general, target - len(chosen))
    return set(chosen)


def generate_students(
    num_students: int, projects: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
    users_students: list[dict[str, Any]] = []
    student_skills: list[dict[str, Any]] = []
    student_bids: list[dict[str, Any]] = []

    for i in range(num_students):
        s_id = 301 + i
        is_available = random.random() >= UNAVAILABLE_RATE
        topic_prefs = random.sample(TOPICS, k=random.choice([1, 2]))
        any_fits = random.random() < ANY_PROJECT_FITS_RATE

        users_students.append(
            {
                "student_id": s_id,
                "name": f"Student {i + 1}",
                "gpa": round(random.uniform(2.6, 4.0), 1),
                "topic_preferences": topic_prefs,
                "available_summer_9_to_5": is_available,
            }
        )

        for skill_id in _student_skill_ids(topic_prefs):
            student_skills.append({"student_id": s_id, "skill_id": skill_id})

        n_bids = random.choice([3, 4, 5])
        for bp in _pick_bid_projects(topic_prefs, projects, n_bids):
            student_bids.append(
                {
                    "student_id": s_id,
                    "project_id": bp["project_id"],
                    "interest_level": random.randint(4, 10),
                    "any_project_fits": any_fits,
                }
            )

    return users_students, student_skills, student_bids


def print_sanity_summary(dataset: dict[str, Any]) -> None:
    projects = dataset["projects"]
    students = dataset["users_students"]
    skills = dataset["skills_dictionary"]
    reqs = dataset["project_requirements"]
    student_skills = dataset["student_skills"]

    seats = sum(int(p["interns_needed"]) for p in projects)
    available = sum(1 for s in students if s.get("available_summer_9_to_5"))
    skill_name = {s["skill_id"]: s["skill_name"] for s in skills}

    holders: dict[int, int] = defaultdict(int)
    for row in student_skills:
        holders[row["skill_id"]] += 1

    demand: dict[int, int] = defaultdict(int)
    for row in reqs:
        demand[row["skill_id"]] += 1

    skills_per_project: dict[int, int] = defaultdict(int)
    for row in reqs:
        skills_per_project[row["project_id"]] += 1
    skills_per_student: dict[int, int] = defaultdict(int)
    for row in student_skills:
        skills_per_student[row["student_id"]] += 1

    project_counts = [skills_per_project.get(p["project_id"], 0) for p in projects]
    student_counts = [skills_per_student.get(s["student_id"], 0) for s in students]

    print("\n--- Sanity summary ---")
    print(f"Seats to fill:           {seats}")
    print(f"Students:                {len(students)}")
    print(f"Available summer 9-to-5: {available}")
    print(f"Unavailable:             {len(students) - available}")
    print(f"Bids:                    {len(dataset['student_bids'])}")
    print(f"Skill rows:              {len(student_skills)}")

    def spread(label: str, counts: list[int]) -> None:
        if not counts:
            print(f"{label:<24} —")
            return
        print(
            f"{label:<24} median={statistics.median(counts):.0f} "
            f"mean={statistics.mean(counts):.1f} "
            f"range={min(counts)}-{max(counts)}"
        )

    spread("Preferred skills/project:", project_counts)
    spread("Skills per student:", student_counts)

    print("\nSkill supply vs demand (holders vs projects preferring it):")
    for sid in sorted(skill_name, key=lambda k: -holders.get(k, 0)):
        print(
            f"  {skill_name[sid]:<14} "
            f"holders={holders.get(sid, 0):<4} wanted_by={demand.get(sid, 0)}"
        )

    warnings = 0
    for p in projects:
        interns = int(p["interns_needed"])
        # Soft eligibility sketch: available + GPA
        eligible = sum(
            1
            for s in students
            if s.get("available_summer_9_to_5")
            and float(s["gpa"]) >= float(p["min_gpa_required"])
        )
        if eligible < interns:
            print(
                f"WARNING: project {p['project_id']} ({p['project_title']}) "
                f"needs {interns} but only {eligible} students pass "
                f"availability+GPA"
            )
            warnings += 1

    unheld = [skill_name[sid] for sid in sorted(demand) if not holders.get(sid)]
    if unheld:
        print(f"WARNING: preferred but nobody holds: {', '.join(unheld)}")
        warnings += 1

    if warnings == 0:
        print("\nNo structural headcount or supply warnings.")
    else:
        print(f"\n{warnings} warning(s) above — dataset may still be interesting stress.")


def ensure_ilp_feasible(
    dataset: dict[str, Any],
    skill_policy: str = "all-soft",
) -> tuple[dict[str, Any], str]:
    """
    Soften the cohort until the CBC ILP finds a feasible assignment.

    Under `all-soft` preferred skills cannot block a solve, so the only repair
    left is easing GPA floors and headcounts. Under `must-cover` each preferred
    skill becomes a hard team constraint, and preferred rows are dropped one at a
    time until the solver succeeds.

    Returns (dataset, status_name). Raises if still infeasible afterwards, which
    means the cohort has a structural eligibility problem.
    """
    # Local import: match_demo depends on ortools; keep generator usable without it
    # for dry inspection, but feasibility repair needs the solver.
    try:
        from match_demo import DEFAULT_WEIGHTS
        from match_demo import build_matrix, index_dataset, normalize_weights, solve
    except ModuleNotFoundError as exc:
        missing = getattr(exc, "name", None) or "ortools"
        raise SystemExit(
            f"Missing dependency `{missing}`.\n\n"
            "Use the demo virtualenv (OR-Tools is installed there):\n"
            "  cd demo\n"
            "  source .venv/bin/activate   # or: .venv/bin/python data_generator.py …\n"
            "  pip install -r requirements.txt   # only if .venv is new\n"
            "  python data_generator.py --seed 42\n\n"
            "Or skip the solver check:\n"
            "  python data_generator.py --no-feasibility-repair …"
        ) from exc

    def attempt() -> str:
        idx = index_dataset(dataset)
        weights = normalize_weights(DEFAULT_WEIGHTS)
        C, _ = build_matrix(idx, weights, beta=0.1)
        status, _ = solve(idx, C, skill_policy=skill_policy)
        return status

    status = attempt()
    if status in ("OPTIMAL", "FEASIBLE"):
        return dataset, status

    if skill_policy == "must-cover":
        reqs = dataset["project_requirements"]
        dropped = 0
        # Drop rows until CBC succeeds; cohorts often carry 150+ preferred rows.
        while reqs:
            row = reqs.pop()
            dropped += 1
            status = attempt()
            if status in ("OPTIMAL", "FEASIBLE"):
                print(
                    f"  repaired: dropped {dropped} preferred-skill row(s) "
                    f"(last: project {row['project_id']} skill {row['skill_id']}) "
                    f"→ {status}"
                )
                return dataset, status
        if dropped:
            print(
                f"  repaired: removed all {dropped} preferred-skill rows; still {status}"
            )

    # Quotas gone but still infeasible: ease GPA / headcount so seats can fill.
    for project in dataset["projects"]:
        project["min_gpa_required"] = min(float(project["min_gpa_required"]), 2.5)
        if int(project["interns_needed"]) > 1:
            project["interns_needed"] = max(1, int(project["interns_needed"]) - 1)

    status = attempt()
    if status in ("OPTIMAL", "FEASIBLE"):
        print(f"  repaired: lowered GPA floors / headcounts → {status}")
        return dataset, status

    raise RuntimeError(
        f"Could not make dataset ILP-feasible (last status={status}). "
        "Try more students, fewer projects, or a different --seed."
    )


def build_dataset(num_students: int, num_projects: int) -> dict[str, Any]:
    companies = _build_companies()
    projects, project_requirements = generate_projects(num_projects, companies)
    users_students, student_skills, student_bids = generate_students(
        num_students, projects
    )
    return {
        "skills_dictionary": SKILLS_DICTIONARY,
        "companies": companies,
        "projects": projects,
        "project_requirements": project_requirements,
        "users_students": users_students,
        "student_skills": student_skills,
        "student_bids": student_bids,
    }


def _slug(value: str) -> str:
    return "".join(ch for ch in value.lower() if ch.isalnum() or ch == " ").replace(
        " ", ""
    )


def cohort_to_host_rows(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    """Project rows in the same layout the admin host export produces."""
    skill_name = {s["skill_id"]: s["skill_name"] for s in dataset["skills_dictionary"]}
    company_name = {c["company_id"]: c["company_name"] for c in dataset["companies"]}

    skills_by_project: dict[int, list[str]] = defaultdict(list)
    for row in dataset["project_requirements"]:
        name = skill_name.get(row["skill_id"])
        if name and name not in skills_by_project[row["project_id"]]:
            skills_by_project[row["project_id"]].append(name)

    rows = []
    for project in dataset["projects"]:
        company = company_name.get(project["company_id"], "Host")
        contact = _slug(company) or "host"
        rows.append(
            {
                "Project Number": project["project_id"],
                "Project Title": project["project_title"],
                "Company Name": company,
                "Project supervisor's name": f"{company} Supervisor",
                "Project supervisor's email": f"supervisor@{contact}.example",
                "Description": (
                    f"{project['project_title']} — a {project['topic_category']} "
                    "project generated for solver testing."
                ),
                "Interns Needed": project["interns_needed"],
                "How many interns would you like and for which weeks?": (
                    f"{project['interns_needed']} interns, weeks 1-10"
                ),
                "Minimum GPA": project["min_gpa_required"],
                "Topic Category": project["topic_category"],
                "What technical skills/tools will students interact with on this project?": (
                    ", ".join(skills_by_project.get(project["project_id"], []))
                ),
                "Host Days": "3 Host days",
                "Work Locations": "Chicago, IL",
                "Innovation Center": "",
                "First Interns": "No",
                "Technical Expertise": "Yes",
                "Project Structure": "Same project, as a team",
                "Deliverables": "Presentation",
                "Office Culture": "Balanced",
                "Interview Involvement": "Yes",
                "Notes": "",
                "Company Website Link": f"https://www.{contact}.example",
                "Logo File": "",
                "Status": "submitted",
                "Owner Email": f"supervisor@{contact}.example",
            }
        )
    return rows


def cohort_to_student_rows(dataset: dict[str, Any]) -> list[dict[str, Any]]:
    """Student rows in the same layout the admin student export produces.

    Rankings survive the round trip as an order, not as exact interest levels:
    the workbook stores preference order and the converter re-derives 10, 9, 8…
    """
    skill_name = {s["skill_id"]: s["skill_name"] for s in dataset["skills_dictionary"]}
    project_title = {p["project_id"]: p["project_title"] for p in dataset["projects"]}

    skills_by_student: dict[int, list[str]] = defaultdict(list)
    for row in dataset["student_skills"]:
        name = skill_name.get(row["skill_id"])
        if name and name not in skills_by_student[row["student_id"]]:
            skills_by_student[row["student_id"]].append(name)

    bids_by_student: dict[int, list[dict[str, Any]]] = defaultdict(list)
    any_fits: dict[int, bool] = {}
    for bid in dataset["student_bids"]:
        bids_by_student[bid["student_id"]].append(bid)
        if bid.get("any_project_fits"):
            any_fits[bid["student_id"]] = True

    rows = []
    for i, student in enumerate(dataset["users_students"]):
        sid = student["student_id"]
        ranked = sorted(
            bids_by_student.get(sid, []),
            key=lambda b: int(b.get("interest_level", 0)),
            reverse=True,
        )
        choices = ", ".join(
            f"Project {b['project_id']}: {project_title.get(b['project_id'], '')}".strip()
            for b in ranked
        )
        name_parts = str(student["name"]).split()
        first = name_parts[0] if name_parts else f"Student{i + 1}"
        last = " ".join(name_parts[1:]) or str(sid)

        rows.append(
            {
                "Student Number": sid,
                "First Name": first,
                "Last Name": last,
                "Full Name": student["name"],
                "Preferred Name": "",
                "Pronouns": "",
                "Gender": "",
                "Birthday": "",
                "Age at Program Start": "",
                "Personal Email Address": f"student{sid}@example.com",
                "School Email Address": f"student{sid}@school.edu",
                "Phone Number": "",
                "Race/Ethnicity": "",
                "Mailing Address": "",
                "Summer Address": "",
                "Illinois Resident": "Yes",
                "US Citizen": "Yes",
                "Illinois High School": "",
                "Non-Illinois School": "",
                "College/University Name": "Generated University",
                "Major": (student.get("topic_preferences") or ["General"])[0],
                "Minor": "",
                "Grad Yr": 2027,
                "Year": "Junior",
                "GPA": f"{student['gpa']} / 4.0",
                "Resume File": "",
                "Transcript File": "",
                "Skills": ", ".join(skills_by_student.get(sid, [])),
                "Skill Proficiency": "; ".join(
                    f"{name}: Competent" for name in skills_by_student.get(sid, [])
                ),
                "Areas of Interest": ", ".join(student.get("topic_preferences") or []),
                "Coursework High School": "",
                "Coursework College": ", ".join(
                    f"Intro to {name}" for name in skills_by_student.get(sid, [])[:2]
                ),
                "Coursework Other": "",
                "Preferred Project Length": "Summer only",
                "Transportation": "Own vehicle",
                "Laptop Access": "Yes",
                "Emergency Contact": "",
                "Available Summer 9 to 5": (
                    "Yes" if student.get("available_summer_9_to_5", True) else "No"
                ),
                "Choices": choices,
                "Any of the above - please assign me as you see fit": (
                    "Any of the above - please assign me as you see fit"
                    if any_fits.get(sid)
                    else ""
                ),
                "Why This Internship": "",
                "Chicago Tech Ecosystem": "",
                "Additional Academics": "",
                "Acknowledgements": "",
                "Status": "submitted",
                "Owner Email": f"student{sid}@example.com",
            }
        )
    return rows


def parse_args() -> argparse.Namespace:
    demo_dir = Path(__file__).resolve().parent
    p = argparse.ArgumentParser(
        description="Generate compiled cohort workbooks for the ILP matching demo"
    )
    p.add_argument("--students", type=int, default=150, help="Number of students")
    p.add_argument("--projects", type=int, default=36, help="Number of projects")
    p.add_argument(
        "--seed",
        type=int,
        default=42,
        help="RNG seed for reproducible datasets (default: 42)",
    )
    p.add_argument(
        "--skill-policy",
        choices=("all-soft", "must-cover"),
        default="all-soft",
        help="Policy the feasibility check solves under (default: all-soft)",
    )
    p.add_argument(
        "--no-feasibility-repair",
        action="store_true",
        help="Skip CBC feasibility repair (may write an INFEASIBLE cohort)",
    )
    p.add_argument(
        "--hosts-xlsx",
        type=str,
        default="generated_hosts.xlsx",
        help="Compiled host applications output (default: generated_hosts.xlsx)",
    )
    p.add_argument(
        "--students-xlsx",
        type=str,
        default="generated_students.xlsx",
        help="Compiled student applications output (default: generated_students.xlsx)",
    )
    p.add_argument(
        "--demo-dir",
        type=str,
        default=str(demo_dir),
        help=argparse.SUPPRESS,
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    random.seed(args.seed)

    dataset = build_dataset(args.students, args.projects)
    if not args.no_feasibility_repair:
        print(f"Checking ILP feasibility under --skill-policy {args.skill_policy}…")
        dataset, status = ensure_ilp_feasible(dataset, skill_policy=args.skill_policy)
        print(f"ILP status after repair: {status}")

    def resolve(name: str) -> Path:
        target = Path(name)
        return target if target.is_absolute() else Path(args.demo_dir) / target

    hosts_path = resolve(args.hosts_xlsx)
    write_table(hosts_path, HOST_COLUMNS, cohort_to_host_rows(dataset))
    print(f"Wrote {hosts_path} ({len(dataset['projects'])} host application rows).")

    students_path = resolve(args.students_xlsx)
    write_table(students_path, STUDENT_COLUMNS, cohort_to_student_rows(dataset))
    print(
        f"Wrote {students_path} "
        f"({len(dataset['users_students'])} student application rows)."
    )

    print(f"\nSeed {args.seed} — rerun the same seed to reproduce these workbooks.")
    print_sanity_summary(dataset)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
