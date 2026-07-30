alter table ai_requests add column if not exists version integer not null default 1 check (version > 0);

alter table decisions add column if not exists analysis_run_id uuid references analysis_runs(id);
alter table decisions add column if not exists previous_status text;
alter table decisions add column if not exists next_status text;
alter table decisions add column if not exists resulting_version integer;

create index if not exists decisions_request_id_idx on decisions (request_id, created_at);
