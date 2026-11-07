"""Rank the skills named in reference workbooks against the generator catalog.

Read-only helper for deciding which skills belong in `skill_catalog.json`. It
parses the same columns the converter reads, so a skill that shows up here is a
skill the matcher can actually score.

  python skill_audit.py --reference "../reference sheets"
"""

from __future__ import annotations

import argparse
import json
import statistics
from collections import Counter
from pathlib import Path

from xlsx_to_cohort import (
    HOST_ALIASES,
    SKILL_CANON,
    STUDENT_ALIASES,
    coursework_columns,
    extract_skills,
    known_skills_in,
    read_table,
    resolve_columns,
)

CATALOG_PATH = Path(__file__).with_name("skill_catalog.json")
REPORT_PATH = Path(__file__).with_name("skill_audit_report.md")


def _skills_per_row(table, alias_key: str, aliases: dict) -> list[list[str]]:
    """Canonical skill names per row, from the column matching `alias_key`."""
    columns = resolve_columns(table.headers, aliases)
    index = columns.get(alias_key)
    if index is None:
        return []

    course_cols = coursework_columns(table.headers) if alias_key == "skills" else []
    per_row: list[list[str]] = []
    for row in table.rows:
        text = row[index] if index < len(row) else None
        found = extract_skills(str(text)) if text else []
        if not found and text:
            found = known_skills_in(str(text))
        for course_index in course_cols:
            if course_index < len(row) and row[course_index]:
                for name in known_skills_in(str(row[course_index])):
                    if name not in found:
                        found.append(name)
        if found:
            per_row.append(found)
    return per_row


def _counts(per_row: list[list[str]]) -> Counter:
    counter: Counter = Counter()
    for names in per_row:
        for name in set(names):
            counter[name] += 1
    return counter


def _md_table(lines: list[str], headers: list[str], rows: list[list[str]]) -> None:
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")


def build_report(reference: Path) -> str:
    hosts = next(reference.glob("*Project Submissions*.xlsx"), None)
    students = next(reference.glob("*Needs and Matching*.xlsx"), None)
    if hosts is None or students is None:
        raise SystemExit(
            f"Could not find both reference workbooks in {reference}.\n"
            "Expected files matching '*Project Submissions*.xlsx' and "
            "'*Needs and Matching*.xlsx'."
        )

    host_rows = _skills_per_row(read_table(hosts), "technical_skills", HOST_ALIASES)
    student_rows = _skills_per_row(read_table(students), "skills", STUDENT_ALIASES)
    host_counts = _counts(host_rows)
    student_counts = _counts(student_rows)

    catalog = json.loads(CATALOG_PATH.read_text())
    enabled = {name.lower() for name in catalog["enabled"]}
    canon = {name.lower() for name in SKILL_CANON.values()}

    lines = ["# Skill audit", ""]
    lines.append(f"_Hosts: `{hosts.name}` · Students: `{students.name}`_")
    lines.append("")

    lines.append("## Skills listed per application")
    lines.append("")
    _md_table(
        lines,
        ["Source", "Rows with skills", "Median", "Mean"],
        [
            [
                label,
                str(len(rows)),
                f"{statistics.median(len(r) for r in rows):.0f}" if rows else "—",
                f"{statistics.mean(len(r) for r in rows):.1f}" if rows else "—",
            ]
            for label, rows in (("Hosts", host_rows), ("Students", student_rows))
        ],
    )

    lines.append("## Enabled catalog coverage")
    lines.append("")
    _md_table(
        lines,
        ["Skill", "Host mentions", "Student mentions"],
        [
            [
                skill["skill_name"],
                str(host_counts.get(skill["skill_name"], 0)),
                str(student_counts.get(skill["skill_name"], 0)),
            ]
            for skill in catalog["skills"]
        ],
    )

    lines.append("## Candidates not in the catalog")
    lines.append("")
    lines.append(
        "_Ranked by total mentions. `Canonical` means the converter already maps "
        "the name, so enabling it needs no alias work._"
    )
    lines.append("")
    candidates = [
        (name, host_counts.get(name, 0), student_counts.get(name, 0))
        for name in set(host_counts) | set(student_counts)
        if name.lower() not in enabled
    ]
    candidates.sort(key=lambda row: (-(row[1] + row[2]), row[0].lower()))
    _md_table(
        lines,
        ["Skill", "Host", "Student", "Canonical"],
        [
            [name, str(host), str(student), "yes" if name.lower() in canon else "no"]
            for name, host, student in candidates[:40]
        ],
    )
    if len(candidates) > 40:
        lines.append(
            f"_{len(candidates) - 40} rarer candidate(s) omitted — mostly one-off "
            "prose fragments from free-text answers._"
        )
        lines.append("")

    return "\n".join(lines) + "\n"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Audit reference workbook skills")
    p.add_argument(
        "--reference",
        type=str,
        default=str(Path(__file__).resolve().parent.parent / "reference sheets"),
        help="Folder holding the two STI reference workbooks",
    )
    p.add_argument(
        "--out",
        type=str,
        default=str(REPORT_PATH),
        help=f"Markdown report path (default: {REPORT_PATH.name})",
    )
    return p.parse_args()


def main() -> int:
    args = parse_args()
    report = build_report(Path(args.reference))
    out = Path(args.out)
    out.write_text(report)
    print(f"Wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
