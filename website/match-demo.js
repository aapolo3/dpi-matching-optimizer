/**
 * Admin-page matching UI — upload the compiled workbooks, render a styled
 * read-only preview of the placements.
 *
 * runMatch is called with { topK, solver, timeBudgetMs } only — no weight
 * sliders and no skillPolicy. Top-K pills apply to the ILP path; other
 * solvers return a single solution.
 *
 * Leftover "waitlisted / denied" on this panel is solver output (eligible but
 * unseated vs failed hard gates), not the admin Kanban reviewStatus columns.
 *
 * Uploaded .xlsx files beat a cohort staged by "Build from Firestore".
 */

(function () {
  let result = null;
  let currentRank = 0;
  let stagedCohort = null;
  let stagedWarnings = [];

  const TOPIC_CLASS = {
    Data: "topic-data",
    Design: "topic-design",
    Engineering: "topic-eng",
    Marketing: "topic-mkt",
    FinTech: "topic-data",
    Programming: "topic-eng",
  };

  const els = {
    hostsXlsx: document.getElementById("match-hosts-xlsx"),
    studentsXlsx: document.getElementById("match-students-xlsx"),
    solver: document.getElementById("match-solver"),
    solverBlurb: document.getElementById("match-solver-blurb"),
    topk: document.getElementById("match-topk"),
    run: document.getElementById("match-run"),
    loadFirestore: document.getElementById("match-load-firestore"),
    warnings: document.getElementById("match-warnings"),
    status: document.getElementById("match-status"),
    scoreValue: document.getElementById("admin-score-value"),
    scoreMeta: document.getElementById("admin-score-meta"),
    stats: document.getElementById("admin-match-stats"),
    compare: document.getElementById("admin-solver-compare"),
    pills: document.getElementById("admin-sol-pills"),
    prev: document.getElementById("match-prev"),
    next: document.getElementById("match-next"),
    teams: document.getElementById("admin-team-grid"),
    leftover: document.getElementById("admin-leftover-board"),
    waitlisted: document.getElementById("admin-waitlisted"),
    denied: document.getElementById("admin-denied"),
    waitlistedCount: document.getElementById("admin-waitlisted-count"),
    deniedCount: document.getElementById("admin-denied-count"),
    profileDrawer: document.getElementById("student-profile-modal"),
    profileName: document.getElementById("student-profile-name"),
    profileKicker: document.getElementById("student-profile-kicker"),
    profileBody: document.getElementById("student-profile-body"),
    profileClose: document.getElementById("student-profile-close"),
    profileBackdrop: document.getElementById("student-profile-close-backdrop"),
  };

  let profileScrollY = 0;

  const SOLVER_BLURBS = {
    ilp: "ILP maximizes total compatibility plus team skill bonuses — the production approach.",
    hungarian:
      "Hungarian fills each seat for maximum compatibility. Fast, but it does not plan teams as a unit.",
    "gale-shapley":
      "Gale–Shapley respects student bid order and yields a stable match. Coverage can be weaker.",
    hybrid:
      "Hybrid starts with Gale–Shapley, swaps to close skill gaps, then Hungarian-fills leftover seats.",
    "compare-all":
      "Runs every solver on the same scores and shows a side-by-side table. Click a row to preview its placements.",
  };

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function studentNum(name) {
    const m = String(name).match(/(\d+)\s*$/);
    return m ? Number(m[1]) : 0;
  }

  function setStatus(msg, isError) {
    if (!els.status) return;
    els.status.textContent = msg || "";
    els.status.classList.toggle("is-error", Boolean(isError));
  }

  function firstFile(input) {
    return input && input.files && input.files[0] ? input.files[0] : null;
  }

  function renderWarnings(warnings) {
    if (!els.warnings) return;
    if (!warnings || !warnings.length) {
      els.warnings.hidden = true;
      els.warnings.innerHTML = "";
      return;
    }
    els.warnings.hidden = false;
    els.warnings.innerHTML = warnings
      .map((w) => "<li>" + escapeHtml(w) + "</li>")
      .join("");
  }

  /**
   * Cohort sources in priority order: uploaded workbooks, then whatever was
   * staged by "Build from Firestore". Workbooks are the only file format.
   */
  async function readInputCohort() {
    const hostsFile = firstFile(els.hostsXlsx);
    const studentsFile = firstFile(els.studentsXlsx);

    if (hostsFile || studentsFile) {
      if (!window.DpiCohort) {
        throw new Error("Workbook converter failed to load. Refresh the page.");
      }
      const [hostTable, studentTable] = await Promise.all([
        hostsFile ? window.DpiCohort.readWorkbook(hostsFile) : null,
        studentsFile ? window.DpiCohort.readWorkbook(studentsFile) : null,
      ]);
      const built = window.DpiCohort.buildCohort(hostTable, studentTable);
      if (!hostsFile) {
        built.warnings.unshift("No host workbook uploaded — there are no projects to fill.");
      }
      if (!studentsFile) {
        built.warnings.unshift("No student workbook uploaded — there are no applicants to place.");
      }
      return built;
    }

    if (stagedCohort) return { cohort: stagedCohort, warnings: stagedWarnings };

    throw new Error(
      "Upload the compiled host and student workbooks, or build a cohort from Firestore first."
    );
  }

  function topicClass(topic) {
    return TOPIC_CLASS[topic] || "topic-data";
  }

  function updateStats(summary, solution) {
    const assigned = solution ? solution.assignments.length : 0;
    const unassigned = summary.students - assigned;
    const map = {
      students: summary.students,
      projects: summary.projects,
      assigned,
      unassigned,
    };
    Object.entries(map).forEach(([key, val]) => {
      const el = els.stats && els.stats.querySelector('[data-stat="' + key + '"]');
      if (el) el.textContent = String(val);
    });
    const coMeta =
      els.stats && els.stats.querySelector('[data-stat-meta="companies"]');
    if (coMeta) {
      const n = Object.keys(result.idx.companies).length;
      coMeta.textContent = "Across " + n + " companies";
    }
  }

  function renderPills(total, active) {
    if (!els.pills) return;
    if (total <= 0) {
      els.pills.innerHTML = "";
      return;
    }
    els.pills.innerHTML = Array.from({ length: total }, (_, i) => {
      const n = i + 1;
      return (
        '<button type="button" class="pill' +
        (n === active ? " is-active" : "") +
        '" data-sol="' +
        n +
        '">Solution ' +
        n +
        "</button>"
      );
    }).join("");
  }

  function renderTeams(idx, solution) {
    if (!els.teams) return;
    const byProject = window.DpiMatcher.groupByProject(idx, solution.assignments);
    const team = window.DpiMatcher.teamSkillMetrics(idx, solution.assignments);
    const cards = [];

    for (const pid of idx.projectIds) {
      const project = idx.projects[pid];
      const company = idx.companies[project.company_id];
      const members = (byProject.get(pid) || []).slice().sort((a, b) => b.score - a.score);
      const need = Number(project.interns_needed || 0);
      const topic = project.topic_category || "";
      const prefs = [...window.DpiMatcher.preferredSkills(idx, pid)];
      const coverage = team.perProject.get(pid);

      let looking;
      if (prefs.length) {
        // Tag each preferred skill by whether the assigned team actually brings it.
        const missing = new Set((coverage && coverage.missing) || []);
        looking = prefs
          .map((sk) => {
            const name = idx.skills[sk] || "Skill";
            const held = !missing.has(name);
            return (
              '<span class="tag outline' +
              (held ? " is-covered" : " is-missing") +
              '">' +
              escapeHtml(name) +
              "</span>"
            );
          })
          .join("");
      } else {
        looking = '<div class="looking-empty">No preferred skills listed</div>';
      }

      const summary = coverage
        ? '<div class="admin-team-skill-summary">Team covers ' +
          coverage.covered +
          "/" +
          coverage.size +
          " preferred</div>"
        : "";

      const memberHtml = members
        .map((m) => {
          const stu = idx.students[m.student_id];
          const skills = [...(idx.studentSkills.get(m.student_id) || [])]
            .map((id) => idx.skills[id])
            .filter(Boolean)
            .slice(0, 3)
            .map((s) => '<span class="tag">' + escapeHtml(s) + "</span>")
            .join("");
          return (
            '<li class="is-clickable" role="button" tabindex="0" data-student-id="' +
            m.student_id +
            '" data-match-score="' +
            m.score +
            '" data-match-project="' +
            pid +
            '">' +
            '<div class="member-top">' +
            "<strong>" +
            escapeHtml(stu.name) +
            "</strong>" +
            '<span class="member-c">' +
            m.score.toFixed(2) +
            "</span>" +
            "</div>" +
            '<div class="member-meta">GPA ' +
            stu.gpa +
            " · View profile</div>" +
            '<div class="tags">' +
            skills +
            "</div>" +
            "</li>"
          );
        })
        .join("");

      cards.push(
        '<article class="admin-team-card ' +
          topicClass(topic) +
          '">' +
          "<header>" +
          '<div class="admin-team-kicker">' +
          escapeHtml((company && company.company_name) || "Company") +
          " · " +
          escapeHtml(String(topic || "—")) +
          "</div>" +
          "<h4>" +
          escapeHtml(project.project_title) +
          "</h4>" +
          '<div class="admin-team-fill">' +
          members.length +
          "/" +
          need +
          " filled · min GPA " +
          (project.min_gpa_required != null ? project.min_gpa_required : "—") +
          "</div>" +
          "</header>" +
          '<div class="admin-team-looking">' +
          '<div class="looking-label">Preferred skills</div>' +
          (prefs.length ? '<div class="tags">' + looking + "</div>" : looking) +
          summary +
          "</div>" +
          '<ul class="admin-team-members">' +
          (memberHtml || "<li><div class='member-meta'>No assignees</div></li>") +
          "</ul>" +
          "</article>"
      );
    }

    els.teams.innerHTML = cards.join("");
  }

  function shortenReason(reason) {
    if (reason.toLowerCase().startsWith("ineligible")) {
      return reason.replace(/^ineligible for all projects — /i, "Hard gates: ");
    }
    let short = reason.replace(/^eligible but not selected — /i, "Passed over — ");
    if (short.includes("; top C=")) short = short.split("; top C=")[0];
    if (!short.endsWith(".")) short += ".";
    if (!short.includes("stronger fits")) {
      short += " Seats went to stronger fits.";
    }
    return short;
  }

  /** Solver leftovers: eligible-but-unseated vs hard-gate failures. Not the Kanban. */
  function renderLeftovers(idx, solution, C, details) {
    if (!els.leftover || !els.waitlisted || !els.denied) return;

    const assigned = new Set(solution.assignments.map((a) => a.student_id));
    const waitlisted = [];
    const denied = [];

    for (const sid of idx.studentIds) {
      if (assigned.has(sid)) continue;
      const reason = window.DpiMatcher.rejectionReason(sid, idx, C, details);
      const row = {
        name: idx.students[sid].name,
        reason: shortenReason(reason),
        sid,
      };
      if (reason.toLowerCase().startsWith("ineligible")) denied.push(row);
      else waitlisted.push(row);
    }

    waitlisted.sort(
      (a, b) => studentNum(a.name) - studentNum(b.name) || a.sid - b.sid
    );
    denied.sort(
      (a, b) => studentNum(a.name) - studentNum(b.name) || a.sid - b.sid
    );

    function cards(list) {
      return list
        .map(
          (r) =>
            '<article class="applicant admin-ua-card is-clickable" role="button" tabindex="0" data-student-id="' +
            r.sid +
            '" data-match-reason="' +
            escapeHtml(r.reason) +
            '">' +
            "<h4>" +
            escapeHtml(r.name) +
            "</h4>" +
            '<p class="edu">' +
            escapeHtml(r.reason) +
            "</p>" +
            '<p class="profile-hint">View profile</p>' +
            "</article>"
        )
        .join("");
    }

    els.waitlisted.innerHTML = cards(waitlisted);
    els.denied.innerHTML = cards(denied);
    if (els.waitlistedCount) els.waitlistedCount.textContent = String(waitlisted.length);
    if (els.deniedCount) els.deniedCount.textContent = String(denied.length);
    els.leftover.hidden = false;
  }

  function profileRow(label, value) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) {
      return "";
    }
    const text = Array.isArray(value) ? value.join(", ") : String(value);
    return (
      '<div class="student-profile-row">' +
      '<dt>' +
      escapeHtml(label) +
      "</dt>" +
      "<dd>" +
      escapeHtml(text) +
      "</dd>" +
      "</div>"
    );
  }

  function profileSection(title, rowsHtml) {
    if (!rowsHtml) return "";
    return (
      '<section class="student-profile-section">' +
      "<h4>" +
      escapeHtml(title) +
      "</h4>" +
      '<dl class="student-profile-dl">' +
      rowsHtml +
      "</dl>" +
      "</section>"
    );
  }

  function bidListHtml(idx, sid) {
    const bidMap = idx.bids.get(sid);
    if (!bidMap || !bidMap.size) return "";
    const ranked = [...bidMap.entries()].sort(
      (a, b) =>
        Number(b[1].interest_level || 0) - Number(a[1].interest_level || 0)
    );
    return ranked
      .map(([pid, bid], i) => {
        const title = idx.projects[pid]
          ? idx.projects[pid].project_title
          : "Project " + pid;
        return (
          "<li><span class='bid-rank'>#" +
          (i + 1) +
          "</span> " +
          escapeHtml(title) +
          ' <span class="bid-score">interest ' +
          Number(bid.interest_level || 0) +
          "</span></li>"
        );
      })
      .join("");
  }

  function openStudentProfile(sid, context) {
    if (!result || !els.profileDrawer || !els.profileBody) return;
    const idx = result.idx;
    const stu = idx.students[sid];
    if (!stu) return;

    const skills = [...(idx.studentSkills.get(sid) || [])]
      .map((id) => idx.skills[id])
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));

    if (els.profileName) els.profileName.textContent = stu.name || "Student";
    if (els.profileKicker) {
      els.profileKicker.textContent =
        "Student #" + sid + (stu.major ? " · " + stu.major : "");
    }

    let matchHtml = "";
    if (context && context.projectId != null) {
      const project = idx.projects[context.projectId];
      matchHtml = profileSection(
        "This match",
        profileRow(
          "Assigned to",
          project ? project.project_title : "Project " + context.projectId
        ) +
          profileRow(
            "Compatibility",
            context.score != null ? Number(context.score).toFixed(3) : null
          )
      );
    } else if (context && context.reason) {
      matchHtml = profileSection(
        "Match status",
        profileRow("Why unassigned", context.reason)
      );
    }

    const contact =
      profileRow("Personal email", stu.personal_email) +
      profileRow("School email", stu.school_email) +
      profileRow("Phone", stu.phone) +
      profileRow("Home address", stu.home_address);

    const academics =
      profileRow("College", stu.college) +
      profileRow("Major", stu.major) +
      profileRow("Year", stu.year) +
      profileRow("Grad year", stu.grad_year) +
      profileRow("GPA", stu.gpa) +
      profileRow("High school", stu.high_school) +
      profileRow("Illinois resident", stu.illinois_resident) +
      profileRow("U.S. citizen", stu.us_citizen);

    const availability =
      profileRow(
        "Available summer 9–5",
        stu.available_summer_9_to_5 === false ? "No" : "Yes"
      ) +
      profileRow("Earliest start", stu.start_date) +
      profileRow("Hours per week", stu.hours_per_week) +
      profileRow("Work mode", stu.work_mode) +
      profileRow("Preferred length", stu.project_length);

    const interests =
      profileRow("Topic preferences", stu.topic_preferences) +
      (skills.length
        ? '<div class="student-profile-row"><dt>Skills</dt><dd class="tags">' +
          skills
            .map((s) => '<span class="tag">' + escapeHtml(s) + "</span>")
            .join("") +
          "</dd></div>"
        : "");

    const bids = bidListHtml(idx, sid);
    const anyFits = [...(idx.bids.get(sid)?.values() || [])].some(
      (b) => b.any_project_fits
    );
    const rankingSection = bids
      ? '<section class="student-profile-section"><h4>Project rankings</h4>' +
        (anyFits
          ? '<p class="student-profile-note">Marked “any project fits.”</p>'
          : "") +
        '<ol class="student-profile-bids">' +
        bids +
        "</ol></section>"
      : profileSection(
          "Project rankings",
          profileRow(
            "Rankings",
            anyFits ? "Any project fits — no ranked list" : "None listed"
          )
        );

    const essays =
      profileRow("Why this internship", stu.why_internship) +
      profileRow("Chicago tech ecosystem", stu.chicago_ecosystem);

    els.profileBody.innerHTML =
      matchHtml +
      profileSection("Contact", contact) +
      profileSection("Academics", academics) +
      profileSection("Availability", availability) +
      profileSection("Skills & interests", interests) +
      rankingSection +
      profileSection("Application notes", essays);

    profileScrollY = window.scrollY || window.pageYOffset || 0;
    els.profileDrawer.hidden = false;
    document.body.classList.add("profile-open");
    document.body.style.top = "-" + profileScrollY + "px";
    document.body.style.position = "fixed";
    document.body.style.width = "100%";
    if (els.profileBody) els.profileBody.scrollTop = 0;
  }

  function closeStudentProfile() {
    if (!els.profileDrawer || els.profileDrawer.hidden) return;
    els.profileDrawer.hidden = true;
    document.body.classList.remove("profile-open");
    document.body.style.position = "";
    document.body.style.top = "";
    document.body.style.width = "";
    window.scrollTo(0, profileScrollY);
  }

  /** Cycle the top-K ILP solutions shown in the team grid. */
  function showRank(i) {
    if (!result || !result.solutions.length) return;
    currentRank = Math.max(0, Math.min(result.solutions.length - 1, i));
    const solution = result.solutions[currentRank];

    if (els.scoreValue) els.scoreValue.textContent = solution.score.toFixed(2);
    if (els.scoreMeta) {
      const solverLabel = solution.solver || result.summary.solver || "ilp";
      els.scoreMeta.textContent =
        solverLabel +
        " · " +
        solution.status +
        (result.solutions.length > 1
          ? " · solution " + (currentRank + 1) + "/" + result.solutions.length
          : "");
      els.scoreMeta.className =
        "meta " +
        (solution.status === "OPTIMAL" ||
        solution.status === "HEURISTIC" ||
        solution.status === "FEASIBLE"
          ? "up"
          : "");
    }

    updateStats(result.summary, solution);
    renderPills(result.solutions.length, currentRank + 1);
    renderTeams(result.idx, solution);
    renderLeftovers(result.idx, solution, result.C, result.details);
    renderComparison(result.comparison, solution.solver || result.summary.solver);

    if (els.prev) els.prev.disabled = currentRank === 0;
    if (els.next) els.next.disabled = currentRank === result.solutions.length - 1;
  }

  function fmtPct(v) {
    return Math.round((v || 0) * 100) + "%";
  }

  function fmtRank(v) {
    return v == null ? "—" : Number(v).toFixed(2);
  }

  function renderComparison(comparison, selectedKey) {
    if (!els.compare) return;
    if (!comparison) {
      els.compare.hidden = true;
      els.compare.innerHTML = "";
      return;
    }

    const order = ["ilp", "hungarian", "gale_shapley", "hybrid"].filter(
      (k) => comparison[k]
    );
    const keyToSolver = {
      ilp: "ilp",
      hungarian: "hungarian",
      gale_shapley: "gale-shapley",
      hybrid: "hybrid",
    };
    const selected = selectedKey || "ilp";

    const header =
      "<tr><th>Metric</th>" +
      order
        .map((k) => "<th>" + escapeHtml(comparison[k].label) + "</th>")
        .join("") +
      "</tr>";

    const rows = [
      ["Status", (r) => "<code>" + escapeHtml(r.status) + "</code>"],
      ["Total objective", (r) => r.objective.toFixed(3)],
      ["Seats filled", (r) => r.placed + " / " + r.seats],
      ["Skills covered", (r) => fmtPct(r.coveragePct)],
      ["Uncovered", (r) => String(r.uncovered)],
      ["Avg bid rank", (r) => fmtRank(r.avgRank)],
    ]
      .map(([label, cell]) => {
        return (
          "<tr><td>" +
          escapeHtml(label) +
          "</td>" +
          order.map((k) => "<td>" + cell(comparison[k]) + "</td>").join("") +
          "</tr>"
        );
      })
      .join("");

    const pickRow =
      "<tr><td>Preview</td>" +
      order
        .map((k) => {
          const solver = keyToSolver[k];
          const active = solver === selected;
          return (
            "<td>" +
            '<button type="button" class="pick-solver' +
            (active ? " is-active" : "") +
            '" data-compare-solver="' +
            escapeHtml(k) +
            '">' +
            (active ? "Showing" : "Show") +
            "</button></td>"
          );
        })
        .join("") +
      "</tr>";

    let phaseHtml = "";
    const phases = comparison.hybrid && comparison.hybrid.phases;
    if (phases) {
      const gs = phases.gale_shapley || {};
      const repair = phases.quota_repair || {};
      const fill = phases.hungarian_fill || {};
      phaseHtml =
        '<ol class="phase-log">' +
        "<li><strong>Gale–Shapley</strong> placed " +
        (gs.placed || 0) +
        "; " +
        (gs.blocking_pairs || 0) +
        " blocking pair(s).</li>" +
        "<li><strong>Quota repair</strong> made " +
        (repair.swaps || 0) +
        " swap(s) (" +
        (repair.violations_before || 0) +
        " → " +
        (repair.violations_after || 0) +
        " uncovered).</li>" +
        "<li><strong>Hungarian fill</strong> seated " +
        (fill.filled_slots || 0) +
        " leftover slot(s).</li>" +
        "</ol>";
    }

    els.compare.hidden = false;
    els.compare.innerHTML =
      "<h3>Solver comparison</h3>" +
      '<p class="compare-note">Same compatibility scores, different stage-2 algorithms. Click Show to preview that placement.</p>' +
      "<table><thead>" +
      header +
      "</thead><tbody>" +
      rows +
      pickRow +
      "</tbody></table>" +
      phaseHtml;
  }

  function showComparedSolver(key) {
    if (!result || !result.comparison || !result.comparison[key]) return;
    const run = result.comparison[key];
    const solverMap = {
      ilp: "ilp",
      hungarian: "hungarian",
      gale_shapley: "gale-shapley",
      hybrid: "hybrid",
    };
    result.solutions = [
      {
        rank: 1,
        status: run.status,
        score: run.objective,
        assignments: run.assignments,
        solver: solverMap[key] || key,
      },
    ];
    result.summary.solver = solverMap[key] || key;
    showRank(0);
  }

  const MATCH_WORKER_SRC = "match-worker.js?v=1";
  let activeWorker = null;

  /** Runs DpiMatcher.runMatch in a fresh worker, terminated once it settles. */
  function runMatchInWorker(data, options) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(MATCH_WORKER_SRC);
      } catch (err) {
        reject(err);
        return;
      }
      activeWorker = worker;
      const finish = (fn, value) => {
        worker.terminate();
        if (activeWorker === worker) activeWorker = null;
        fn(value);
      };
      worker.onmessage = (e) => {
        const msg = e.data || {};
        if (msg.ok) finish(resolve, msg.result);
        else finish(reject, new Error(msg.error || "Match worker failed."));
      };
      worker.onerror = (e) => {
        if (e.preventDefault) e.preventDefault();
        finish(reject, new Error("Match worker failed to load or crashed" + (e.message ? ": " + e.message : ".")));
      };
      worker.onmessageerror = () =>
        finish(reject, new Error("Match worker returned an unreadable result."));
      worker.postMessage({ data, options });
    });
  }

  let running = false;

  async function run() {
    if (running) return;
    running = true;
    if (els.run) els.run.disabled = true;
    try {
      await runInner();
    } finally {
      running = false;
      if (els.run) els.run.disabled = false;
    }
  }

  async function runInner() {
    if (!window.DpiMatcher) {
      setStatus("Matcher failed to load. Hard-refresh the page (Cmd+Shift+R).", true);
      return;
    }

    setStatus("Solving…");
    if (els.teams) {
      els.teams.innerHTML =
        '<div class="admin-match-empty">Solving cohort assignment…</div>';
    }
    if (els.leftover) els.leftover.hidden = true;
    if (els.compare) {
      els.compare.hidden = true;
      els.compare.innerHTML = "";
    }

    try {
      const { cohort: data, warnings } = await readInputCohort();
      renderWarnings(warnings);
      const topK = Number((els.topk && els.topk.value) || 5);
      const solver = (els.solver && els.solver.value) || "ilp";
      const t0 = performance.now();
      // Weights / overlap / skillPolicy stay at matcher.js defaults.
      result = await runMatchInWorker(data, {
        topK: solver === "ilp" ? topK : 1,
        solver,
        timeBudgetMs: Math.max(5000, topK * 2500),
      });
      const ms = Math.round(performance.now() - t0);

      if (!result.solutions.length) {
        if (els.scoreValue) els.scoreValue.textContent = "—";
        if (els.scoreMeta) {
          els.scoreMeta.textContent = "INFEASIBLE";
          els.scoreMeta.className = "meta warn";
        }
        updateStats(result.summary, { assignments: [] });
        if (els.teams) {
          els.teams.innerHTML =
            '<div class="admin-match-empty">No feasible assignment under current constraints.</div>';
        }
        renderPills(0, 0);
        renderComparison(result.comparison, null);
        setStatus(
          "No feasible cohort assignment found (" +
            ms +
            " ms, " +
            result.summary.solver +
            "). Check headcounts and hard gates.",
          true
        );
        return;
      }

      const team = window.DpiMatcher.teamSkillMetrics(
        result.idx,
        result.solutions[0].assignments
      );
      const phaseNote =
        result.phases && result.phases.quota_repair
          ? " Hybrid repaired " +
            result.phases.quota_repair.swaps +
            " skill gap(s)."
          : "";
      setStatus(
        (solver === "compare-all" ? "Compared all solvers" : "Matched with " + solver) +
          " in " +
          ms +
          " ms. Teams cover " +
          Math.round(team.coveragePct * 100) +
          "% of preferred skills." +
          phaseNote
      );
      showRank(0);
    } catch (err) {
      console.error(err);
      setStatus(err.message || String(err), true);
      if (els.teams) {
        els.teams.innerHTML =
          '<div class="admin-match-empty">Could not run match. Check the uploaded workbooks.</div>';
      }
    }
  }

  function clearInputs() {
    if (els.hostsXlsx) els.hostsXlsx.value = "";
    if (els.studentsXlsx) els.studentsXlsx.value = "";
    stagedCohort = null;
    stagedWarnings = [];
  }

  async function loadFromFirestore() {
    if (!window.DpiAdminData) {
      setStatus("Firestore data source is unavailable on this page.", true);
      return;
    }
    setStatus("Reading applications from Firestore…");
    try {
      const built = await window.DpiAdminData.buildCohortFromFirestore();
      clearInputs();
      stagedCohort = built.cohort;
      stagedWarnings = built.warnings;
      renderWarnings(built.warnings);
      setStatus(
        "Built a cohort from Firestore: " +
          built.cohort.users_students.length +
          " student(s), " +
          built.cohort.projects.length +
          " project(s). Click Run match."
      );
    } catch (err) {
      console.error(err);
      setStatus("Could not build from Firestore: " + (err.message || err), true);
    }
  }

  function handleStudentActivate(event) {
    const target = event.target.closest("[data-student-id]");
    if (!target) return;
    if (event.type === "keydown" && event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    const sid = Number(target.getAttribute("data-student-id"));
    if (!Number.isFinite(sid)) return;
    const scoreRaw = target.getAttribute("data-match-score");
    const projectRaw = target.getAttribute("data-match-project");
    const reason = target.getAttribute("data-match-reason");
    openStudentProfile(sid, {
      score: scoreRaw != null ? Number(scoreRaw) : null,
      projectId: projectRaw != null ? Number(projectRaw) : null,
      reason: reason || null,
    });
  }

  if (els.run) els.run.addEventListener("click", run);
  if (els.loadFirestore) els.loadFirestore.addEventListener("click", loadFromFirestore);
  if (els.solver) {
    els.solver.addEventListener("change", () => {
      const value = els.solver.value;
      if (els.solverBlurb) {
        els.solverBlurb.textContent = SOLVER_BLURBS[value] || "";
      }
      // Top-K only applies to the ILP search; other solvers return one placement.
      if (els.topk) els.topk.disabled = value !== "ilp";
    });
    if (els.topk) els.topk.disabled = els.solver.value !== "ilp";
  }
  if (els.compare) {
    els.compare.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-compare-solver]");
      if (!btn) return;
      showComparedSolver(btn.getAttribute("data-compare-solver"));
    });
  }
  if (els.teams) {
    els.teams.addEventListener("click", handleStudentActivate);
    els.teams.addEventListener("keydown", handleStudentActivate);
  }
  if (els.leftover) {
    els.leftover.addEventListener("click", handleStudentActivate);
    els.leftover.addEventListener("keydown", handleStudentActivate);
  }
  if (els.profileClose) els.profileClose.addEventListener("click", closeStudentProfile);
  if (els.profileBackdrop) {
    els.profileBackdrop.addEventListener("click", closeStudentProfile);
  }
  if (els.prev) els.prev.addEventListener("click", () => showRank(currentRank - 1));
  if (els.next) els.next.addEventListener("click", () => showRank(currentRank + 1));

  if (els.pills) {
    els.pills.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-sol]");
      if (!btn) return;
      showRank(Number(btn.getAttribute("data-sol")) - 1);
    });
  }

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && els.profileDrawer && !els.profileDrawer.hidden) {
      closeStudentProfile();
      return;
    }
    // Arrow keys cycle solutions only while the admin view is on screen.
    const admin = document.getElementById("view-admin");
    if (!admin || !admin.classList.contains("is-active")) return;
    if (!result || !result.solutions.length) return;
    if (e.key === "ArrowLeft") showRank(currentRank - 1);
    if (e.key === "ArrowRight") showRank(currentRank + 1);
  });
})();
