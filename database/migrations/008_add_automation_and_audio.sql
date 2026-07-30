alter table ai_requests add column if not exists synthetic_demo_safe boolean not null default false;

create table if not exists automation_attempts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  automation_name text not null,
  workflow_version text not null,
  correlation_id uuid not null,
  idempotency_key text not null,
  attempt_number integer not null check (attempt_number > 0),
  status text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  external_execution_id text,
  sanitized_error_code text,
  payload jsonb not null default '{}'::jsonb,
  unique (idempotency_key, attempt_number)
);

create index if not exists automation_attempts_request_id_idx on automation_attempts (request_id, started_at);
create index if not exists automation_attempts_idempotency_idx on automation_attempts (idempotency_key, attempt_number desc);

alter table artifacts add column if not exists artifact_data bytea;
alter table artifacts add column if not exists mime_type text;
alter table artifacts add column if not exists byte_length integer;
alter table artifacts add column if not exists external_artifact_id text;
alter table artifacts add column if not exists source_analysis_run_id uuid references analysis_runs(id);
