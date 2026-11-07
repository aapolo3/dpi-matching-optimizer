/**
 * Shared cohort schema for the browser.
 *
 * Keep in lockstep with demo/xlsx_to_cohort.py. If you change aliases, skill
 * extraction, ranking math, or availability defaults, change both files.
 *
 * One place defines the compiled workbook layouts so three paths stay in sync:
 *   Firestore docs -> rows -> .xlsx export
 *   .xlsx upload   -> rows -> cohort JSON
 *   Firestore docs -> rows -> cohort JSON
 *
 * Column aliases let the STI reference workbooks feed the same converter as
 * app-exported files, whose headers differ.
 *
 * Converted projects set requires_summer_9_to_5: false, which turns OFF the
 * matcher's availability gate (matcher.js treats a missing field as true).
 * Host skills are stored with quantity_required: 0 (wishlist, not quotas).
 * Ranked choices become interest_level max(4, 10 - rank); extra Project-N
 * columns get 7.
 */

(function () {
  "use strict";

  const HOST_COLUMNS = [
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
  ];

  const STUDENT_COLUMNS = [
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
  ];

  // Alias lists are normalized at load; long Qualtrics headers match by prefix.
  const HOST_ALIASES = {
    projectNumber: ["project number", "project id", "project #", "project no"],
    projectTitle: [
      "project title",
      "title",
      "project title and description (500 words or less)",
      "project title and description",
    ],
    description: ["description", "project description"],
    companyName: ["company name", "company", "organization", "organization name"],
    supervisorName: [
      "project supervisor's name",
      "project supervisor name",
      "supervisor name",
      "supervisor",
    ],
    supervisorEmail: [
      "project supervisor's email",
      "project supervisor email",
      "supervisor email",
      "email",
    ],
    internsNeeded: [
      "interns needed",
      "number of interns",
      "intern count",
      "headcount",
    ],
    internLogistics: [
      "how many interns would you like and for which weeks?",
      "intern logistics",
    ],
    minGpa: ["minimum gpa", "min gpa", "min gpa required", "minimum gpa required"],
    topicCategory: ["topic category", "topic", "category", "project type"],
    technicalSkills: [
      "what technical skills/tools will students interact with on this project?",
      "technical skills/tools",
      "technical skills",
      "skills",
    ],
    hostDays: [
      "will you host your interns for 3 host days or opt for 2?",
      "host days",
    ],
    workLocations: [
      "primary work locations",
      "work locations",
      "what is the address of your office?",
      "where will students work during their \"on-site\" host days?",
    ],
    innovationCenter: [
      "innovation center membership",
      "innovation center",
      "if your organization a member of an innovation center, incubator or accelerator, please indicate that below:",
    ],
    firstInterns: [
      "will this be the first intern(s) for this supervisor?",
      "first interns",
    ],
    expertiseSupport: [
      "do you have the technical expertise on your team to guide and support your interns' work?",
      "technical expertise",
    ],
    projectStructure: [
      "will all students be working on the same project as a team, the same project individually, or different individual projects?",
      "project structure",
    ],
    deliverables: [
      "what project deliverable do you expect? (select all that apply)",
      "deliverables",
    ],
    officeCulture: ["please describe the culture of your office", "office culture"],
    interviewInvolvement: [
      "would you like to be involved with the interviewing and matching process?",
      "interview involvement",
    ],
    notes: [
      "please share anything else you'd like us to know about the project below.",
      "notes",
    ],
    companyWebsite: [
      "company website link",
      "company website",
      "website",
      "website link",
    ],
    logoFile: ["logo file", "logo", "logo submission"],
    status: ["status"],
    ownerEmail: ["owner email"],
  };

  const STUDENT_ALIASES = {
    studentNumber: ["student number", "student id", "student #"],
    firstName: ["first name"],
    lastName: ["last name"],
    fullName: ["full name", "student name", "name"],
    preferredName: ["preferred name"],
    pronouns: ["pronouns"],
    gender: ["gender"],
    birthday: ["birthday", "date of birth", "dob"],
    ageAtStart: [
      "age at program start",
      "what age will you be once the program starts?",
      "age",
    ],
    personalEmail: [
      "personal email address",
      "personal email",
      "email address",
      "email",
    ],
    schoolEmail: ["school email address", "school email"],
    phone: ["phone number", "phone", "scholar mobile phone number"],
    college: [
      "college/university name",
      "college / university",
      "coll/univ",
      "college",
      "university",
    ],
    major: ["what is your major?", "major"],
    minor: ["minor"],
    gradYear: ["grad yr", "graduation year", "grad year"],
    year: ["year", "yr", "class year"],
    gpa: [
      "please list your current overall gpa.",
      "current gpa",
      "overall gpa",
      "gpa",
    ],
    resumeFile: ["resume file", "resume"],
    transcriptFile: ["transcript file", "unofficial transcript", "transcript"],
    highSchool: ["high school", "hs name", "illinois high school"],
    illinoisHighSchool: [
      "illinois high school",
      "if applicable, what illinois high school did you attend?",
    ],
    nonIllinoisSchool: [
      "non-illinois school",
      "non illinois school",
      "please specify your non illinois school name",
    ],
    illinoisResident: [
      "did you graduate from an illinois high school?",
      "do you live in illinois?",
      "do you live in il?",
      "illinois resident",
    ],
    usCitizen: ["are you a u.s. citizen?", "us citizen", "u.s. citizen"],
    raceEthnicity: [
      "please select the race or ethnic categories to which you identify.",
      "race/ethnicity",
      "race / ethnicity",
      "race",
    ],
    homeAddress: ["home address", "mailing address"],
    mailingAddress: ["mailing address", "home address"],
    summerAddress: [
      "summer address",
      "please indicate below at what address you expect to be living",
    ],
    skills: ["which skills/tools have you used?", "skills/tools", "skills"],
    skillProficiency: ["skill proficiency", "rate your proficiency"],
    interests: ["areas of interest", "topic preferences", "interests"],
    courseworkHs: ["coursework high school"],
    courseworkCollege: ["coursework college"],
    courseworkOther: ["coursework other", "other (please specify)"],
    topicPref1: [
      "please choose your first preference for the type of project",
    ],
    topicPref2: [
      "please choose your second preference for the type of project",
    ],
    startDate: ["earliest start date", "start date"],
    hoursPerWeek: ["hours per week available", "hours per week", "hours / week"],
    projectLength: ["preferred project length", "project length"],
    transportation: ["type of transportation", "transportation"],
    laptopAccess: ["laptop access"],
    emergencyContact: ["emergency contact"],
    availableSummer: [
      "available summer 9 to 5",
      "available summer 9-5",
      "availability",
    ],
    choices: ["choices", "project choices", "ranked choices"],
    anyProjectFits: [
      "any of the above - please assign me as you see fit",
      "any project fits",
    ],
    whyInternship: [
      "in a few sentences or more, describe why are you interested",
      "in a few sentences or more, describe why you are interested",
      "why this internship",
    ],
    chicagoEcosystem: [
      "in a few sentences or more, tell us what working in chicago",
      "chicago tech ecosystem",
    ],
    additionalAcademics: [
      "additional academics",
      "please leave any additional information that you would like us to know about your academics",
    ],
    acknowledgements: ["acknowledgements"],
    status: ["status"],
    ownerEmail: ["owner email"],
  };

  const SKILL_CANON = {
    python: "Python",
    sql: "SQL",
    nosql: "NoSQL",
    mongodb: "MongoDB",
    excel: "Excel",
    "microsoft excel": "Excel",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    typescript: "TypeScript",
    html: "HTML",
    css: "CSS",
    swift: "Swift",
    kotlin: "Kotlin",
    react: "React",
    figma: "Figma",
    canva: "Canva",
    marketing: "Marketing",
    "ui/ux": "UI/UX Design",
    "ui/ux design": "UI/UX Design",
    "data analysis": "Data Analysis",
    "data analytics": "Data Analysis",
    r: "R",
    "c++": "C++",
    "c#": "C#",
    tableau: "Tableau",
    "power bi": "Power BI",
    salesforce: "Salesforce",
    workday: "Workday",
    office: "Microsoft Office",
    "microsoft office": "Microsoft Office",
    aws: "AWS",
    git: "Git",
    github: "GitHub",
    docker: "Docker",
    "machine learning": "Machine Learning",
    "project management": "Project Management",
    "graphic design": "Graphic Design",
    "social media": "Social Media",
    writing: "Writing",
  };

  const TOPIC_KEYWORDS = [
    ["Data", ["data", "analytics", "analysis", "dashboard", "statistics", "insights", "sql"]],
    ["Marketing", ["marketing", "market research", "social media", "campaign", "crm", "sales", "growth", "content"]],
    ["Design", ["design", "ui/ux", "ux", "user experience", "user interface", "figma", "brand", "graphic", "creative"]],
    ["Engineering", ["engineering", "software", "backend", "back-end", "frontend", "front-end", "api", "infrastructure", "devops", "mobile", "ios", "android"]],
    ["Programming", ["programming", "coding", "web development", "full stack", "app development", "automation"]],
    ["Research", ["research", "academic", "evaluation", "study"]],
    ["Business", ["business", "operations", "finance", "grant", "nonprofit", "compliance", "policy"]],
  ];

  function normalizeHeader(value) {
    return String(value == null ? "" : value)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeAliasTable(table) {
    const out = {};
    for (const [field, aliases] of Object.entries(table)) {
      out[field] = aliases.map(normalizeHeader);
    }
    return out;
  }

  const HOST_ALIASES_N = normalizeAliasTable(HOST_ALIASES);
  const STUDENT_ALIASES_N = normalizeAliasTable(STUDENT_ALIASES);

  /**
   * Map canonical field names onto column indexes.
   * Exact header matches win; long aliases then match by prefix so verbose
   * survey headers ("Please describe the culture of your office (i.e. ...)")
   * resolve without reproducing their full text.
   */
  function resolveColumns(headers, aliasTable) {
    const normalized = headers.map(normalizeHeader);
    const taken = new Set();
    const map = {};

    for (const [field, aliases] of Object.entries(aliasTable)) {
      let found = -1;
      for (const alias of aliases) {
        found = normalized.findIndex((h, i) => !taken.has(i) && h === alias);
        if (found >= 0) break;
      }
      if (found < 0) {
        for (const alias of aliases) {
          if (alias.length < 12) continue;
          found = normalized.findIndex(
            (h, i) => !taken.has(i) && h.startsWith(alias)
          );
          if (found >= 0) break;
        }
      }
      if (found >= 0) {
        map[field] = found;
        taken.add(found);
      }
    }
    return map;
  }

  function cell(row, columns, field) {
    const idx = columns[field];
    if (idx === undefined) return "";
    const value = row[idx];
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    return String(value).trim();
  }

  function toNumber(value) {
    const match = String(value).match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : null;
  }

  function isNegative(value) {
    const v = normalizeHeader(value);
    return v === "no" || v === "false" || v === "0" || v === "n";
  }

  function splitList(value) {
    return String(value || "")
      .split(/[,;\n|]+|\s+and\s+/i)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function canonicalSkill(name) {
    let key = String(name)
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[•*\-–—\s]+|[•*\-–—\s]+$/g, "")
      .replace(/\.$/, "")
      .trim();
    const opens = (key.match(/\(/g) || []).length;
    const closes = (key.match(/\)/g) || []).length;
    if (opens !== closes) {
      key = key.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
    }
    if (!key) return "";
    if (SKILL_CANON[key]) return SKILL_CANON[key];
    return key.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }

  // Fragments starting with these read as prose, not as a tool name.
  const PROSE_OPENERS = new Set([
    "a", "ability", "an", "and", "any", "are", "as", "be", "but", "etc",
    "experience", "expertise", "familiarity", "for", "how", "if", "in", "is",
    "it", "knowledge", "of", "or", "our", "plus", "some", "strong", "the",
    "they", "this", "to", "understanding", "we", "when", "which", "will",
    "with", "would", "you", "your",
  ]);

  const KNOWN_SKILL_PATTERN = new RegExp(
    Object.keys(SKILL_CANON)
      .filter((key) => key.length > 1)
      .sort((a, b) => b.length - a.length)
      .map(
        (key) =>
          "(?<![a-z0-9])" +
          key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") +
          "(?![a-z0-9])"
      )
      .join("|"),
    "gi"
  );

  function isSkillLike(fragment) {
    const words = fragment.split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 4 || fragment.length > 40) return false;
    if (/[.!?:]/.test(fragment)) return false;
    const first = words[0].replace(/^[(0-9.]+/, "").toLowerCase();
    return !PROSE_OPENERS.has(first);
  }

  /**
   * Pull tool names out of a cell that may be a list or a paragraph.
   * Host and student sheets both contain free prose where a comma-separated
   * list was expected, so prose fragments are mined for known tools instead of
   * being stored verbatim.
   */
  function extractSkills(text) {
    const found = [];
    const add = (name) => {
      const canonical = canonicalSkill(name);
      if (canonical && !found.includes(canonical)) found.push(canonical);
    };

    for (const fragment of splitList(text)) {
      if (isSkillLike(fragment)) {
        add(fragment);
      } else {
        const matches = fragment.match(KNOWN_SKILL_PATTERN) || [];
        matches.forEach(add);
      }
    }
    return found;
  }

  /**
   * Catalog tools mentioned anywhere in a block of text.
   * Stricter than extractSkills: it never invents a skill from an unknown
   * phrase, which suits columns that describe something else (coursework, for
   * instance) but happen to name tools along the way.
   */
  function knownSkillsIn(text) {
    const found = [];
    const matches = String(text || "").match(KNOWN_SKILL_PATTERN) || [];
    for (const match of matches) {
      const canonical = canonicalSkill(match);
      if (canonical && !found.includes(canonical)) found.push(canonical);
    }
    return found;
  }

  /** Trim a title pulled out of a combined title+description cell. */
  function shortenTitle(title, limit = 70) {
    const clean = (String(title).split(/\s+[-–—:]\s+/)[0] || title).trim();
    if (clean.length <= limit) return clean;
    const cut = clean.slice(0, limit).replace(/\s+\S*$/, "");
    return (cut || clean.slice(0, limit)).replace(/[,;]+$/, "") + "…";
  }

  function matchTopics(text) {
    const haystack = " " + String(text || "").toLowerCase() + " ";
    const hits = [];
    for (const [topic, keywords] of TOPIC_KEYWORDS) {
      for (const keyword of keywords) {
        const pattern = new RegExp(
          "\\b" + keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b"
        );
        if (pattern.test(haystack)) {
          hits.push(topic);
          break;
        }
      }
    }
    return hits;
  }

  function inferTopic(text) {
    const hits = matchTopics(text);
    return hits.length ? hits[0] : "General";
  }

  function makeSkillRegistry() {
    const byName = new Map();
    const dictionary = [];
    return {
      dictionary,
      idFor(rawName) {
        const name = canonicalSkill(rawName);
        if (!name) return null;
        const key = name.toLowerCase();
        if (byName.has(key)) return byName.get(key);
        const id = dictionary.length + 1;
        byName.set(key, id);
        dictionary.push({ skill_id: id, skill_name: name });
        return id;
      },
    };
  }

  function parseProjectNumber(value) {
    const match = String(value || "").match(/(\d+)/);
    return match ? Number(match[1]) : null;
  }

  /** Columns like "How many interns would you like...? [3 interns]". */
  function internCountColumns(headers) {
    const out = [];
    headers.forEach((header, index) => {
      const match = normalizeHeader(header).match(/\[(\d+)\s*interns?\]/);
      if (match) out.push({ index, count: Number(match[1]) });
    });
    return out;
  }

  /** Columns named exactly "Project 7" carry per-project interest. */
  function projectBidColumns(headers) {
    const out = [];
    headers.forEach((header, index) => {
      const match = normalizeHeader(header).match(/^project\s+(\d+)$/);
      if (match) out.push({ index, projectId: Number(match[1]) });
    });
    return out;
  }

  /**
   * Course-history columns, the only skill signal on some student sheets.
   * Entries such as "Intro to Java - College" name a tool even though the
   * question is about coursework, so they are mined for catalog skills.
   */
  function courseworkColumns(headers) {
    const out = [];
    headers.forEach((header, index) => {
      const normalized = normalizeHeader(header);
      if (
        normalized.includes("courses you have taken") ||
        normalized.includes("coursework high school") ||
        normalized.includes("coursework college") ||
        normalized.includes("coursework other")
      ) {
        out.push(index);
      }
    });
    return out;
  }

  function buildProjects(table, skills, warnings) {
    const headers = table.headers || [];
    const columns = resolveColumns(headers, HOST_ALIASES_N);
    const internCols = internCountColumns(headers);
    const combinedTitle =
      columns.projectTitle !== undefined &&
      normalizeHeader(headers[columns.projectTitle]).startsWith(
        "project title and description"
      );

    if (columns.technicalSkills === undefined) {
      warnings.push(
        "Host workbook: no column matched the technical skills question, so projects carry no skill requirements."
      );
    }

    const companyIds = new Map();
    const companies = [];
    const projects = [];
    const requirements = [];
    const usedIds = new Set();

    (table.rows || []).forEach((row, i) => {
      const rawTitle = cell(row, columns, "projectTitle");
      const rawDescription = cell(row, columns, "description");
      if (!rawTitle && !rawDescription) return;

      let title = rawTitle;
      let description = rawDescription;
      if (combinedTitle && rawTitle) {
        const split = rawTitle.split(/(?<=\.)\s+|\n/);
        title = shortenTitle((split[0] || rawTitle).replace(/\.$/, "").trim());
        if (!description) description = rawTitle;
      }
      if (!title) title = "Project " + (i + 1);

      let projectId =
        parseProjectNumber(cell(row, columns, "projectNumber")) || i + 1;
      while (usedIds.has(projectId)) projectId += 1;
      usedIds.add(projectId);

      const supervisorEmail = cell(row, columns, "supervisorEmail");
      let companyName = cell(row, columns, "companyName");
      if (!companyName) {
        const prefix = title.split(/\s+[-–—]\s+/)[0];
        if (prefix && prefix !== title && prefix.length <= 40) {
          companyName = prefix.trim();
        }
      }
      if (!companyName && supervisorEmail.includes("@")) {
        companyName = supervisorEmail.split("@")[1];
      }
      if (!companyName) companyName = "Host " + projectId;

      if (!companyIds.has(companyName)) {
        const companyId = 101 + companies.length;
        companyIds.set(companyName, companyId);
        companies.push({
          company_id: companyId,
          company_name: companyName,
          mission: cell(row, columns, "innovationCenter") || "Project host",
        });
      }

      let interns = toNumber(cell(row, columns, "internsNeeded"));
      if (!interns) {
        for (const col of internCols) {
          const value = row[col.index];
          if (value !== null && value !== undefined && String(value).trim()) {
            interns = col.count;
            break;
          }
        }
      }
      if (!interns) {
        const logistics = cell(row, columns, "internLogistics");
        const match = logistics.match(/(\d+)\s*interns?/i);
        if (match) interns = Number(match[1]);
      }
      interns = Math.max(1, Math.min(10, interns || 1));

      const skillsText = cell(row, columns, "technicalSkills");
      const topic =
        cell(row, columns, "topicCategory") ||
        inferTopic(title + " " + description + " " + skillsText);

      projects.push({
        project_id: projectId,
        company_id: companyIds.get(companyName),
        project_title: title,
        interns_needed: interns,
        min_gpa_required: toNumber(cell(row, columns, "minGpa")) || 0,
        topic_category: topic,
        // Matcher treats omitted requires_summer_9_to_5 as true. Force false so
        // converted app/STI cohorts do not fail the availability hard gate.
        requires_summer_9_to_5: false,
      });

      const wanted = [];
      const seen = new Set();
      for (const raw of extractSkills(skillsText)) {
        const id = skills.idFor(raw);
        if (id && !seen.has(id)) {
          seen.add(id);
          wanted.push(id);
        }
      }
      // Hosts name tools they would like their interns to know, not per-seat
      // quotas, so every skill is stored as a preference (quantity 0).
      for (const skillId of wanted) {
        requirements.push({
          project_id: projectId,
          skill_id: skillId,
          quantity_required: 0,
        });
      }
    });

    return { companies, projects, requirements };
  }

  function parseChoices(text) {
    if (!text) return [];
    return String(text)
      .split(/,\s*(?=project\s+\d+)/i)
      .map((part) => parseProjectNumber(part))
      .filter((n) => n !== null);
  }

  function buildStudents(table, skills, projectIds, warnings) {
    const headers = table.headers || [];
    const columns = resolveColumns(headers, STUDENT_ALIASES_N);
    const bidCols = projectBidColumns(headers);
    const courseCols = courseworkColumns(headers);

    if (columns.skills === undefined && !courseCols.length) {
      warnings.push(
        "Student workbook: no column matched skills/tools, so skill scoring is inactive for every applicant."
      );
    }

    const students = [];
    const studentSkills = [];
    const bids = [];
    const usedIds = new Set();
    let missingGpa = 0;
    let anyFitsWithoutBids = 0;
    const unknownProjects = new Set();

    (table.rows || []).forEach((row, i) => {
      const first = cell(row, columns, "firstName");
      const last = cell(row, columns, "lastName");
      const full = cell(row, columns, "fullName");
      const personalEmail = cell(row, columns, "personalEmail");
      const name =
        full || [first, last].filter(Boolean).join(" ") || personalEmail;
      if (!name) return;

      let studentId =
        toNumber(cell(row, columns, "studentNumber")) || 301 + i;
      while (usedIds.has(studentId)) studentId += 1;
      usedIds.add(studentId);

      const gpaRaw = cell(row, columns, "gpa");
      const gpa = toNumber(gpaRaw);
      if (gpa === null) missingGpa += 1;

      const topics = new Set();
      for (const chunk of splitList(cell(row, columns, "interests"))) {
        for (const topic of matchTopics(chunk)) topics.add(topic);
      }
      for (const field of ["topicPref1", "topicPref2", "major"]) {
        for (const topic of matchTopics(cell(row, columns, field))) {
          topics.add(topic);
        }
      }

      const availableRaw = cell(row, columns, "availableSummer");
      students.push({
        student_id: studentId,
        name,
        first_name: first,
        last_name: last,
        personal_email: personalEmail,
        school_email: cell(row, columns, "schoolEmail"),
        phone: cell(row, columns, "phone"),
        college: cell(row, columns, "college"),
        major: cell(row, columns, "major"),
        year: cell(row, columns, "year"),
        grad_year: cell(row, columns, "gradYear"),
        gpa: gpa === null ? 0 : gpa,
        high_school: cell(row, columns, "highSchool"),
        illinois_resident: cell(row, columns, "illinoisResident"),
        us_citizen: cell(row, columns, "usCitizen"),
        home_address: cell(row, columns, "homeAddress"),
        start_date: cell(row, columns, "startDate"),
        hours_per_week: cell(row, columns, "hoursPerWeek"),
        work_mode: cell(row, columns, "workMode"),
        project_length: cell(row, columns, "projectLength"),
        why_internship: cell(row, columns, "whyInternship"),
        chicago_ecosystem: cell(row, columns, "chicagoEcosystem"),
        topic_preferences: [...topics],
        available_summer_9_to_5: availableRaw ? !isNegative(availableRaw) : true,
      });

      const named = extractSkills(cell(row, columns, "skills")).concat(
        knownSkillsIn(cell(row, columns, "skillProficiency"))
      );
      const coursework = courseCols
        .filter((i) => i < row.length && row[i])
        .map((i) => String(row[i]))
        .join(" ; ");

      const seen = new Set();
      for (const raw of named.concat(knownSkillsIn(coursework))) {
        const id = skills.idFor(raw);
        if (id && !seen.has(id)) {
          seen.add(id);
          studentSkills.push({ student_id: studentId, skill_id: id });
        }
      }

      const anyFitsRaw = cell(row, columns, "anyProjectFits");
      const anyFits = Boolean(anyFitsRaw) && !isNegative(anyFitsRaw);

      const ranked = parseChoices(cell(row, columns, "choices"));
      const bidIds = [];
      for (const pid of ranked) {
        if (!bidIds.includes(pid)) bidIds.push(pid);
      }
      for (const col of bidCols) {
        const value = row[col.index];
        if (value === null || value === undefined || !String(value).trim()) {
          continue;
        }
        if (!bidIds.includes(col.projectId)) bidIds.push(col.projectId);
      }

      let placed = 0;
      bidIds.forEach((pid, rank) => {
        if (!projectIds.has(pid)) {
          unknownProjects.add(pid);
          return;
        }
        placed += 1;
        bids.push({
          student_id: studentId,
          project_id: pid,
          // Ordered ranking: 1st=10, 2nd=9, … floor 4. Extra Project-N cols=7.
          interest_level: rank < ranked.length ? Math.max(4, 10 - rank) : 7,
          any_project_fits: anyFits,
        });
      });

      if (anyFits && placed === 0) anyFitsWithoutBids += 1;
    });

    if (missingGpa) {
      warnings.push(
        `${missingGpa} student(s) had no GPA; recorded as 0 (projects without a GPA floor still accept them).`
      );
    }
    if (unknownProjects.size) {
      warnings.push(
        `Ignored rankings for unknown project number(s): ${[...unknownProjects]
          .sort((a, b) => a - b)
          .join(", ")}.`
      );
    }
    if (anyFitsWithoutBids) {
      warnings.push(
        `${anyFitsWithoutBids} student(s) marked "any project fits" but ranked no projects; they match on skills and topics only.`
      );
    }

    return { students, studentSkills, bids };
  }

  /**
   * Flag preferred skills no applicant holds.
   *
   * Preferences never block a solve, but a tool nobody in the pool has can only
   * drag scores down, so it is worth surfacing rather than silently absorbing.
   */
  function warnUnsuppliedPreferences(
    requirements,
    studentSkills,
    skills,
    warnings
  ) {
    if (!requirements.length) return;

    const holders = new Set(studentSkills.map((row) => row.skill_id));
    if (!holders.size) {
      warnings.push(
        `All ${requirements.length} preferred project skill(s) are unmatched: the host workbook's skill lists were read fine, but the student workbook records no skills for anyone.`
      );
      return;
    }

    const names = new Map(
      skills.dictionary.map((s) => [s.skill_id, s.skill_name])
    );
    const missing = [
      ...new Set(
        requirements
          .filter((row) => !holders.has(row.skill_id))
          .map((row) => names.get(row.skill_id) || String(row.skill_id))
      ),
    ].sort();

    if (missing.length) {
      const preview = missing.slice(0, 6).join(", ");
      const suffix = missing.length <= 6 ? "" : `, +${missing.length - 6} more`;
      warnings.push(
        `${missing.length} preferred skill(s) that no applicant listed: ${preview}${suffix}.`
      );
    }
  }

  /**
   * Build matcher-ready cohort JSON from a host table and a student table.
   * Tables are { headers: string[], rows: any[][] } from Excel or Firestore.
   */
  function buildCohort(hostTable, studentTable) {
    const warnings = [];
    const skills = makeSkillRegistry();

    const { companies, projects, requirements } = buildProjects(
      hostTable || { headers: [], rows: [] },
      skills,
      warnings
    );
    const projectIds = new Set(projects.map((p) => p.project_id));
    const { students, studentSkills, bids } = buildStudents(
      studentTable || { headers: [], rows: [] },
      skills,
      projectIds,
      warnings
    );

    warnUnsuppliedPreferences(requirements, studentSkills, skills, warnings);

    if (!projects.length) warnings.push("No project rows were found.");
    if (!students.length) warnings.push("No student rows were found.");
    if (!bids.length && students.length) {
      warnings.push(
        "No project rankings found; preference scoring is inactive for this cohort."
      );
    }

    const seats = projects.reduce((n, p) => n + Number(p.interns_needed), 0);
    if (seats > students.length) {
      warnings.push(
        `Projects request ${seats} seats but only ${students.length} student(s) are available; expect an infeasible solve.`
      );
    }

    return {
      cohort: {
        skills_dictionary: skills.dictionary,
        companies,
        projects,
        project_requirements: requirements,
        users_students: students,
        student_skills: studentSkills,
        student_bids: bids,
      },
      warnings,
    };
  }

  function requireXlsx() {
    if (typeof XLSX === "undefined") {
      throw new Error(
        "Spreadsheet library did not load. Check your connection and refresh."
      );
    }
    return XLSX;
  }

  /** Read the first worksheet of a File into { headers, rows }. */
  async function readWorkbook(file) {
    const lib = requireXlsx();
    const buffer = await file.arrayBuffer();
    const book = lib.read(buffer, { type: "array", cellDates: true });
    const sheetName = book.SheetNames[0];
    if (!sheetName) throw new Error(`${file.name} has no worksheets.`);
    const grid = lib.utils.sheet_to_json(book.Sheets[sheetName], {
      header: 1,
      blankrows: false,
      defval: "",
    });

    const headerIndex = grid.findIndex((row) =>
      row.some((c) => String(c || "").trim())
    );
    if (headerIndex < 0) throw new Error(`${file.name} looks empty.`);

    return {
      headers: grid[headerIndex].map((h) => String(h == null ? "" : h)),
      rows: grid.slice(headerIndex + 1),
    };
  }

  function objectsToTable(objects, columns) {
    return {
      headers: columns.slice(),
      rows: objects.map((obj) => columns.map((key) => obj[key] ?? "")),
    };
  }

  function downloadWorkbook(objects, columns, sheetName, filename) {
    const lib = requireXlsx();
    const table = objectsToTable(objects, columns);
    const sheet = lib.utils.aoa_to_sheet([table.headers, ...table.rows]);
    sheet["!cols"] = columns.map((name) => ({
      wch: Math.min(48, Math.max(12, name.length + 2)),
    }));
    const book = lib.utils.book_new();
    lib.utils.book_append_sheet(book, sheet, sheetName);
    lib.writeFile(book, filename);
  }

  function listToText(value) {
    if (Array.isArray(value)) return value.join(", ");
    return value == null ? "" : String(value);
  }

  /** Firestore project doc -> compiled host workbook row. */
  function projectDocToRow(doc, index) {
    return {
      "Project Number": doc.projectNumber || index + 1,
      "Project Title": doc.projectTitle || "",
      "Company Name": doc.companyName || "",
      "Project supervisor's name": doc.supervisorName || "",
      "Project supervisor's email": doc.supervisorEmail || "",
      Description: doc.description || "",
      "Interns Needed": doc.internsNeeded || "",
      "How many interns would you like and for which weeks?":
        doc.internLogistics || "",
      "Minimum GPA": doc.minGpa || "",
      "Topic Category": doc.topicCategory || "",
      "What technical skills/tools will students interact with on this project?":
        doc.technicalSkills || "",
      "Host Days": doc.hostDays || "",
      "Work Locations": doc.workLocations || "",
      "Innovation Center": doc.innovationCenter || "",
      "First Interns": doc.firstInterns || "",
      "Technical Expertise": doc.expertiseSupport || "",
      "Project Structure": doc.projectStructure || "",
      Deliverables: listToText(doc.deliverables),
      "Office Culture": doc.officeCulture || "",
      "Interview Involvement": doc.interviewInvolvement || "",
      Notes: doc.notes || "",
      "Company Website Link": doc.companyWebsite || "",
      "Logo File":
        doc.logo && doc.logo.fileName
          ? doc.logo.fileName
          : doc.logoFile || "",
      Status: doc.status || "draft",
      "Owner Email": doc.ownerEmail || "",
    };
  }

  /** Firestore student doc -> compiled student workbook row. */
  function studentDocToRow(doc, index) {
    const choices = Array.isArray(doc.projectChoices)
      ? doc.projectChoices
          .map((c) =>
            c && c.projectId
              ? "Project " + c.projectId + (c.title ? ": " + c.title : "")
              : ""
          )
          .filter(Boolean)
          .join(", ")
      : "";

    const proficiency = doc.skillProficiency || {};
    const proficiencyText = Object.entries(proficiency)
      .map(([skill, level]) => skill + ": " + level)
      .join("; ");
    const skillsList = Array.isArray(doc.skills)
      ? doc.skills
      : Object.keys(proficiency);

    const acks = [];
    if (doc.ackCommitment) acks.push("Program commitment & drop policy");
    if (doc.ackOrientation) acks.push("Virtual orientation attendance");
    if (doc.ackAbsences) acks.push("Two absences allowed");
    if (doc.ackProgramDates) acks.push("Program start and end dates");

    return {
      "Student Number": doc.studentNumber || index + 1,
      "First Name":
        doc.firstName ||
        String(doc.fullName || "")
          .trim()
          .split(/\s+/)[0] ||
        "",
      "Last Name":
        doc.lastName ||
        String(doc.fullName || "")
          .trim()
          .split(/\s+/)
          .slice(1)
          .join(" "),
      "Full Name":
        doc.fullName ||
        [doc.firstName, doc.lastName].filter(Boolean).join(" "),
      "Preferred Name": doc.preferredName || "",
      Pronouns: doc.pronouns || "",
      Gender: doc.gender || "",
      Birthday: doc.birthday || "",
      "Age at Program Start": doc.ageAtStart || "",
      "Personal Email Address": doc.personalEmail || "",
      "School Email Address": doc.schoolEmail || "",
      "Phone Number": doc.phone || "",
      "Race/Ethnicity": listToText(doc.raceEthnicity),
      "Mailing Address": doc.mailingAddress || doc.homeAddress || "",
      "Summer Address": doc.summerAddress || "",
      "Illinois Resident": doc.illinoisResident || "",
      "US Citizen": doc.usCitizen || "",
      "Illinois High School":
        doc.illinoisHighSchool || doc.highSchool || "",
      "Non-Illinois School": doc.nonIllinoisSchool || "",
      "College/University Name": doc.college || "",
      Major: doc.major || "",
      Minor: doc.minor || "",
      "Grad Yr": doc.gradYear || "",
      Year: doc.year || "",
      GPA: doc.gpa || "",
      "Resume File": (doc.resume && doc.resume.fileName) || "",
      "Transcript File": (doc.transcript && doc.transcript.fileName) || "",
      Skills: listToText(skillsList),
      "Skill Proficiency": proficiencyText,
      "Areas of Interest": listToText(doc.interests),
      "Coursework High School": listToText(doc.courseworkHs),
      "Coursework College": listToText(doc.courseworkCollege),
      "Coursework Other": doc.courseworkOther || "",
      "Preferred Project Length": doc.projectLength || "",
      Transportation: doc.transportation || "",
      "Laptop Access": doc.laptopAccess || "",
      "Emergency Contact": doc.emergencyContact || "",
      "Available Summer 9 to 5": doc.availableSummer === false ? "No" : "Yes",
      Choices: choices,
      "Any of the above - please assign me as you see fit": doc.anyProjectFits
        ? "Any of the above - please assign me as you see fit"
        : "",
      "Why This Internship": doc.whyInternship || "",
      "Chicago Tech Ecosystem": doc.chicagoEcosystem || "",
      "Additional Academics": doc.additionalAcademics || "",
      Acknowledgements: acks.join("; "),
      Status: doc.status || "draft",
      "Owner Email": doc.ownerEmail || "",
    };
  }

  window.DpiCohort = {
    HOST_COLUMNS,
    STUDENT_COLUMNS,
    buildCohort,
    readWorkbook,
    objectsToTable,
    downloadWorkbook,
    projectDocToRow,
    studentDocToRow,
    canonicalSkill,
    inferTopic,
  };
})();
