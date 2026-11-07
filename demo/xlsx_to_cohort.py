"""Convert compiled application workbooks into an in-memory matcher cohort.

Keep in lockstep with ``website/xlsx-cohort.js``. If you change aliases, skill
extraction, ranking math, or availability defaults, change both files.

Two inputs, one per audience:

  * compiled project host applications -> companies, projects, requirements
  * compiled student applications      -> students, skills, bids

Column aliases let the STI reference workbooks feed the same converter as the
files exported from the website, whose headers differ.

Converted projects set ``requires_summer_9_to_5`` to False, which turns OFF
the matcher's availability gate (the matcher treats a missing field as True).
Host skills are stored with ``quantity_required: 0`` (wishlist, not quotas).
Ranked choices become interest_level ``max(4, 10 - rank)``; extra Project-N
columns get 7.

Workbooks are the only cohort format on disk; the dict this module returns stays
in memory for ``match_demo.py``. Run it directly to dry-run a pair of workbooks:

    python xlsx_to_cohort.py --hosts hosts.xlsx --students students.xlsx
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

HOST_COLUMNS = [
    "Project Number",
    "Project Title",
    "Company Name",
    "Project supervisor's name",
    "Project supervisor's email",
    "Description",
    "Interns Needed",
    "How many interns would you like and for which weeks?",
    "Minimum GPA",
    "Topic Category",
    "What technical skills/tools will students interact with on this project?",
    "Host Days",
    "Work Locations",
    "Innovation Center",
    "First Interns",
    "Technical Expertise",
    "Project Structure",
    "Deliverables",
    "Office Culture",
    "Interview Involvement",
    "Notes",
    "Company Website Link",
    "Logo File",
    "Status",
    "Owner Email",
]

STUDENT_COLUMNS = [
    "Student Number",
    "First Name",
    "Last Name",
    "Full Name",
    "Preferred Name",
    "Pronouns",
    "Gender",
    "Birthday",
    "Age at Program Start",
    "Personal Email Address",
    "School Email Address",
    "Phone Number",
    "Race/Ethnicity",
    "Mailing Address",
    "Summer Address",
    "Illinois Resident",
    "US Citizen",
    "Illinois High School",
    "Non-Illinois School",
    "College/University Name",
    "Major",
    "Minor",
    "Grad Yr",
    "Year",
    "GPA",
    "Resume File",
    "Transcript File",
    "Skills",
    "Skill Proficiency",
    "Areas of Interest",
    "Coursework High School",
    "Coursework College",
    "Coursework Other",
    "Preferred Project Length",
    "Transportation",
    "Laptop Access",
    "Emergency Contact",
    "Available Summer 9 to 5",
    "Choices",
    "Any of the above - please assign me as you see fit",
    "Why This Internship",
    "Chicago Tech Ecosystem",
    "Additional Academics",
    "Acknowledgements",
    "Status",
    "Owner Email",
]

HOST_ALIASES: dict[str, list[str]] = {
    "project_number": ["project number", "project id", "project #", "project no"],
    "project_title": [
        "project title",
        "title",
        "project title and description (500 words or less)",
        "project title and description",
    ],
    "description": ["description", "project description"],
    "company_name": ["company name", "company", "organization", "organization name"],
    "supervisor_name": [
        "project supervisor's name",
        "project supervisor name",
        "supervisor name",
        "supervisor",
    ],
    "supervisor_email": [
        "project supervisor's email",
        "project supervisor email",
        "supervisor email",
        "email",
    ],
    "interns_needed": [
        "interns needed",
        "number of interns",
        "intern count",
        "headcount",
    ],
    "intern_logistics": [
        "how many interns would you like and for which weeks?",
        "intern logistics",
    ],
    "min_gpa": ["minimum gpa", "min gpa", "min gpa required", "minimum gpa required"],
    "topic_category": ["topic category", "topic", "category", "project type"],
    "technical_skills": [
        "what technical skills/tools will students interact with on this project?",
        "technical skills/tools",
        "technical skills",
        "skills",
    ],
    "host_days": [
        "will you host your interns for 3 host days or opt for 2?",
        "host days",
    ],
    "work_locations": [
        "primary work locations",
        "work locations",
        "what is the address of your office?",
        'where will students work during their "on-site" host days?',
    ],
    "innovation_center": [
        "innovation center membership",
        "innovation center",
        "if your organization a member of an innovation center, incubator or accelerator, please indicate that below:",
    ],
    "first_interns": [
        "will this be the first intern(s) for this supervisor?",
        "first interns",
    ],
    "expertise_support": [
        "do you have the technical expertise on your team to guide and support your interns' work?",
        "technical expertise",
    ],
    "project_structure": [
        "will all students be working on the same project as a team, the same project individually, or different individual projects?",
        "project structure",
    ],
    "deliverables": [
        "what project deliverable do you expect? (select all that apply)",
        "deliverables",
    ],
    "office_culture": ["please describe the culture of your office", "office culture"],
    "interview_involvement": [
        "would you like to be involved with the interviewing and matching process?",
        "interview involvement",
    ],
    "notes": [
        "please share anything else you'd like us to know about the project below.",
        "notes",
    ],
    "company_website": [
        "company website link",
        "company website",
        "website",
        "website link",
    ],
    "logo_file": ["logo file", "logo", "logo submission"],
    "status": ["status"],
    "owner_email": ["owner email"],
}

STUDENT_ALIASES: dict[str, list[str]] = {
    "student_number": ["student number", "student id", "student #"],
    "first_name": ["first name"],
    "last_name": ["last name"],
    "full_name": ["full name", "student name", "name"],
    "preferred_name": ["preferred name"],
    "pronouns": ["pronouns"],
    "gender": ["gender"],
    "birthday": ["birthday", "date of birth", "dob"],
    "age_at_start": [
        "age at program start",
        "what age will you be once the program starts?",
        "age",
    ],
    "personal_email": [
        "personal email address",
        "personal email",
        "email address",
        "email",
    ],
    "school_email": ["school email address", "school email"],
    "phone": ["phone number", "phone", "scholar mobile phone number"],
    "college": [
        "college/university name",
        "college / university",
        "coll/univ",
        "college",
        "university",
    ],
    "major": ["what is your major?", "major"],
    "minor": ["minor"],
    "grad_year": ["grad yr", "graduation year", "grad year"],
    "year": ["year", "yr", "class year"],
    "gpa": [
        "please list your current overall gpa.",
        "current gpa",
        "overall gpa",
        "gpa",
    ],
    "resume_file": ["resume file", "resume"],
    "transcript_file": ["transcript file", "unofficial transcript", "transcript"],
    "high_school": ["high school", "hs name", "illinois high school"],
    "illinois_high_school": [
        "illinois high school",
        "if applicable, what illinois high school did you attend?",
    ],
    "non_illinois_school": [
        "non-illinois school",
        "non illinois school",
        "please specify your non illinois school name",
    ],
    "illinois_resident": [
        "did you graduate from an illinois high school?",
        "do you live in illinois?",
        "do you live in il?",
        "illinois resident",
    ],
    "us_citizen": ["are you a u.s. citizen?", "us citizen", "u.s. citizen"],
    "race_ethnicity": [
        "please select the race or ethnic categories to which you identify.",
        "race/ethnicity",
        "race / ethnicity",
        "race",
    ],
    "home_address": ["home address", "mailing address"],
    "mailing_address": ["mailing address", "home address"],
    "summer_address": [
        "summer address",
        "please indicate below at what address you expect to be living",
    ],
    "skills": ["which skills/tools have you used?", "skills/tools", "skills"],
    "skill_proficiency": ["skill proficiency", "rate your proficiency"],
    "interests": ["areas of interest", "topic preferences", "interests"],
    "coursework_hs": ["coursework high school"],
    "coursework_college": ["coursework college"],
    "coursework_other": ["coursework other", "other (please specify)"],
    "topic_pref_1": ["please choose your first preference for the type of project"],
    "topic_pref_2": ["please choose your second preference for the type of project"],
    "start_date": ["earliest start date", "start date"],
    "hours_per_week": ["hours per week available", "hours per week", "hours / week"],
    "project_length": ["preferred project length", "project length"],
    "transportation": ["type of transportation", "transportation"],
    "laptop_access": ["laptop access"],
    "emergency_contact": ["emergency contact"],
    "available_summer": [
        "available summer 9 to 5",
        "available summer 9-5",
        "availability",
    ],
    "choices": ["choices", "project choices", "ranked choices"],
    "any_project_fits": [
        "any of the above - please assign me as you see fit",
        "any project fits",
    ],
    "why_internship": [
        "in a few sentences or more, describe why are you interested",
        "in a few sentences or more, describe why you are interested",
        "why this internship",
    ],
    "chicago_ecosystem": [
        "in a few sentences or more, tell us what working in chicago",
        "chicago tech ecosystem",
    ],
    "additional_academics": [
        "additional academics",
        "please leave any additional information that you would like us to know about your academics",
    ],
    "acknowledgements": ["acknowledgements"],
    "status": ["status"],
    "owner_email": ["owner email"],
}

SKILL_CANON = {
    "python": "Python",
    "sql": "SQL",
    "nosql": "NoSQL",
    "mongodb": "MongoDB",
    "excel": "Excel",
    "microsoft excel": "Excel",
    "java": "Java",
    "javascript": "JavaScript",
    "js": "JavaScript",
    "typescript": "TypeScript",
    "html": "HTML",
    "css": "CSS",
    "swift": "Swift",
    "kotlin": "Kotlin",
    "react": "React",
    "figma": "Figma",
    "canva": "Canva",
    "marketing": "Marketing",
    "ui/ux": "UI/UX Design",
    "ui/ux design": "UI/UX Design",
    "data analysis": "Data Analysis",
    "data analytics": "Data Analysis",
    "r": "R",
    "c++": "C++",
    "c#": "C#",
    "tableau": "Tableau",
    "power bi": "Power BI",
    "salesforce": "Salesforce",
    "workday": "Workday",
    "office": "Microsoft Office",
    "microsoft office": "Microsoft Office",
    "aws": "AWS",
    "git": "Git",
    "github": "GitHub",
    "docker": "Docker",
    "machine learning": "Machine Learning",
    "project management": "Project Management",
    "graphic design": "Graphic Design",
    "social media": "Social Media",
    "writing": "Writing",
}

TOPIC_KEYWORDS: list[tuple[str, list[str]]] = [
    ("Data", ["data", "analytics", "analysis", "dashboard", "statistics", "insights", "sql"]),
    ("Marketing", ["marketing", "market research", "social media", "campaign", "crm", "sales", "growth", "content"]),
    ("Design", ["design", "ui/ux", "ux", "user experience", "user interface", "figma", "brand", "graphic", "creative"]),
    ("Engineering", ["engineering", "software", "backend", "back-end", "frontend", "front-end", "api", "infrastructure", "devops", "mobile", "ios", "android"]),
    ("Programming", ["programming", "coding", "web development", "full stack", "app development", "automation"]),
    ("Research", ["research", "academic", "evaluation", "study"]),
    ("Business", ["business", "operations", "finance", "grant", "nonprofit", "compliance", "policy"]),
]


@dataclass
class Table:
    headers: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)


def normalize_header(value: Any) -> str:
    return re.sub(r"\s+", " ", str("" if value is None else value)).strip().lower()


def resolve_columns(headers: list[str], aliases: dict[str, list[str]]) -> dict[str, int]:
    """Exact header matches win; long aliases then match by prefix."""
    normalized = [normalize_header(h) for h in headers]
    taken: set[int] = set()
    mapping: dict[str, int] = {}

    for field_name, options in aliases.items():
        found = -1
        for alias in (normalize_header(a) for a in options):
            for i, header in enumerate(normalized):
                if i not in taken and header == alias:
                    found = i
                    break
            if found >= 0:
                break
        if found < 0:
            for alias in (normalize_header(a) for a in options):
                if len(alias) < 12:
                    continue
                for i, header in enumerate(normalized):
                    if i not in taken and header.startswith(alias):
                        found = i
                        break
                if found >= 0:
                    break
        if found >= 0:
            mapping[field_name] = found
            taken.add(found)
    return mapping


def cell(row: list[Any], columns: dict[str, int], name: str) -> str:
    index = columns.get(name)
    if index is None or index >= len(row):
        return ""
    value = row[index]
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()[:10]
    return str(value).strip()


def to_number(value: Any) -> float | None:
    match = re.search(r"-?\d+(\.\d+)?", str(value))
    return float(match.group(0)) if match else None


def is_negative(value: str) -> bool:
    return normalize_header(value) in {"no", "false", "0", "n"}


def split_list(value: str) -> list[str]:
    parts = re.split(r"[,;\n|]+|\s+and\s+", str(value or ""), flags=re.IGNORECASE)
    return [p.strip() for p in parts if p.strip()]


def canonical_skill(name: str) -> str:
    key = re.sub(r"\s+", " ", str(name)).strip().strip("•*-–—").strip().rstrip(".").lower()
    if key.count("(") != key.count(")"):
        key = re.sub(r"\s+", " ", key.replace("(", " ").replace(")", " ")).strip()
    if not key:
        return ""
    if key in SKILL_CANON:
        return SKILL_CANON[key]
    return re.sub(r"\b[a-z]", lambda m: m.group(0).upper(), key)


# Fragments starting with these read as prose, not as a tool name.
_PROSE_OPENERS = {
    "a", "ability", "an", "and", "any", "are", "as", "be", "but", "etc",
    "experience", "expertise", "familiarity", "for", "how", "if", "in", "is",
    "it", "knowledge", "of", "or", "our", "plus", "some", "strong", "the",
    "they", "this", "to", "understanding", "we", "when", "which",
    "will", "with", "would", "you", "your",
}

_KNOWN_SKILL_PATTERN = re.compile(
    "|".join(
        f"(?<![a-z0-9]){re.escape(key)}(?![a-z0-9])"
        for key in sorted(
            (k for k in SKILL_CANON if len(k) > 1), key=len, reverse=True
        )
    ),
    re.IGNORECASE,
)


def _is_skill_like(fragment: str) -> bool:
    words = fragment.split()
    if not words or len(words) > 4 or len(fragment) > 40:
        return False
    if re.search(r"[.!?:]", fragment):
        return False
    return words[0].strip("(1234567890.").lower() not in _PROSE_OPENERS


def extract_skills(text: str) -> list[str]:
    """Pull tool names out of a cell that may be a list or a paragraph.

    Host and student sheets both contain free prose where a comma-separated
    list was expected, so prose fragments are mined for known tools instead of
    being stored verbatim.
    """
    found: list[str] = []

    def add(name: str) -> None:
        canonical = canonical_skill(name)
        if canonical and canonical not in found:
            found.append(canonical)

    for fragment in split_list(text):
        if _is_skill_like(fragment):
            add(fragment)
        else:
            for match in _KNOWN_SKILL_PATTERN.findall(fragment):
                add(match)
    return found


def known_skills_in(text: str) -> list[str]:
    """Catalog tools mentioned anywhere in a block of text.

    Stricter than ``extract_skills``: it never invents a skill from an unknown
    phrase, which suits columns that describe something else (coursework, for
    instance) but happen to name tools along the way.
    """
    found: list[str] = []
    for match in _KNOWN_SKILL_PATTERN.findall(str(text or "")):
        canonical = canonical_skill(match)
        if canonical and canonical not in found:
            found.append(canonical)
    return found


def match_topics(text: str) -> list[str]:
    haystack = f" {str(text or '').lower()} "
    hits: list[str] = []
    for topic, keywords in TOPIC_KEYWORDS:
        for keyword in keywords:
            if re.search(rf"\b{re.escape(keyword)}\b", haystack):
                hits.append(topic)
                break
    return hits


def infer_topic(text: str) -> str:
    hits = match_topics(text)
    return hits[0] if hits else "General"


class SkillRegistry:
    def __init__(self) -> None:
        self._by_name: dict[str, int] = {}
        self.dictionary: list[dict[str, Any]] = []

    def id_for(self, raw_name: str) -> int | None:
        name = canonical_skill(raw_name)
        if not name:
            return None
        key = name.lower()
        if key in self._by_name:
            return self._by_name[key]
        skill_id = len(self.dictionary) + 1
        self._by_name[key] = skill_id
        self.dictionary.append({"skill_id": skill_id, "skill_name": name})
        return skill_id


def shorten_title(title: str, limit: int = 70) -> str:
    """Trim a title pulled out of a combined title+description cell."""
    clean = re.split(r"\s+[-–—:]\s+", title)[0].strip() or title.strip()
    if len(clean) <= limit:
        return clean
    cut = clean[:limit].rsplit(" ", 1)[0]
    return (cut or clean[:limit]).rstrip(",;") + "…"


def parse_project_number(value: str) -> int | None:
    match = re.search(r"(\d+)", str(value or ""))
    return int(match.group(1)) if match else None


def intern_count_columns(headers: list[str]) -> list[tuple[int, int]]:
    """Columns like 'How many interns ... [3 interns]'."""
    out = []
    for i, header in enumerate(headers):
        match = re.search(r"\[(\d+)\s*interns?\]", normalize_header(header))
        if match:
            out.append((i, int(match.group(1))))
    return out


def project_bid_columns(headers: list[str]) -> list[tuple[int, int]]:
    """Columns named exactly 'Project 7' carry per-project interest."""
    out = []
    for i, header in enumerate(headers):
        match = re.fullmatch(r"project\s+(\d+)", normalize_header(header))
        if match:
            out.append((i, int(match.group(1))))
    return out


def coursework_columns(headers: list[str]) -> list[int]:
    """Course-history columns, the only skill signal on some student sheets.

    Entries such as "Intro to Java - College" name a tool even though the
    question is about coursework, so they are mined for catalog skills.
    """
    return [
        i
        for i, header in enumerate(headers)
        if (
            "courses you have taken" in normalize_header(header)
            or "coursework high school" in normalize_header(header)
            or "coursework college" in normalize_header(header)
            or "coursework other" in normalize_header(header)
        )
    ]


def build_projects(
    table: Table, skills: SkillRegistry, warnings: list[str]
) -> tuple[list[dict], list[dict], list[dict]]:
    columns = resolve_columns(table.headers, HOST_ALIASES)
    intern_cols = intern_count_columns(table.headers)
    title_index = columns.get("project_title")
    combined_title = title_index is not None and normalize_header(
        table.headers[title_index]
    ).startswith("project title and description")

    if "technical_skills" not in columns:
        warnings.append(
            "Host workbook: no column matched the technical skills question, "
            "so projects carry no skill requirements."
        )

    company_ids: dict[str, int] = {}
    companies: list[dict] = []
    projects: list[dict] = []
    requirements: list[dict] = []
    used_ids: set[int] = set()

    for i, row in enumerate(table.rows):
        raw_title = cell(row, columns, "project_title")
        raw_description = cell(row, columns, "description")
        if not raw_title and not raw_description:
            continue

        title, description = raw_title, raw_description
        if combined_title and raw_title:
            first = re.split(r"(?<=\.)\s+|\n", raw_title)[0]
            title = shorten_title((first or raw_title).rstrip(".").strip())
            if not description:
                description = raw_title
        if not title:
            title = f"Project {i + 1}"

        project_id = parse_project_number(cell(row, columns, "project_number")) or i + 1
        while project_id in used_ids:
            project_id += 1
        used_ids.add(project_id)

        supervisor_email = cell(row, columns, "supervisor_email")
        company_name = cell(row, columns, "company_name")
        if not company_name:
            prefix = re.split(r"\s+[-–—]\s+", title)[0]
            if prefix and prefix != title and len(prefix) <= 40:
                company_name = prefix.strip()
        if not company_name and "@" in supervisor_email:
            company_name = supervisor_email.split("@")[1]
        if not company_name:
            company_name = f"Host {project_id}"

        if company_name not in company_ids:
            company_ids[company_name] = 101 + len(companies)
            companies.append(
                {
                    "company_id": company_ids[company_name],
                    "company_name": company_name,
                    "mission": cell(row, columns, "innovation_center") or "Project host",
                }
            )

        interns = to_number(cell(row, columns, "interns_needed"))
        if not interns:
            for index, count in intern_cols:
                if index < len(row) and str(row[index] or "").strip():
                    interns = count
                    break
        if not interns:
            match = re.search(
                r"(\d+)\s*interns?", cell(row, columns, "intern_logistics"), re.IGNORECASE
            )
            if match:
                interns = int(match.group(1))
        interns = max(1, min(10, int(interns or 1)))

        skills_text = cell(row, columns, "technical_skills")
        topic = cell(row, columns, "topic_category") or infer_topic(
            f"{title} {description} {skills_text}"
        )

        projects.append(
            {
                "project_id": project_id,
                "company_id": company_ids[company_name],
                "project_title": title,
                "interns_needed": interns,
                "min_gpa_required": to_number(cell(row, columns, "min_gpa")) or 0,
                "topic_category": topic,
                # Matcher treats omitted requires_summer_9_to_5 as True. Force
                # False so converted app/STI cohorts do not fail availability.
                "requires_summer_9_to_5": False,
            }
        )

        wanted: list[int] = []
        for raw in extract_skills(skills_text):
            skill_id = skills.id_for(raw)
            if skill_id and skill_id not in wanted:
                wanted.append(skill_id)

        # Hosts name tools they would like their interns to know, not per-seat
        # quotas, so every skill is stored as a preference (quantity 0). The
        # solver's --skill-policy decides whether coverage becomes mandatory.
        for skill_id in wanted:
            requirements.append(
                {
                    "project_id": project_id,
                    "skill_id": skill_id,
                    "quantity_required": 0,
                }
            )

    return companies, projects, requirements


def parse_choices(text: str) -> list[int]:
    if not text:
        return []
    parts = re.split(r",\s*(?=project\s+\d+)", str(text), flags=re.IGNORECASE)
    numbers = [parse_project_number(part) for part in parts]
    return [n for n in numbers if n is not None]


def build_students(
    table: Table,
    skills: SkillRegistry,
    project_ids: set[int],
    warnings: list[str],
) -> tuple[list[dict], list[dict], list[dict]]:
    columns = resolve_columns(table.headers, STUDENT_ALIASES)
    bid_cols = project_bid_columns(table.headers)
    course_cols = coursework_columns(table.headers)

    if "skills" not in columns and not course_cols:
        warnings.append(
            "Student workbook: no column matched skills/tools, so skill "
            "scoring is inactive for every applicant."
        )

    students: list[dict] = []
    student_skills: list[dict] = []
    bids: list[dict] = []
    used_ids: set[int] = set()
    missing_gpa = 0
    any_fits_without_bids = 0
    unknown_projects: set[int] = set()

    for i, row in enumerate(table.rows):
        first = cell(row, columns, "first_name")
        last = cell(row, columns, "last_name")
        full = cell(row, columns, "full_name")
        personal_email = cell(row, columns, "personal_email")
        name = full or " ".join(p for p in (first, last) if p) or personal_email
        if not name:
            continue

        raw_id = to_number(cell(row, columns, "student_number"))
        student_id = int(raw_id) if raw_id else 301 + i
        while student_id in used_ids:
            student_id += 1
        used_ids.add(student_id)

        gpa = to_number(cell(row, columns, "gpa"))
        if gpa is None:
            missing_gpa += 1

        topics: list[str] = []
        for chunk in split_list(cell(row, columns, "interests")):
            for topic in match_topics(chunk):
                if topic not in topics:
                    topics.append(topic)
        for name_field in ("topic_pref_1", "topic_pref_2", "major"):
            for topic in match_topics(cell(row, columns, name_field)):
                if topic not in topics:
                    topics.append(topic)

        available_raw = cell(row, columns, "available_summer")
        students.append(
            {
                "student_id": student_id,
                "name": name,
                "first_name": first,
                "last_name": last,
                "personal_email": personal_email,
                "school_email": cell(row, columns, "school_email"),
                "phone": cell(row, columns, "phone"),
                "college": cell(row, columns, "college"),
                "major": cell(row, columns, "major"),
                "year": cell(row, columns, "year"),
                "grad_year": cell(row, columns, "grad_year"),
                "gpa": 0 if gpa is None else gpa,
                "high_school": cell(row, columns, "high_school"),
                "illinois_resident": cell(row, columns, "illinois_resident"),
                "us_citizen": cell(row, columns, "us_citizen"),
                "home_address": cell(row, columns, "home_address"),
                "start_date": cell(row, columns, "start_date"),
                "hours_per_week": cell(row, columns, "hours_per_week"),
                "work_mode": cell(row, columns, "work_mode"),
                "project_length": cell(row, columns, "project_length"),
                "why_internship": cell(row, columns, "why_internship"),
                "chicago_ecosystem": cell(row, columns, "chicago_ecosystem"),
                "topic_preferences": topics,
                "available_summer_9_to_5": (
                    not is_negative(available_raw) if available_raw else True
                ),
            }
        )

        named = extract_skills(cell(row, columns, "skills"))
        named.extend(known_skills_in(cell(row, columns, "skill_proficiency")))
        coursework = " ; ".join(
            str(row[i]) for i in course_cols if i < len(row) and row[i]
        )
        seen: set[int] = set()
        for raw in named + known_skills_in(coursework):
            skill_id = skills.id_for(raw)
            if skill_id and skill_id not in seen:
                seen.add(skill_id)
                student_skills.append({"student_id": student_id, "skill_id": skill_id})

        any_fits_raw = cell(row, columns, "any_project_fits")
        any_fits = bool(any_fits_raw) and not is_negative(any_fits_raw)

        ranked = parse_choices(cell(row, columns, "choices"))
        bid_ids: list[int] = []
        for pid in ranked:
            if pid not in bid_ids:
                bid_ids.append(pid)
        for index, pid in bid_cols:
            if index < len(row) and str(row[index] or "").strip() and pid not in bid_ids:
                bid_ids.append(pid)

        placed = 0
        for rank, pid in enumerate(bid_ids):
            if pid not in project_ids:
                unknown_projects.add(pid)
                continue
            placed += 1
            bids.append(
                {
                    "student_id": student_id,
                    "project_id": pid,
                    "interest_level": max(4, 10 - rank) if rank < len(ranked) else 7,
                    "any_project_fits": any_fits,
                }
            )

        if any_fits and placed == 0:
            any_fits_without_bids += 1

    if missing_gpa:
        warnings.append(
            f"{missing_gpa} student(s) had no GPA; recorded as 0 "
            "(projects without a GPA floor still accept them)."
        )
    if unknown_projects:
        listed = ", ".join(str(n) for n in sorted(unknown_projects))
        warnings.append(f"Ignored rankings for unknown project number(s): {listed}.")
    if any_fits_without_bids:
        warnings.append(
            f'{any_fits_without_bids} student(s) marked "any project fits" but ranked '
            "no projects; they match on skills and topics only."
        )

    return students, student_skills, bids


def warn_unsupplied_preferences(
    requirements: list[dict],
    student_skills: list[dict],
    skills: SkillRegistry,
    warnings: list[str],
) -> None:
    """Flag preferred skills no applicant holds.

    Preferences never block a solve, but a tool nobody in the pool has can only
    drag scores down, so it is worth surfacing rather than silently absorbing.
    """
    if not requirements:
        return

    holders = {row["skill_id"] for row in student_skills}
    if not holders:
        warnings.append(
            f"All {len(requirements)} preferred project skill(s) are unmatched: "
            "the host workbook's skill lists were read fine, but the student "
            "workbook records no skills for anyone."
        )
        return

    names = {s["skill_id"]: s["skill_name"] for s in skills.dictionary}
    missing = sorted(
        {
            names.get(row["skill_id"], str(row["skill_id"]))
            for row in requirements
            if row["skill_id"] not in holders
        }
    )
    if missing:
        preview = ", ".join(missing[:6])
        suffix = "" if len(missing) <= 6 else f", +{len(missing) - 6} more"
        warnings.append(
            f"{len(missing)} preferred skill(s) that no applicant listed: "
            f"{preview}{suffix}."
        )


def build_cohort(
    host_table: Table | None, student_table: Table | None
) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    skills = SkillRegistry()

    companies, projects, requirements = build_projects(
        host_table or Table(), skills, warnings
    )
    project_ids = {p["project_id"] for p in projects}
    students, student_skills, bids = build_students(
        student_table or Table(), skills, project_ids, warnings
    )

    warn_unsupplied_preferences(requirements, student_skills, skills, warnings)

    if not projects:
        warnings.append("No project rows were found.")
    if not students:
        warnings.append("No student rows were found.")
    if students and not bids:
        warnings.append(
            "No project rankings found; preference scoring is inactive for this cohort."
        )

    seats = sum(int(p["interns_needed"]) for p in projects)
    if seats > len(students):
        warnings.append(
            f"Projects request {seats} seats but only {len(students)} student(s) are "
            "available; expect an infeasible solve."
        )

    cohort = {
        "skills_dictionary": skills.dictionary,
        "companies": companies,
        "projects": projects,
        "project_requirements": requirements,
        "users_students": students,
        "student_skills": student_skills,
        "student_bids": bids,
    }
    return cohort, warnings


def _require_openpyxl():
    try:
        import openpyxl  # noqa: PLC0415
    except ModuleNotFoundError as exc:  # pragma: no cover - dependency hint
        raise SystemExit(
            "Missing dependency `openpyxl`.\n\n"
            "Install it in the demo virtualenv:\n"
            "  cd demo\n"
            "  .venv/bin/pip install -r requirements.txt"
        ) from exc
    return openpyxl


def read_table(path: Path) -> Table:
    """Read the first worksheet into a header row plus data rows."""
    openpyxl = _require_openpyxl()
    book = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheet = book[book.sheetnames[0]]

    headers: list[str] | None = None
    rows: list[list[Any]] = []
    for raw in sheet.iter_rows(values_only=True):
        values = list(raw)
        if all(v is None or str(v).strip() == "" for v in values):
            continue
        if headers is None:
            headers = ["" if v is None else str(v) for v in values]
            continue
        rows.append(values)
    book.close()

    if headers is None:
        raise SystemExit(f"{path} looks empty.")
    return Table(headers=headers, rows=rows)


def write_table(path: Path, columns: list[str], rows: list[dict[str, Any]]) -> None:
    """Write dict rows as a workbook using the canonical column order."""
    openpyxl = _require_openpyxl()
    book = openpyxl.Workbook()
    sheet = book.active
    sheet.append(columns)
    for row in rows:
        sheet.append([row.get(name, "") for name in columns])
    for i, name in enumerate(columns, start=1):
        sheet.column_dimensions[
            openpyxl.utils.get_column_letter(i)
        ].width = min(48, max(12, len(name) + 2))
    book.save(path)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Inspect what the matcher reads from compiled workbooks"
    )
    p.add_argument("--hosts", type=str, help="Compiled project host applications (.xlsx)")
    p.add_argument("--students", type=str, help="Compiled student applications (.xlsx)")
    return p.parse_args()


def main() -> int:
    """Dry-run the converter so workbook problems surface before a solve.

    Cohorts are never written to disk: `match_demo.py` converts the same
    workbooks in memory and solves directly.
    """
    args = parse_args()
    if not args.hosts and not args.students:
        print("Provide --hosts and/or --students.", file=sys.stderr)
        return 1

    host_table = read_table(Path(args.hosts)) if args.hosts else None
    student_table = read_table(Path(args.students)) if args.students else None

    cohort, warnings = build_cohort(host_table, student_table)

    print(
        f"Read {len(cohort['projects'])} project(s), "
        f"{len(cohort['users_students'])} student(s), "
        f"{len(cohort['student_bids'])} bid(s), "
        f"{len(cohort['skills_dictionary'])} skill(s), "
        f"{len(cohort['project_requirements'])} preferred skill row(s)."
    )
    for warning in warnings:
        print(f"  warning: {warning}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
