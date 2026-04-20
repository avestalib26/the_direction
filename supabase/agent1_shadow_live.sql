-- Agent 1 shadow simulation persistence + single-writer lease.
-- Run once in Supabase SQL editor.

create table if not exists public.agent_runtime_locks (
  lock_name text primary key,
  owner_id text not null,
  lease_until timestamptz not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_agent_runtime_locks_lease_until
  on public.agent_runtime_locks (lease_until);

comment on table public.agent_runtime_locks is
  'Distributed lease table so only one app instance writes live shadow snapshots.';

create table if not exists public.agent1_shadow_snapshot (
  snapshot_key text primary key,
  payload jsonb not null,
  writer_id text,
  updated_at timestamptz not null default now()
);

comment on table public.agent1_shadow_snapshot is
  'Latest precomputed Agent1 shadow payload for API/UI read-through across restarts.';

insert into public.agent1_shadow_snapshot (snapshot_key, payload, writer_id)
values ('main', '{}'::jsonb, 'bootstrap')
on conflict (snapshot_key) do nothing;

-- Shadow sim scan/universe/spike config (separate migration): supabase/agent1_shadow_sim_config.sql
