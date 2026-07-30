alter table analysis_runs alter column summary drop not null;
alter table analysis_runs alter column readiness_score drop not null;
alter table analysis_runs alter column estimated_value drop not null;
alter table analysis_runs alter column risk_level drop not null;
alter table analysis_runs alter column recommended_disposition drop not null;
alter table analysis_runs alter column missing_information drop not null;
alter table analysis_runs alter column risk_flags drop not null;
alter table analysis_runs alter column raw_structured_output drop not null;
alter table analysis_runs add column if not exists prompt_version text not null default '1';
alter table analysis_runs add column if not exists latency_ms integer not null default 0 check (latency_ms >= 0);
alter table analysis_runs add column if not exists outcome text not null default 'success';
alter table analysis_runs add column if not exists sanitized_error_code text;
alter table analysis_runs add column if not exists model_recommendation text;
alter table analysis_runs add column if not exists system_recommendation text;
alter table analysis_runs add column if not exists rule_evaluation jsonb not null default '[]'::jsonb;
alter table analysis_runs add column if not exists facts jsonb not null default '[]'::jsonb;
alter table analysis_runs add column if not exists assumptions jsonb not null default '[]'::jsonb;
alter table analysis_runs add column if not exists unknowns jsonb not null default '[]'::jsonb;
alter table analysis_runs add column if not exists clarification_questions jsonb not null default '[]'::jsonb;

create table if not exists clarification_answers (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  question_id text not null,
  question text not null,
  answer text not null,
  actor_type text not null check (actor_type in ('requester', 'human')),
  actor_name text not null,
  created_at timestamptz not null default now()
);

create index if not exists clarification_answers_request_id_idx on clarification_answers (request_id, created_at);
