/**
 * Browser ports of demo/alternate_solvers.py.
 *
 * Same stage-2 interface as the Python CLI: Hungarian, Gale-Shapley, and Hybrid
 * (GS → skill repair → Hungarian fill). Depends on DpiMatcher helpers already
 * loaded from matcher.js.
 *
 * Hosts do not rank students. Gale–Shapley ranks projects by compatibility C.
 * Hybrid is the only JS path that honors skillPolicy (all-soft / must-cover).
 */
(function (global) {
  const MAX_REPAIR_ATTEMPTS = 50;

  function cGet(C, sid, pid) {
    return global.DpiMatcher.cGet(C, sid, pid);
  }

  function capacity(idx) {
    const out = {};
    for (const pid of idx.projectIds) {
      out[pid] = Number(idx.projects[pid].interns_needed || 0);
    }
    return out;
  }

  function slots(idx, caps) {
    const need = caps || capacity(idx);
    const list = [];
    for (const pid of idx.projectIds) {
      for (let i = 0; i < need[pid]; i++) list.push(pid);
    }
    return list;
  }

  function solutionObjective(idx, assignments) {
    let total = 0;
    const teams = new Map();
    for (const a of assignments) {
      total += a.score;
      if (!teams.has(a.project_id)) teams.set(a.project_id, []);
      teams.get(a.project_id).push(a.student_id);
    }
    // Prefer DpiMatcher's teamSkillBonus via metrics + teamWeights if present.
    const metrics = global.DpiMatcher.teamSkillMetrics(idx, assignments);
    const cov = idx.teamWeights?.coverage ?? 0.12;
    const ovl = idx.teamWeights?.overlap ?? 0;
    for (const p of metrics.perProject.values()) {
      total += (cov * p.covered + ovl * p.overlaps) / p.size;
    }
    return total;
  }

  /**
   * Pure-JS Munkres (Hungarian) for rectangular cost matrices.
   * Minimizes cost; pad to square with zeros.
   * star = assigned zero, prime = candidate zero, cover = lined-out row/col.
   */
  function munkres(cost) {
    const nRows = cost.length;
    if (!nRows) return [];
    const nCols = cost[0].length;
    const n = Math.max(nRows, nCols);
    const a = Array.from({ length: n }, (_, i) =>
      Array.from({ length: n }, (_, j) =>
        i < nRows && j < nCols ? cost[i][j] : 0
      )
    );

    // Row reduce
    for (let i = 0; i < n; i++) {
      let min = Infinity;
      for (let j = 0; j < n; j++) if (a[i][j] < min) min = a[i][j];
      if (Number.isFinite(min)) for (let j = 0; j < n; j++) a[i][j] -= min;
    }
    // Column reduce
    for (let j = 0; j < n; j++) {
      let min = Infinity;
      for (let i = 0; i < n; i++) if (a[i][j] < min) min = a[i][j];
      if (Number.isFinite(min)) for (let i = 0; i < n; i++) a[i][j] -= min;
    }

    const star = Array.from({ length: n }, () => Array(n).fill(false));
    const prime = Array.from({ length: n }, () => Array(n).fill(false));
    const rowCover = Array(n).fill(false);
    const colCover = Array(n).fill(false);

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (a[i][j] === 0 && !rowCover[i] && !colCover[j]) {
          star[i][j] = true;
          rowCover[i] = true;
          colCover[j] = true;
        }
      }
    }
    rowCover.fill(false);
    colCover.fill(false);

    function coverStarred() {
      colCover.fill(false);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (star[i][j]) colCover[j] = true;
        }
      }
      return colCover.filter(Boolean).length;
    }

    function findUncoveredZero() {
      for (let i = 0; i < n; i++) {
        if (rowCover[i]) continue;
        for (let j = 0; j < n; j++) {
          if (!colCover[j] && a[i][j] === 0) return [i, j];
        }
      }
      return null;
    }

    function starInRow(i) {
      for (let j = 0; j < n; j++) if (star[i][j]) return j;
      return -1;
    }

    function starInCol(j) {
      for (let i = 0; i < n; i++) if (star[i][j]) return i;
      return -1;
    }

    function primeInRow(i) {
      for (let j = 0; j < n; j++) if (prime[i][j]) return j;
      return -1;
    }

    function augmentPath(path) {
      for (const [r, c] of path) star[r][c] = !star[r][c];
    }

    function clearPrimes() {
      for (let i = 0; i < n; i++) prime[i].fill(false);
    }

    function adjustMatrix() {
      let min = Infinity;
      for (let i = 0; i < n; i++) {
        if (rowCover[i]) continue;
        for (let j = 0; j < n; j++) {
          if (!colCover[j] && a[i][j] < min) min = a[i][j];
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          if (rowCover[i]) a[i][j] += min;
          if (!colCover[j]) a[i][j] -= min;
        }
      }
    }

    let covered = coverStarred();
    let guard = 0;
    // Cover starred zeros; prime uncovered zeros; augment until every row is assigned.
    while (covered < n && guard++ < n * n * 4) {
      let zero = findUncoveredZero();
      while (!zero) {
        adjustMatrix();
        zero = findUncoveredZero();
      }
      const [zi, zj] = zero;
      prime[zi][zj] = true;
      const starCol = starInRow(zi);
      if (starCol >= 0) {
        rowCover[zi] = true;
        colCover[starCol] = false;
      } else {
        const path = [[zi, zj]];
        let done = false;
        while (!done) {
          const ri = starInCol(path[path.length - 1][1]);
          if (ri < 0) {
            done = true;
          } else {
            path.push([ri, path[path.length - 1][1]]);
            const pj = primeInRow(ri);
            path.push([ri, pj]);
          }
        }
        augmentPath(path);
        clearPrimes();
        rowCover.fill(false);
        covered = coverStarred();
      }
    }

    const pairs = [];
    for (let i = 0; i < nRows; i++) {
      for (let j = 0; j < nCols; j++) {
        if (star[i][j]) pairs.push([i, j]);
      }
    }
    return pairs;
  }

  function hungarianAssign(idx, C, students, seatList) {
    if (!students.length || !seatList.length) return [];
    const cost = students.map((sid) =>
      seatList.map((pid) => {
        const score = cGet(C, sid, pid);
        return score > 0 ? -score : 0;
      })
    );
    const pairs = munkres(cost);
    const assignments = [];
    for (const [i, j] of pairs) {
      const sid = students[i];
      const pid = seatList[j];
      const score = cGet(C, sid, pid);
      if (score > 0) {
        assignments.push({ student_id: sid, project_id: pid, score });
      }
    }
    return assignments;
  }

  function solveHungarian(idx, C) {
    const assignments = hungarianAssign(
      idx,
      C,
      [...idx.studentIds].sort((a, b) => a - b),
      slots(idx)
    );
    return {
      status: assignments.length ? "OPTIMAL" : "INFEASIBLE",
      assignments,
    };
  }

  function studentRanking(idx, C, sid) {
    const bidMap = idx.bids.get(sid) || new Map();
    const ranked = [...bidMap.keys()]
      .filter((pid) => cGet(C, sid, pid) > 0)
      .sort(
        (a, b) =>
          Number(bidMap.get(b).interest_level || 0) -
          Number(bidMap.get(a).interest_level || 0)
      );
    const unranked = idx.projectIds
      .filter((pid) => !bidMap.has(pid) && cGet(C, sid, pid) > 0)
      .sort((a, b) => cGet(C, sid, b) - cGet(C, sid, a));
    return ranked.concat(unranked);
  }

  /** Count student–project pairs that would rather swap (stability audit). */
  function blockingPairs(idx, C, assignments) {
    const caps = capacity(idx);
    const rankings = new Map();
    for (const sid of idx.studentIds) {
      rankings.set(sid, studentRanking(idx, C, sid));
    }
    const placed = new Map();
    const members = new Map();
    for (const a of assignments) {
      placed.set(a.student_id, a.project_id);
      if (!members.has(a.project_id)) members.set(a.project_id, []);
      members.get(a.project_id).push(a.student_id);
    }

    let count = 0;
    for (const [sid, ranking] of rankings) {
      const current = placed.get(sid);
      const currentRank =
        current != null && ranking.includes(current)
          ? ranking.indexOf(current)
          : ranking.length;
      for (const pid of ranking.slice(0, currentRank)) {
        const team = members.get(pid) || [];
        if (team.length < caps[pid]) {
          count += 1;
          continue;
        }
        let worst = Infinity;
        for (const other of team) {
          const s = cGet(C, other, pid);
          if (s < worst) worst = s;
        }
        if (cGet(C, sid, pid) > worst) count += 1;
      }
    }
    return count;
  }

  /**
   * Student-proposing Gale–Shapley. Projects "rank" applicants by C because
   * hosts do not submit rankings.
   */
  function solveGaleShapley(idx, C) {
    const caps = capacity(idx);
    const rankings = new Map();
    for (const sid of idx.studentIds) {
      rankings.set(sid, studentRanking(idx, C, sid));
    }
    const held = new Map();
    for (const pid of idx.projectIds) held.set(pid, []);
    const nextChoice = new Map();
    const free = [];
    for (const [sid, ranking] of rankings) {
      if (ranking.length) free.push(sid);
      nextChoice.set(sid, 0);
    }

    while (free.length) {
      const sid = free.pop();
      const ranking = rankings.get(sid);
      while (nextChoice.get(sid) < ranking.length) {
        const step = nextChoice.get(sid);
        const pid = ranking[step];
        nextChoice.set(sid, step + 1);
        if (caps[pid] <= 0) continue;
        const team = held.get(pid);
        team.push(sid);
        team.sort((a, b) => cGet(C, b, pid) - cGet(C, a, pid));
        if (team.length > caps[pid]) {
          const rejected = team.pop();
          if (rejected !== sid) {
            free.push(rejected);
            break;
          }
          continue;
        }
        break;
      }
    }

    const assignments = [];
    for (const [pid, team] of held) {
      for (const sid of team) {
        assignments.push({
          student_id: sid,
          project_id: pid,
          score: cGet(C, sid, pid),
        });
      }
    }
    return {
      status: assignments.length ? "FEASIBLE" : "INFEASIBLE",
      assignments,
    };
  }

  /**
   * Swap seated students (or pull waitlisted ones) to close uncovered preferred
   * skills. must-cover refuses a swap that drops C to 0; all-soft is looser.
   */
  function repairSkillGaps(idx, C, assignments, skillPolicy) {
    let working = assignments.map((a) => ({ ...a }));
    let swaps = 0;
    let attempts = 0;

    while (attempts < MAX_REPAIR_ATTEMPTS) {
      const metrics = global.DpiMatcher.teamSkillMetrics(idx, working);
      const placed = new Set(working.map((a) => a.student_id));
      const gaps = [];
      for (const [pid, p] of metrics.perProject) {
        for (const skillId of p.missingIds || []) {
          gaps.push([pid, skillId]);
        }
      }
      if (!gaps.length) break;

      let improved = false;
      for (const [pid, skillId] of gaps) {
        attempts += 1;
        if (attempts > MAX_REPAIR_ATTEMPTS) break;

        const incumbents = working
          .filter((a) => a.project_id === pid)
          .sort((a, b) => a.score - b.score);
        const candidates = idx.studentIds
          .filter(
            (sid) =>
              !placed.has(sid) &&
              cGet(C, sid, pid) > 0 &&
              idx.studentSkills.get(sid)?.has(skillId)
          )
          .sort((a, b) => cGet(C, b, pid) - cGet(C, a, pid));
        if (!incumbents.length || !candidates.length) continue;

        const before = solutionObjective(idx, working);
        const outgoing = incumbents[0];
        const incoming = candidates[0];
        const trial = working.filter((a) => a !== outgoing);
        trial.push({
          student_id: incoming,
          project_id: pid,
          score: cGet(C, incoming, pid),
        });

        let accept = solutionObjective(idx, trial) > before + 1e-9;
        if (skillPolicy === "must-cover") {
          const coveredBefore = global.DpiMatcher.teamSkillMetrics(
            idx,
            working
          ).covered;
          const coveredAfter = global.DpiMatcher.teamSkillMetrics(
            idx,
            trial
          ).covered;
          accept = coveredAfter > coveredBefore;
        }
        if (accept) {
          working = trial;
          placed.delete(outgoing.student_id);
          placed.add(incoming);
          swaps += 1;
          improved = true;
          break;
        }
      }
      if (!improved) break;
    }
    return { assignments: working, swaps };
  }

  /** Gale–Shapley → skill-gap repair (honors skillPolicy) → Hungarian fill leftover seats. */
  function solveHybrid(idx, C, options = {}) {
    const skillPolicy = options.skillPolicy || "all-soft";
    let { assignments } = solveGaleShapley(idx, C);
    const metrics0 = global.DpiMatcher.teamSkillMetrics(idx, assignments);
    const violationsBefore = metrics0.total - metrics0.covered;

    const phases = {
      gale_shapley: {
        placed: assignments.length,
        blocking_pairs: blockingPairs(idx, C, assignments),
      },
    };

    const repaired = repairSkillGaps(idx, C, assignments, skillPolicy);
    assignments = repaired.assignments;
    const metrics1 = global.DpiMatcher.teamSkillMetrics(idx, assignments);
    const violationsAfter = metrics1.total - metrics1.covered;
    phases.quota_repair = {
      swaps: repaired.swaps,
      violations_before: violationsBefore,
      violations_after: violationsAfter,
    };

    const caps = capacity(idx);
    for (const a of assignments) caps[a.project_id] -= 1;
    const openSlots = [];
    for (const pid of idx.projectIds) {
      for (let i = 0; i < caps[pid]; i++) openSlots.push(pid);
    }
    const placed = new Set(assignments.map((a) => a.student_id));
    const spare = idx.studentIds
      .filter((sid) => !placed.has(sid))
      .sort((a, b) => a - b);
    const fill = hungarianAssign(idx, C, spare, openSlots);
    assignments = assignments.concat(fill);
    phases.hungarian_fill = { filled_slots: fill.length };
    const finalMetrics = global.DpiMatcher.teamSkillMetrics(idx, assignments);
    phases.final_uncovered = finalMetrics.total - finalMetrics.covered;

    return {
      status: assignments.length ? "FEASIBLE" : "INFEASIBLE",
      assignments,
      phases,
    };
  }

  function averageBidRank(idx, assignments) {
    const ranks = [];
    for (const a of assignments) {
      const bidMap = idx.bids.get(a.student_id);
      if (!bidMap || !bidMap.has(a.project_id)) continue;
      const ordered = [...bidMap.keys()].sort(
        (p, q) =>
          Number(bidMap.get(q).interest_level || 0) -
          Number(bidMap.get(p).interest_level || 0)
      );
      ranks.push(ordered.indexOf(a.project_id) + 1);
    }
    if (!ranks.length) return null;
    return ranks.reduce((s, r) => s + r, 0) / ranks.length;
  }

  function summarize(idx, label, status, assignments) {
    const metrics = global.DpiMatcher.teamSkillMetrics(idx, assignments);
    const seats = idx.projectIds.reduce(
      (sum, pid) => sum + Number(idx.projects[pid].interns_needed || 0),
      0
    );
    const individual = assignments.reduce((s, a) => s + a.score, 0);
    return {
      label,
      status,
      assignments,
      individual,
      objective: solutionObjective(idx, assignments),
      placed: assignments.length,
      seats,
      coveragePct: metrics.coveragePct,
      overlaps: metrics.overlaps,
      uncovered: metrics.total - metrics.covered,
      avgRank: averageBidRank(idx, assignments),
    };
  }

  function solveIlpOnce(idx, C, options) {
    // Reuse the existing top-1 ILP/heuristic search from DpiMatcher.
    const k = Math.max(1, options.topK || 1);
    const timeBudgetMs = options.timeBudgetMs || 8000;
    // solveTopK is internal; runMatch already built idx/C — call via a small
    // public helper if available, otherwise greedy through runMatch internals.
    if (typeof global.DpiMatcher.solveTopK === "function") {
      return global.DpiMatcher.solveTopK(idx, C, k, timeBudgetMs);
    }
    return [];
  }

  function compareSolvers(idx, C, options = {}) {
    const skillPolicy = options.skillPolicy || "all-soft";
    const results = {};

    const ilpSolutions = solveIlpOnce(idx, C, options);
    const ilpBest = ilpSolutions[0] || {
      status: "INFEASIBLE",
      assignments: [],
    };
    results.ilp = summarize(
      idx,
      "ILP",
      ilpBest.status,
      ilpBest.assignments || []
    );

    const hun = solveHungarian(idx, C);
    results.hungarian = summarize(
      idx,
      "Hungarian",
      hun.status,
      hun.assignments
    );

    const gs = solveGaleShapley(idx, C);
    results.gale_shapley = summarize(
      idx,
      "Gale–Shapley",
      gs.status,
      gs.assignments
    );

    const hyb = solveHybrid(idx, C, { skillPolicy });
    results.hybrid = summarize(idx, "Hybrid", hyb.status, hyb.assignments);
    results.hybrid.phases = hyb.phases;

    return results;
  }

  global.DpiAlternateSolvers = {
    solveHungarian,
    solveGaleShapley,
    solveHybrid,
    compareSolvers,
    summarize,
    blockingPairs,
  };
})(typeof self !== "undefined" ? self : window);
