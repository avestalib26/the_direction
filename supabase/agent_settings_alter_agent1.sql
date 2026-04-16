-- Minimal migration: extend public.agent_settings for Agent 1 scan + master toggle.
-- Safe to run more than once (IF NOT EXISTS / constraint guards).

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
  add column if not exists ema_gate_enabled boolean not null default true;

alter table public.agent_settings
  add column if not exists max_open_positions integer not null default 30;

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
    select 1 from pg_constraint where conname = 'agent_settings_max_open_positions_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_max_open_positions_chk
      check (max_open_positions between 1 and 300);
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
