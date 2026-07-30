create table if not exists artifacts (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  artifact_type text not null,
  storage_url text,
  provider text,
  status text not null,
  created_at timestamptz not null default now()
);
