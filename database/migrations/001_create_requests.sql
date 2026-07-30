create table if not exists ai_requests (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  raw_request jsonb not null,
  request_type text not null,
  department text not null,
  requester_name text not null,
  requester_role text not null,
  business_problem text not null,
  desired_outcome text not null,
  current_process text,
  intended_users jsonb not null default '[]'::jsonb,
  data_sources jsonb not null default '[]'::jsonb,
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  status text not null default 'submitted',
  constraint ai_requests_request_type_check check (request_type in ('ai_project', 'tool_access', 'support', 'training', 'unknown'))
);

create index if not exists ai_requests_submitted_at_idx on ai_requests (submitted_at desc);
