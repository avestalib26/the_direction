-- Agent 3: red / down spikes → short (2R-style via settings max_tp / max_sl), separate subaccount-ready queue.
-- Run after agent_settings + set_updated_at exist. Re-run safe.

alter table public.agent_settings
  add column if not exists binance_account text not null default 'master';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_binance_account_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_binance_account_chk
      check (binance_account in ('master', 'sub1', 'sub2'));
  end if;
end $$;

create table if not exists public.agent3_spikes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  candle_open_time_ms bigint not null,
  symbol text not null,
  direction text not null check (direction in ('up', 'down')),
  spike_pct numeric not null,
  spike_low numeric,
  spike_high numeric,
  quote_volume_24h numeric,
  scan_run_at timestamptz not null,
  trade_taken boolean not null default false,
  execution_skipped boolean not null default false,
  skip_reason text,
  unique (candle_open_time_ms, symbol, direction)
);

create index if not exists idx_agent3_spikes_created_at_desc on public.agent3_spikes (created_at desc);

comment on table public.agent3_spikes is 'Agent 3: down-spike hits (scheduled scan); execution shorts on SELL.';

create table if not exists public.agent3_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  spike_id uuid references public.agent3_spikes (id) on delete set null,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  position_side text not null check (position_side in ('LONG', 'SHORT', 'BOTH')),
  status text not null default 'open' check (status in ('open', 'closed')),
  requested_leverage integer,
  applied_leverage integer,
  trade_size_usd numeric,
  quantity numeric,
  entry_order_id bigint,
  tp_algo_id text,
  sl_algo_id text,
  entry_price numeric,
  warnings text,
  close_reason text,
  realized_pnl_usdt numeric,
  commission_usdt numeric,
  funding_fee_usdt numeric
);

create unique index if not exists idx_agent3_trades_spike_unique
  on public.agent3_trades (spike_id)
  where spike_id is not null;

create index if not exists idx_agent3_trades_status_opened_desc
  on public.agent3_trades (status, opened_at desc);

drop trigger if exists trg_agent3_trades_updated_at on public.agent3_trades;
create trigger trg_agent3_trades_updated_at
before update on public.agent3_trades
for each row
execute function public.set_updated_at();

create table if not exists public.agent3_execution_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  logged_at timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null
);

create index if not exists idx_agent3_execution_logs_logged_at_desc
  on public.agent3_execution_logs (logged_at desc);

insert into public.agent_settings (
  agent_name,
  trade_size_usd,
  leverage,
  margin_mode,
  max_tp_pct,
  max_sl_pct,
  max_open_positions,
  scan_seconds_before_close,
  scan_threshold_pct,
  scan_min_quote_volume,
  scan_max_symbols,
  scan_spike_metric,
  scan_direction,
  scan_interval,
  agent_enabled,
  ema_gate_enabled,
  binance_account
)
values (
  'agent3',
  1,
  10,
  'cross',
  2,
  1,
  30,
  20,
  3,
  0,
  800,
  'body',
  'down',
  '5m',
  false,
  false,
  'master'
)
on conflict (agent_name) do nothing;

alter table public.agent3_spikes
  add column if not exists spike_high numeric;
