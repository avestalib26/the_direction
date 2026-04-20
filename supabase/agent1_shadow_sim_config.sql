-- Isolated shadow simulation configuration (not agent_settings).
-- Run in Supabase SQL editor after agent1_shadow_live.sql (or any time).

create table if not exists public.agent1_shadow_sim_config (
  config_key text primary key default 'main',
  updated_at timestamptz not null default now(),
  -- Long leg (Agent-1-style spikes)
  scan_interval text not null default '5m',
  scan_threshold_pct double precision not null default 3,
  max_sl_pct double precision not null default 1,
  scan_spike_metric text not null default 'body',
  scan_direction text not null default 'both',
  scan_min_quote_volume double precision not null default 0,
  scan_max_symbols int not null default 800,
  -- Short leg (Agent-3-style spikes; same klines as long)
  short_threshold_pct double precision not null default 3,
  short_max_sl_pct double precision not null default 1,
  short_spike_metric text not null default 'body',
  short_scan_direction text not null default 'down',
  short_scan_min_quote_volume double precision not null default 0,
  short_scan_max_symbols int not null default 800
);

comment on table public.agent1_shadow_sim_config is
  'Shadow replay scan/universe/spike parameters; API reads/writes; no live agent_settings linkage.';

insert into public.agent1_shadow_sim_config (config_key)
values ('main')
on conflict (config_key) do nothing;
