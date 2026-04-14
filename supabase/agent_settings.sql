-- Run this in Supabase SQL editor once.
-- Stores settings for Agent 1 (single row keyed by agent_name).
-- If this table already existed without scan_* columns, run supabase/agent1_spikes.sql
-- (it uses ALTER ... ADD COLUMN IF NOT EXISTS).

create table if not exists public.agent_settings (
  id uuid primary key default gen_random_uuid(),
  agent_name text not null unique,
  trade_size_usd numeric not null,
  leverage integer not null,
  margin_mode text not null check (margin_mode in ('cross', 'isolated')),
  max_tp_pct numeric not null,
  max_sl_pct numeric not null,
  updated_at timestamptz not null default now(),
  -- 5m pre-close spike scan (Agent 1 scheduler reads these from the agent1 row)
  scan_seconds_before_close integer not null default 20,
  scan_threshold_pct numeric not null default 3,
  scan_min_quote_volume numeric not null default 0,
  scan_max_symbols integer not null default 800,
  scan_spike_metric text not null default 'body',
  scan_direction text not null default 'both',
  scan_interval text not null default '5m',
  agent_enabled boolean not null default true,
  constraint agent_settings_scan_spike_metric_chk check (scan_spike_metric in ('body', 'wick')),
  constraint agent_settings_scan_direction_chk check (scan_direction in ('up', 'down', 'both')),
  constraint agent_settings_scan_interval_chk check (
    scan_interval in ('1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d')
  )
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_agent_settings_updated_at on public.agent_settings;
create trigger trg_agent_settings_updated_at
before update on public.agent_settings
for each row
execute function public.set_updated_at();

-- Optional seed row
insert into public.agent_settings (
  agent_name, trade_size_usd, leverage, margin_mode, max_tp_pct, max_sl_pct
)
values ('agent1', 1, 10, 'cross', 1.5, 1.0)
on conflict (agent_name) do nothing;
