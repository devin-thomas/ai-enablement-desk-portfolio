create table if not exists decisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references ai_requests(id) on delete cascade,
  reviewer_name text not null,
  decision text not null,
  rationale text not null,
  created_at timestamptz not null default now()
);
