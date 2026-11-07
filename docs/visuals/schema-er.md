# Core database relationships

```mermaid
erDiagram
  cohorts ||--o{ students : has
  cohorts ||--o{ projects : has
  cohorts ||--o{ match_runs : has
  students ||--o{ student_skills : has
  students ||--o{ project_rankings : ranks
  students ||--o{ availability_slots : has
  students ||--o{ avoidances : avoids
  projects ||--o{ project_skills : requires
  projects ||--o{ meeting_slots : has
  match_runs ||--o{ match_assignments : produces
  match_assignments }o--|| students : assigns
  match_assignments }o--|| projects : to
```

Full table list: [architecture-plan.md](../architecture-plan.md#postgresql-schema-foundational).
