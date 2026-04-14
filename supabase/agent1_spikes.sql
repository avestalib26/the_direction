-- Run in Supabase SQL editor after agent_settings exists.
-- Spike storage for Agent 1 scheduled 5m scans + UI history.
-- Adds scan_* columns to agent_settings if missing (safe to re-run).

create table if not exists public.agent1_spikes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  candle_open_time_ms bigint not null,
  symbol text not null,
  direction text not null check (direction in ('up', 'down')),
  spike_pct numeric not null,
  quote_volume_24h numeric,
  scan_run_at timestamptz not null,
  trade_taken boolean not null default false,
  unique (candle_open_time_ms, symbol, direction)
);

create index if not exists idx_agent1_spikes_created_at_desc on public.agent1_spikes (created_at desc);

comment on table public.agent1_spikes is 'Agent 1: 5m universe spike hits (from scheduled scan).';

-- Scan tuning on Agent 1 settings row (merged with execution settings).
alter table public.agent_settings
  add column if not exists scan_seconds_before_close integer not null default 20;

alter table public.agent_settings
  add column if not exists scan_threshold_pct numeric not null default 3;

alter table public.agent_settings
  add column if not exists scan_min_quote_volume numeric not null default 0;

alter table public.agent_settings
  add column if not exists scan_max_symbols integer not null default 800;

alter table public.agent_settings
  add column if not exists scan_spike_metric text not null default 'body';

alter table public.agent_settings
  add column if not exists scan_direction text not null default 'both';

alter table public.agent_settings
  add column if not exists agent_enabled boolean not null default true;

alter table public.agent_settings
  add column if not exists scan_interval text not null default '5m';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_scan_spike_metric_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_scan_spike_metric_chk
      check (scan_spike_metric in ('body', 'wick'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_scan_direction_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_scan_direction_chk
      check (scan_direction in ('up', 'down', 'both'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_scan_interval_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_scan_interval_chk
      check (
        scan_interval in ('1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d')
      );
  end if;
end $$;
