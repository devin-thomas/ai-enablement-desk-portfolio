create table if not exists analysis_runs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  provider text not null,
  model text not null,
  schema_version text not null,
  summary text not null,
  readiness_score integer not null check (readiness_score between 0 and 100),
  estimated_value text not null,
  risk_level text not null,
  recommended_disposition text not null,
  missing_information jsonb not null default '[]'::jsonb,
  risk_flags jsonb not null default '[]'::jsonb,
  raw_structured_output jsonb not null,
  created_at timestamptz not null default now()
);
