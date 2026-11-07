/**
 * Browser scoring + cohort assignment (top-k).
 *
 * This is a port of the *scoring rules* in demo/match_demo.py, not of the
 * Google OR-Tools CBC solver. The UI labels the default path "ILP":
 *   - ≤14 students AND ≤12 seats → exact branch-and-bound (solveExact)
 *   - otherwise → greedy construction + local swaps (solveHeuristic)
 *
 * skillPolicy (all-soft / must-cover) is accepted on runMatch but ignored on
 * that default path; only hybrid / compare-all honor it.
 *
 * Teammate overlap is still implemented in teamSkillBonus; the default slider
 * is 0 so it does not affect scores unless a caller passes options.overlap.
 *
 * Pure JS — no OR-Tools, and vendor/solver.js is not loaded.
 */

(function (global) {
  const DEFAULT_WEIGHTS = { preference: 8, skills: 6, topics: 4 };
  const ANY_PROJECT_BONUS_BETA = 0.1;
  // Stage 2 team bonuses, mirroring demo/match_demo.py. Small on purpose:
  // individual fit decides the match, these only separate near-equal teams.
  const TEAM_COVERAGE_WEIGHT = 0.12;
  const DEFAULT_OVERLAP_SLIDER = 0;
  const DAY_FIELDS = {
    weekdays: ["weekdays_start_hour", "weekdays_end_hour"],
    weekday: ["weekdays_start_hour", "weekdays_end_hour"],
    weekends: ["weekends_start_hour", "weekends_end_hour"],
    weekend: ["weekends_start_hour", "weekends_end_hour"],
  };

  function normalizeWeights(raw) {
    const total = Object.values(raw).reduce((a, b) => a + b, 0);
    if (total <= 0) {
      const n = Object.keys(raw).length;
      return Object.fromEntries(Object.keys(raw).map((k) => [k, 1 / n]));
    }
    return Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [k, v / total])
    );
  }

  function indexDataset(data) {
    const skills = Object.fromEntries(
      data.skills_dictionary.map((s) => [s.skill_id, s.skill_name])
    );
    const companies = Object.fromEntries(
      data.companies.map((c) => [c.company_id, c])
    );
    const projects = Object.fromEntries(
      data.projects.map((p) => [p.project_id, p])
    );
    const students = Object.fromEntries(
      data.users_students.map((s) => [s.student_id, s])
    );

    const studentSkills = new Map();
    for (const row of data.student_skills || []) {
      if (!studentSkills.has(row.student_id)) {
        studentSkills.set(row.student_id, new Set());
      }
      studentSkills.get(row.student_id).add(row.skill_id);
    }

    const projectReqs = new Map();
    for (const row of data.project_requirements || []) {
      if (!projectReqs.has(row.project_id)) projectReqs.set(row.project_id, []);
      projectReqs
        .get(row.project_id)
        .push([row.skill_id, Number(row.quantity_required)]);
    }

    const bids = new Map();
    const anyFits = new Map();
    for (const bid of data.student_bids || []) {
      if (!bids.has(bid.student_id)) bids.set(bid.student_id, new Map());
      bids.get(bid.student_id).set(bid.project_id, bid);
      if (bid.any_project_fits) anyFits.set(bid.student_id, true);
    }

    return {
      skills,
      companies,
      projects,
      students,
      studentSkills,
      projectReqs,
      bids,
      anyFits,
      studentIds: Object.keys(students).map(Number),
      projectIds: Object.keys(projects).map(Number),
    };
  }

  function featurePreference(sid, pid, idx) {
    const bid = idx.bids.get(sid)?.get(pid);
    if (!bid) return 0;
    return Math.max(0, Math.min(1, Number(bid.interest_level) / 10));
  }

  /** Skills the host named for a project. Quantities are not host input. */
  function preferredSkills(idx, pid) {
    return new Set((idx.projectReqs.get(pid) || []).map(([skillId]) => skillId));
  }

  /**
   * Fraction of a project's preferred skills this student personally has.
   * Depth counts: 4 of 6 preferred tools beats two applicants with one each.
   */
  function featureSkills(sid, pid, idx) {
    const needed = preferredSkills(idx, pid);
    if (!needed.size) return 1;
    const have = idx.studentSkills.get(sid) || new Set();
    let overlap = 0;
    for (const id of needed) if (have.has(id)) overlap += 1;
    return overlap / needed.size;
  }

  function featureTopics(sid, pid, idx) {
    const prefs = new Set(
      (idx.students[sid].topic_preferences || []).map((t) =>
        String(t).toLowerCase()
      )
    );
    const category = String(
      idx.projects[pid].topic_category || ""
    ).toLowerCase();
    if (!prefs.size || !category) return 0;
    if (prefs.has(category)) return 1;
    for (const p of prefs) {
      if (category.includes(p) || p.includes(category)) return 0.5;
    }
    return 0;
  }

  const FEATURES = {
    preference: featurePreference,
    skills: featureSkills,
    topics: featureTopics,
  };

  function hardGateGpa(sid, pid, idx) {
    const gpa = Number(idx.students[sid].gpa);
    const minimum = Number(idx.projects[pid].min_gpa_required || 0);
    return gpa >= minimum;
  }

  function hardGateAvailability(sid, pid, idx) {
    const student = idx.students[sid];
    const project = idx.projects[pid];

    if (Object.prototype.hasOwnProperty.call(student, "available_summer_9_to_5")) {
      const requires =
        project.requires_summer_9_to_5 === undefined
          ? true
          : Boolean(project.requires_summer_9_to_5);
      if (requires && !student.available_summer_9_to_5) {
        return [false, "not available summer 9-to-5"];
      }
      return [true, null];
    }

    const schedule = project.mandatory_schedule;
    if (!schedule) return [true, null];

    const avail = student.availability;
    if (!avail) return [false, "no availability provided for mandatory schedule"];

    const dayKey = String(schedule.days || "")
      .trim()
      .toLowerCase();
    const fields = DAY_FIELDS[dayKey];
    if (!fields) return [false, `unknown schedule days '${schedule.days}'`];

    const [startKey, endKey] = fields;
    const stuStart = avail[startKey];
    const stuEnd = avail[endKey];
    if (stuStart == null || stuEnd == null) {
      return [false, `unavailable on ${dayKey}`];
    }

    const projStart = Number(schedule.start_hour);
    const projEnd = Number(schedule.end_hour);
    const stuStartI = Number(stuStart);
    const stuEndI = Number(stuEnd);

    if (stuStartI <= projStart && stuEndI >= projEnd) return [true, null];
    return [
      false,
      `schedule mismatch (${dayKey} available ${stuStartI}-${stuEndI}, project needs ${projStart}-${projEnd})`,
    ];
  }

  /**
   * Stage 1 score for one student–project pair.
   * Hard gates (GPA, availability) fail → 0. Soft features are weighted,
   * then an "any project fits" bonus applies only if the student did not bid.
   */
  function compatibility(sid, pid, idx, weights, beta) {
    const detail = { hard_pass: false, features: {}, bonus: 0 };

    if (!hardGateGpa(sid, pid, idx)) {
      detail.reason = "GPA below minimum";
      return [0, detail];
    }

    const [okAvail, availReason] = hardGateAvailability(sid, pid, idx);
    if (!okAvail) {
      detail.reason = availReason || "availability mismatch";
      return [0, detail];
    }

    detail.hard_pass = true;
    let soft = 0;
    for (const [name, fn] of Object.entries(FEATURES)) {
      const val = fn(sid, pid, idx);
      detail.features[name] = Number(val.toFixed(4));
      soft += weights[name] * val;
    }

    const bidded = idx.bids.get(sid)?.has(pid);
    if (idx.anyFits.get(sid) && !bidded && soft > 0) {
      const bonus = beta * soft;
      detail.bonus = Number(bonus.toFixed(4));
      soft += bonus;
    }

    detail.soft = Number(soft.toFixed(4));
    return [soft, detail];
  }

  function buildMatrix(idx, weights, beta) {
    const C = new Map();
    const details = new Map();
    for (const sid of idx.studentIds) {
      for (const pid of idx.projectIds) {
        const key = `${sid}:${pid}`;
        const [score, detail] = compatibility(sid, pid, idx, weights, beta);
        C.set(key, score);
        details.set(key, detail);
      }
    }
    return { C, details };
  }

  function cGet(C, sid, pid) {
    return C.get(`${sid}:${pid}`) || 0;
  }

  function assignmentSignature(pairs) {
    return pairs
      .map(([sid, pid]) => `${sid}:${pid}`)
      .sort()
      .join("|");
  }

  /** Turn the 0–10 overlap slider into a weight relative to coverage. */
  function overlapWeight(coverageWeight, slider) {
    return (coverageWeight * Math.max(0, Math.min(10, slider))) / 10;
  }

  /**
   * Stage 2 score for one team: coverage of the host's preferred tools, plus
   * optional overlap credit when two teammates share a skill. Divided by the
   * number of preferred skills so a long wishlist cannot outweigh a short one.
   * Overlap weight is 0 at the product default.
   */
  function teamSkillBonus(idx, pid, sids) {
    const prefs = preferredSkills(idx, pid);
    if (!prefs.size) return 0;
    const { coverage, overlap } = idx.teamWeights;
    let covered = 0;
    let overlaps = 0;
    for (const skillId of prefs) {
      let holders = 0;
      for (const sid of sids) {
        if (idx.studentSkills.get(sid)?.has(skillId)) holders += 1;
      }
      if (holders >= 1) covered += 1;
      if (holders >= 2) overlaps += 1;
    }
    return (coverage * covered + overlap * overlaps) / prefs.size;
  }

  /** Coverage and overlap across every assembled team, for the admin summary. */
  function teamSkillMetrics(idx, assignments) {
    const members = new Map();
    for (const a of assignments) {
      if (!members.has(a.project_id)) members.set(a.project_id, []);
      members.get(a.project_id).push(a.student_id);
    }

    let covered = 0;
    let overlaps = 0;
    let total = 0;
    const perProject = new Map();

    for (const pid of idx.projectIds) {
      const prefs = preferredSkills(idx, pid);
      if (!prefs.size) continue;
      const team = members.get(pid) || [];
      let pCovered = 0;
      let pOverlaps = 0;
      const missing = [];
      const missingIds = [];
      for (const skillId of prefs) {
        let holders = 0;
        for (const sid of team) {
          if (idx.studentSkills.get(sid)?.has(skillId)) holders += 1;
        }
        if (holders >= 1) pCovered += 1;
        else {
          missing.push(idx.skills[skillId] || String(skillId));
          missingIds.push(skillId);
        }
        if (holders >= 2) pOverlaps += 1;
      }
      perProject.set(pid, {
        covered: pCovered,
        overlaps: pOverlaps,
        size: prefs.size,
        missing,
        missingIds,
      });
      covered += pCovered;
      overlaps += pOverlaps;
      total += prefs.size;
    }

    return {
      covered,
      overlaps,
      total,
      coveragePct: total ? covered / total : 1,
      perProject,
    };
  }

  function projectsOrderedByScarcity(idx, C) {
    return [...idx.projectIds].sort((a, b) => {
      const ca = idx.studentIds.filter((s) => cGet(C, s, a) > 0).length;
      const cb = idx.studentIds.filter((s) => cGet(C, s, b) > 0).length;
      const na = Number(idx.projects[a].interns_needed || 0);
      const nb = Number(idx.projects[b].interns_needed || 0);
      return ca - na - (cb - nb) || ca - cb;
    });
  }

  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    let r = 1;
    for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return r;
  }

  function bestComboExact(idx, C, pid, candidates, need) {
    let best = null;
    let bestScore = -Infinity;

    function rec(start, chosen, score) {
      if (chosen.length === need) {
        const total = score + teamSkillBonus(idx, pid, chosen);
        if (total > bestScore) {
          bestScore = total;
          best = chosen.slice();
        }
        return;
      }
      const left = need - chosen.length;
      for (let i = start; i <= candidates.length - left; i++) {
        const sid = candidates[i];
        chosen.push(sid);
        rec(i + 1, chosen, score + cGet(C, sid, pid));
        chosen.pop();
      }
    }

    rec(0, [], 0);
    return best ? { chosen: best, score: bestScore } : null;
  }

  /**
   * Add teammates one at a time, each time taking whoever adds the most.
   *
   * "Most" is individual compatibility plus what the pick does for the team's
   * coverage, so a slightly weaker applicant who brings the one tool nobody else
   * has can still win the seat.
   */
  function bestComboGreedy(idx, C, pid, candidates, need) {
    const chosen = [];
    const pool = candidates.slice();

    while (chosen.length < need && pool.length) {
      let bestIdx = -1;
      let bestKey = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const sid = pool[i];
        const key =
          cGet(C, sid, pid) + teamSkillBonus(idx, pid, chosen.concat(sid));
        if (key > bestKey) {
          bestKey = key;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) break;
      chosen.push(pool.splice(bestIdx, 1)[0]);
    }

    if (chosen.length !== need) return null;
    const score =
      chosen.reduce((sum, sid) => sum + cGet(C, sid, pid), 0) +
      teamSkillBonus(idx, pid, chosen);
    return { chosen, score };
  }

  function pickCombo(idx, C, pid, candidates, need) {
    if (candidates.length < need) return null;
    const sorted = candidates
      .slice()
      .sort((a, b) => cGet(C, b, pid) - cGet(C, a, pid));
    return binom(sorted.length, need) <= 25000
      ? bestComboExact(idx, C, pid, sorted, need)
      : bestComboGreedy(idx, C, pid, sorted, need);
  }

  function pairBanned(bannedPairs, sid, pid) {
    return bannedPairs.has(`${sid}:${pid}`);
  }

  function greedyConstructOnce(idx, C, bannedPairs, priority) {
    const used = new Set();
    const assignments = [];
    const ranked = projectsOrderedByScarcity(idx, C);
    const order = priority.length
      ? priority.concat(ranked.filter((pid) => !priority.includes(pid)))
      : ranked;

    for (let i = 0; i < order.length; i++) {
      const pid = order[i];
      const need = Number(idx.projects[pid].interns_needed || 0);
      if (need <= 0) continue;
      const candidates = idx.studentIds.filter(
        (s) =>
          !used.has(s) &&
          cGet(C, s, pid) > 0 &&
          !pairBanned(bannedPairs, s, pid)
      );
      const picked = pickCombo(idx, C, pid, candidates, need);
      if (!picked) return { starved: pid };
      for (const sid of picked.chosen) {
        used.add(sid);
        assignments.push({
          student_id: sid,
          project_id: pid,
          score: cGet(C, sid, pid),
        });
      }
    }

    const score = solutionScore(idx, C, assignments);
    return {
      assignments,
      score,
      signature: assignmentSignature(
        assignments.map((a) => [a.student_id, a.project_id])
      ),
    };
  }

  /**
   * Build a full assignment, reordering after each starved project.
   *
   * Scarcity ordering is only a guess: students who hold several in-demand
   * skills can be spent on one of them and leave another project with nobody.
   * Rather than predict those interactions, promote whichever project came up
   * empty and rebuild, so it gets first pick of the pool next time.
   */
  function greedyConstruct(idx, C, bannedPairs) {
    const priority = [];
    for (let attempt = 0; attempt <= idx.projectIds.length; attempt++) {
      const built = greedyConstructOnce(idx, C, bannedPairs, priority);
      if (built.assignments) return built;
      if (priority.includes(built.starved)) return null;
      priority.unshift(built.starved);
    }
    return null;
  }

  function projectMembers(assignments, pid) {
    return assignments.filter((a) => a.project_id === pid).map((a) => a.student_id);
  }

  /** Individual compatibility plus every team's stage 2 bonus. */
  function solutionScore(idx, C, assignments) {
    const teams = new Map();
    let total = 0;
    for (const a of assignments) {
      total += a.score ?? cGet(C, a.student_id, a.project_id);
      if (!teams.has(a.project_id)) teams.set(a.project_id, []);
      teams.get(a.project_id).push(a.student_id);
    }
    for (const [pid, sids] of teams) total += teamSkillBonus(idx, pid, sids);
    return total;
  }

  function improveLocal(idx, C, solution, bannedPairs, rounds) {
    if (!solution) return null;
    let assignments = solution.assignments.map((a) => ({ ...a }));
    let score = solution.score;

    for (let r = 0; r < rounds; r++) {
      let improved = false;

      // Try swapping two assigned students across projects
      for (let i = 0; i < assignments.length; i++) {
        for (let j = i + 1; j < assignments.length; j++) {
          const a = assignments[i];
          const b = assignments[j];
          if (a.project_id === b.project_id) continue;
          if (cGet(C, a.student_id, b.project_id) <= 0) continue;
          if (cGet(C, b.student_id, a.project_id) <= 0) continue;
          if (pairBanned(bannedPairs, a.student_id, b.project_id)) continue;
          if (pairBanned(bannedPairs, b.student_id, a.project_id)) continue;

          const oldTeamA = projectMembers(assignments, a.project_id);
          const oldTeamB = projectMembers(assignments, b.project_id);
          const teamA = oldTeamA.map((sid) =>
            sid === a.student_id ? b.student_id : sid
          );
          const teamB = oldTeamB.map((sid) =>
            sid === b.student_id ? a.student_id : sid
          );

          const delta =
            cGet(C, a.student_id, b.project_id) +
            cGet(C, b.student_id, a.project_id) -
            a.score -
            b.score +
            teamSkillBonus(idx, a.project_id, teamA) +
            teamSkillBonus(idx, b.project_id, teamB) -
            teamSkillBonus(idx, a.project_id, oldTeamA) -
            teamSkillBonus(idx, b.project_id, oldTeamB);
          if (delta > 1e-12) {
            const oldA = a.project_id;
            const oldB = b.project_id;
            a.project_id = oldB;
            a.score = cGet(C, a.student_id, oldB);
            b.project_id = oldA;
            b.score = cGet(C, b.student_id, oldA);
            score += delta;
            improved = true;
          }
        }
      }

      // Try replacing an assignee with an unassigned student
      const assignedIds = new Set(assignments.map((a) => a.student_id));
      const free = idx.studentIds.filter((s) => !assignedIds.has(s));
      for (let i = 0; i < assignments.length; i++) {
        const a = assignments[i];
        for (const sid of free) {
          if (cGet(C, sid, a.project_id) <= 0) continue;
          if (pairBanned(bannedPairs, sid, a.project_id)) continue;
          const oldTeam = projectMembers(assignments, a.project_id);
          const team = oldTeam.map((id) => (id === a.student_id ? sid : id));
          const delta =
            cGet(C, sid, a.project_id) -
            a.score +
            teamSkillBonus(idx, a.project_id, team) -
            teamSkillBonus(idx, a.project_id, oldTeam);
          if (delta > 1e-12) {
            assignedIds.delete(a.student_id);
            assignedIds.add(sid);
            free.splice(free.indexOf(sid), 1, a.student_id);
            a.student_id = sid;
            a.score = cGet(C, sid, a.project_id);
            score += delta;
            improved = true;
            break;
          }
        }
      }

      if (!improved) break;
    }

    return {
      assignments,
      score,
      signature: assignmentSignature(
        assignments.map((a) => [a.student_id, a.project_id])
      ),
    };
  }

  /**
   * Exact combinatorial search for small cohorts (see problemIsSmall).
   * Projects ordered by scarcity; branch-and-bound with an optimistic remaining
   * upper bound and a wall-clock timeBudgetMs. Not Google OR-Tools CBC.
   */
  function solveExact(idx, C, excludedSigs, bannedPairs, timeBudgetMs) {
    const t0 = performance.now();
    const seats = idx.projectIds.reduce(
      (sum, pid) => sum + Number(idx.projects[pid].interns_needed || 0),
      0
    );
    if (seats > idx.studentIds.length) {
      return { status: "INFEASIBLE", assignments: [], score: 0 };
    }

    const projectsOrdered = projectsOrderedByScarcity(idx, C);

    for (const pid of projectsOrdered) {
      const need = Number(idx.projects[pid].interns_needed || 0);
      const eligible = idx.studentIds.filter(
        (s) => cGet(C, s, pid) > 0 && !pairBanned(bannedPairs, s, pid)
      ).length;
      if (need > 0 && eligible < need) {
        return { status: "INFEASIBLE", assignments: [], score: 0 };
      }
    }

    let best = null;
    let timedOut = false;
    const used = new Set();
    const current = [];

    // Optimistic bound on what the unfilled projects could still add: the best
    // individual scores left, plus the most any team bonus can be worth.
    const maxTeamBonus = idx.teamWeights.coverage + idx.teamWeights.overlap;

    function remainingUpper(pIndex) {
      let ub = 0;
      const free = idx.studentIds.filter((s) => !used.has(s));
      for (let i = pIndex; i < projectsOrdered.length; i++) {
        const pid = projectsOrdered[i];
        const need = Number(idx.projects[pid].interns_needed || 0);
        if (need <= 0) continue;
        const scores = free
          .filter((s) => !pairBanned(bannedPairs, s, pid))
          .map((s) => cGet(C, s, pid))
          .filter((v) => v > 0)
          .sort((a, b) => b - a);
        if (scores.length < need) return -Infinity;
        for (let j = 0; j < need; j++) ub += scores[j];
        ub += maxTeamBonus;
      }
      return ub;
    }

    function chooseCombo(pid, need, candidates, start, chosen, scoreSoFar, pIndex) {
      if (timedOut) return;
      if (performance.now() - t0 > timeBudgetMs) {
        timedOut = true;
        return;
      }

      if (chosen.length === need) {
        for (const sid of chosen) used.add(sid);
        search(pIndex + 1, scoreSoFar + teamSkillBonus(idx, pid, chosen));
        for (const sid of chosen) used.delete(sid);
        return;
      }

      const remainingSlots = need - chosen.length;
      for (let i = start; i <= candidates.length - remainingSlots; i++) {
        if (timedOut) return;
        const sid = candidates[i];
        chosen.push(sid);
        current.push([sid, pid, cGet(C, sid, pid)]);
        chooseCombo(
          pid,
          need,
          candidates,
          i + 1,
          chosen,
          scoreSoFar + cGet(C, sid, pid),
          pIndex
        );
        chosen.pop();
        current.pop();
      }
    }

    function search(pIndex, scoreSoFar) {
      if (timedOut) return;
      if (performance.now() - t0 > timeBudgetMs) {
        timedOut = true;
        return;
      }

      if (pIndex === projectsOrdered.length) {
        const sig = assignmentSignature(current.map(([s, p]) => [s, p]));
        if (excludedSigs.has(sig)) return;
        if (!best || scoreSoFar > best.score + 1e-12) {
          best = {
            score: scoreSoFar,
            assignments: current.map(([sid, pid, score]) => ({
              student_id: sid,
              project_id: pid,
              score,
            })),
            signature: sig,
          };
        }
        return;
      }

      const ub = remainingUpper(pIndex);
      if (!Number.isFinite(ub)) return;
      if (best && scoreSoFar + ub <= best.score + 1e-12) return;

      const pid = projectsOrdered[pIndex];
      const need = Number(idx.projects[pid].interns_needed || 0);

      if (need === 0) {
        search(pIndex + 1, scoreSoFar);
        return;
      }

      const candidates = idx.studentIds
        .filter(
          (s) =>
            !used.has(s) &&
            cGet(C, s, pid) > 0 &&
            !pairBanned(bannedPairs, s, pid)
        )
        .sort((a, b) => cGet(C, b, pid) - cGet(C, a, pid));

      if (candidates.length < need) return;
      chooseCombo(pid, need, candidates, 0, [], scoreSoFar, pIndex);
    }

    search(0, 0);

    if (!best) {
      return {
        status: timedOut ? "TIMEOUT" : "INFEASIBLE",
        assignments: [],
        score: 0,
      };
    }

    return {
      status: timedOut ? "FEASIBLE" : "OPTIMAL",
      assignments: best.assignments,
      score: best.score,
      signature: best.signature,
    };
  }

  /** Greedy construct + local swap/replace. Used when the cohort is too big for solveExact. */
  function solveHeuristic(idx, C, excludedSigs, bannedPairs) {
    const built = greedyConstruct(idx, C, bannedPairs);
    if (!built) return { status: "INFEASIBLE", assignments: [], score: 0 };
    const improved = improveLocal(idx, C, built, bannedPairs, 40);
    if (excludedSigs.has(improved.signature)) {
      // Force diversity: ban one pair and retry a few times
      let best = null;
      for (const a of improved.assignments) {
        const ban = new Set(bannedPairs);
        ban.add(`${a.student_id}:${a.project_id}`);
        const alt = greedyConstruct(idx, C, ban);
        if (!alt) continue;
        const altImp = improveLocal(idx, C, alt, ban, 25);
        if (excludedSigs.has(altImp.signature)) continue;
        if (!best || altImp.score > best.score) best = altImp;
      }
      if (!best) return { status: "INFEASIBLE", assignments: [], score: 0 };
      return { status: "HEURISTIC", ...best };
    }
    return { status: "HEURISTIC", ...improved };
  }

  /** Exact search is tractable only for tiny cohorts (≤14 students, ≤12 seats). */
  function problemIsSmall(idx) {
    const seats = idx.projectIds.reduce(
      (sum, pid) => sum + Number(idx.projects[pid].interns_needed || 0),
      0
    );
    return idx.studentIds.length <= 14 && seats <= 12;
  }

  function solveOnce(idx, C, excludedSigs, bannedPairs, timeBudgetMs) {
    if (problemIsSmall(idx)) {
      return solveExact(idx, C, excludedSigs, bannedPairs, timeBudgetMs);
    }
    return solveHeuristic(idx, C, excludedSigs, bannedPairs);
  }

  /**
   * Return up to k alternate assignments.
   * Exact mode excludes full signatures (true next-best). Heuristic mode
   * diversifies by banning a pair from the previous solution — not guaranteed
   * to be the next-best globally.
   */
  function solveTopK(idx, C, k, timeBudgetMs) {
    const excluded = new Set();
    const solutions = [];
    const budgetPerSolve = Math.max(500, Math.floor(timeBudgetMs / k));
    const small = problemIsSmall(idx);

    if (small) {
      // Exact: only exclude full assignment signatures (true next-best search).
      for (let i = 0; i < k; i++) {
        const result = solveExact(
          idx,
          C,
          excluded,
          new Set(),
          budgetPerSolve
        );
        if (!result.assignments.length) break;
        solutions.push({
          rank: i + 1,
          status: result.status,
          score: result.score,
          assignments: result.assignments,
        });
        if (result.signature) excluded.add(result.signature);
      }
      return solutions;
    }

    // Heuristic: build diverse alternatives by banning pairs from prior solutions.
    let bannedPairs = new Set();
    for (let i = 0; i < k; i++) {
      const result = solveHeuristic(idx, C, excluded, bannedPairs);
      if (!result.assignments.length) break;
      solutions.push({
        rank: i + 1,
        status: result.status,
        score: result.score,
        assignments: result.assignments,
      });
      if (result.signature) excluded.add(result.signature);
      if (result.assignments.length) {
        const topPair = [...result.assignments].sort(
          (a, b) => b.score - a.score
        )[0];
        bannedPairs = new Set(bannedPairs);
        bannedPairs.add(`${topPair.student_id}:${topPair.project_id}`);
      }
    }

    if (solutions.length && solutions.length < k) {
      const seed = solutions[0];
      const candidates = [];
      for (const a of seed.assignments) {
        const ban = new Set([`${a.student_id}:${a.project_id}`]);
        const alt = solveHeuristic(idx, C, excluded, ban);
        if (!alt.assignments.length) continue;
        if (excluded.has(alt.signature)) continue;
        candidates.push(alt);
        excluded.add(alt.signature);
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const alt of candidates) {
        if (solutions.length >= k) break;
        solutions.push({
          rank: solutions.length + 1,
          status: alt.status,
          score: alt.score,
          assignments: alt.assignments,
        });
      }
      solutions.sort((a, b) => b.score - a.score);
      solutions.forEach((s, i) => {
        s.rank = i + 1;
      });
    }

    return solutions.slice(0, k);
  }

  function groupByProject(idx, assignments) {
    const byProject = new Map();
    for (const pid of idx.projectIds) {
      byProject.set(pid, []);
    }
    for (const a of assignments) {
      byProject.get(a.project_id).push(a);
    }
    return byProject;
  }

  function rejectionReason(sid, idx, C, details) {
    const eligible = idx.projectIds.filter((pid) => cGet(C, sid, pid) > 0);
    if (!eligible.length) {
      const reasonCounts = new Map();
      for (const pid of idx.projectIds) {
        const d = details.get(`${sid}:${pid}`) || {};
        if (!d.hard_pass) {
          let reason = d.reason || "ineligible";
          if (String(reason).startsWith("schedule mismatch")) {
            reason = "schedule mismatch";
          }
          reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
        }
      }
      if (reasonCounts.size) {
        const parts = [...reasonCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 4)
          .map(([r, n]) => `${r} ×${n}`);
        return "Ineligible for all projects — " + parts.join("; ");
      }
      return "No positive compatibility with any project";
    }

    const ranked = [...eligible].sort(
      (a, b) => cGet(C, sid, b) - cGet(C, sid, a)
    );
    const top = ranked
      .slice(0, 3)
      .map(
        (pid) =>
          `${idx.projects[pid].project_title} (${cGet(C, sid, pid).toFixed(2)})`
      )
      .join(", ");
    const extra =
      ranked.length > 3 ? ` (+${ranked.length - 3} more)` : "";
    return (
      `Eligible but not selected — best options: ${top}${extra}. ` +
      "Seats went to stronger fits."
    );
  }

  /**
   * Score the cohort, then dispatch to ILP / Hungarian / Gale–Shapley / hybrid.
   * Default solver "ilp" calls solveTopK and does not apply skillPolicy.
   * The admin UI typically passes only { topK, solver, timeBudgetMs }.
   */
  function runMatch(data, options = {}) {
    const k = Math.max(1, Math.min(10, options.topK || 5));
    const timeBudgetMs = options.timeBudgetMs || 8000;
    const rawWeights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    const weights = normalizeWeights(rawWeights);
    const beta = options.beta ?? ANY_PROJECT_BONUS_BETA;
    const coverageWeight = options.coverageWeight ?? TEAM_COVERAGE_WEIGHT;
    const overlapSlider = options.overlap ?? DEFAULT_OVERLAP_SLIDER;
    const solver = options.solver || "ilp";
    const skillPolicy = options.skillPolicy || "all-soft";

    const idx = indexDataset(data);
    // Stage 2 settings ride along on the index so every search function can read
    // them without threading a parameter through the whole call chain.
    idx.teamWeights = {
      coverage: coverageWeight,
      overlap: overlapWeight(coverageWeight, overlapSlider),
    };
    const { C, details } = buildMatrix(idx, weights, beta);

    let solutions = [];
    let comparison = null;
    let phases = null;
    let mode = problemIsSmall(idx) ? "exact" : "heuristic";

    const Alt = global.DpiAlternateSolvers;

    if (solver === "compare-all" && Alt) {
      comparison = Alt.compareSolvers(idx, C, {
        topK: 1,
        timeBudgetMs,
        skillPolicy,
      });
      // Show ILP placements by default; UI can switch via comparison.
      const primary = comparison.ilp;
      solutions = [
        {
          rank: 1,
          status: primary.status,
          score: primary.objective,
          assignments: primary.assignments,
          solver: "ilp",
        },
      ];
      mode = "compare-all";
    } else if (solver === "hungarian" && Alt) {
      const r = Alt.solveHungarian(idx, C);
      const summary = Alt.summarize(idx, "Hungarian", r.status, r.assignments);
      solutions = r.assignments.length
        ? [
            {
              rank: 1,
              status: r.status,
              score: summary.objective,
              assignments: r.assignments,
              solver: "hungarian",
            },
          ]
        : [];
      mode = "hungarian";
    } else if (solver === "gale-shapley" && Alt) {
      const r = Alt.solveGaleShapley(idx, C);
      const summary = Alt.summarize(idx, "Gale–Shapley", r.status, r.assignments);
      solutions = r.assignments.length
        ? [
            {
              rank: 1,
              status: r.status,
              score: summary.objective,
              assignments: r.assignments,
              solver: "gale-shapley",
            },
          ]
        : [];
      mode = "gale-shapley";
    } else if (solver === "hybrid" && Alt) {
      const r = Alt.solveHybrid(idx, C, { skillPolicy });
      const summary = Alt.summarize(idx, "Hybrid", r.status, r.assignments);
      phases = r.phases;
      solutions = r.assignments.length
        ? [
            {
              rank: 1,
              status: r.status,
              score: summary.objective,
              assignments: r.assignments,
              solver: "hybrid",
            },
          ]
        : [];
      mode = "hybrid";
    } else {
      solutions = solveTopK(idx, C, k, timeBudgetMs).map((s) => ({
        ...s,
        solver: "ilp",
      }));
    }

    const hardFails = [...details.values()].filter((d) => !d.hard_pass).length;
    const seats = idx.projectIds.reduce(
      (sum, pid) => sum + Number(idx.projects[pid].interns_needed || 0),
      0
    );

    return {
      idx,
      C,
      details,
      weights,
      solutions,
      comparison,
      phases,
      summary: {
        students: idx.studentIds.length,
        projects: idx.projectIds.length,
        seats,
        hard_fail_pairs: hardFails,
        solutions_found: solutions.length,
        mode,
        solver,
        overlap_slider: overlapSlider,
        coverage_weight: coverageWeight,
      },
    };
  }

  global.DpiMatcher = {
    runMatch,
    indexDataset,
    buildMatrix,
    groupByProject,
    rejectionReason,
    preferredSkills,
    teamSkillMetrics,
    solveTopK,
    cGet,
    DEFAULT_WEIGHTS,
    DEFAULT_OVERLAP_SLIDER,
  };
})(typeof self !== "undefined" ? self : window);
