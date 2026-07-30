create table if not exists audit_events (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  actor_type text not null,
  actor_name text not null,
  event_type text not null,
  description text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
