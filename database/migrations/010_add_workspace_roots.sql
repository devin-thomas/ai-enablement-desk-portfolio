create table if not exists workspaces (
  id uuid primary key,
  created_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  is_quarantine boolean not null default false
);

insert into workspaces (id, is_quarantine)
values ('00000000-0000-4000-8000-000000000001', true)
on conflict (id) do update set is_quarantine = true;

insert into workspaces (id)
select distinct workspace_id
from ai_requests
where workspace_id <> '00000000-0000-4000-8000-000000000001'
on conflict (id) do nothing;

alter table ai_requests
  add constraint ai_requests_workspace_id_fkey
  foreign key (workspace_id) references workspaces(id) on delete cascade;

create index if not exists workspaces_expiry_idx
  on workspaces (last_activity_at, id)
  where not is_quarantine;

create table if not exists workspace_activity_leases (
  id uuid primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  expires_at timestamptz not null
);

create index if not exists workspace_activity_leases_expiry_idx
  on workspace_activity_leases (workspace_id, expires_at);
