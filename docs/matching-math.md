# Matching Math Reference

Short formula sheet for the compatibility engine and ILP.

---

## Compatibility score

For student \(s\) and project \(p\):

\[
C_{sp} = H_{sp} \cdot \Big( \sum_i w_i \cdot f_i(s,p) + B_{sp} \Big)
\]

| Symbol | Domain | Meaning |
|--------|--------|---------|
| \(C_{sp}\) | \(\geq 0\) | Compatibility used as ILP objective coefficient |
| \(H_{sp}\) | \(\{0,1\}\) | Hard gate (GPA, meetings, required skills, …) |
| \(w_i\) | \([0,1]\), \(\sum_i w_i = 1\) | Normalized admin slider weights |
| \(f_i(s,p)\) | \([0,1]\) | Soft feature \(i\) for the pair |
| \(B_{sp}\) | \(\geq 0\) | Any-Project-Fits bonus (0 if ranked or flag off) |

### Weight normalization

Given raw sliders \(s_i \in [0, 10]\):

\[
w_i = \frac{s_i}{\sum_j s_j}
\quad\text{(if }\sum_j s_j > 0\text{; else equal weights)}
\]

### Any-Project-Fits bonus (planned default)

Let \(\bar{f} = \sum_i w_i f_i(s,p)\) be the soft combination before bonus, and \(\beta \in [0.05, 0.15]\) a flat percentage:

\[
B_{sp} =
\begin{cases}
\beta \cdot \bar{f} & \text{if any\_project\_fits and } p \text{ unranked by } s \\
0 & \text{otherwise}
\end{cases}
\]

---

## Soft feature sketches

| Feature | Sketch mapping to \([0,1]\) |
|---------|------------------------------|
| Project preference | Rank 1 → 1.0, rank 2 → 0.8, …; unranked → 0 |
| Relevant skills | Coverage / Jaccard of project skills vs student skills |
| Topic / major fit | Overlap of tags / majors |
| Shared availability | Fraction of mandatory meeting slots covered |

Exact mappings live in `backend/app/matching/features.py` once implemented.

---

## ILP formulation

**Variables:** \(x_{sp} \in \{0,1\}\)

**Objective:**

\[
\max \sum_{s,p} C_{sp}\, x_{sp}
\]

**Core constraints:**

- At most one project per student: \(\sum_p x_{sp} \leq 1\) (or \(= 1\) if full placement required)
- Exact headcount per project: \(\sum_s x_{sp} = h_p\)
- Infeasible pairs: \(C_{sp} = 0 \Rightarrow x_{sp} = 0\)
- Avoidances: co-assignment forbidden for listed pairs on the same project
- Locks: \(x_{sp} = 1\) for admin-pinned assignments

Solver: Google OR-Tools CBC (`pywraplp`).
