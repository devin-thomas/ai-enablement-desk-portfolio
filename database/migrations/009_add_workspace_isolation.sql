alter table ai_requests add column if not exists workspace_id uuid;

-- Pre-workspace rows have no owning browser. Quarantine them under a reserved
-- workspace that cannot receive a signed cookie, preserving evidence without
-- exposing it to any anonymous visitor.
update ai_requests
set workspace_id = '00000000-0000-4000-8000-000000000001'
where workspace_id is null;

alter table ai_requests alter column workspace_id set not null;

create index if not exists ai_requests_workspace_submitted_at_idx on ai_requests (workspace_id, submitted_at desc, id desc);
