-- Agent 2: long green retest at spike low (standalone from Agent 1).
-- Run in Supabase SQL editor once. Safe to re-run (IF NOT EXISTS / IF NOT EXISTS columns).

create table if not exists public.agent2_settings (
  id uuid primary key default gen_random_uuid(),
  updated_at timestamptz not null default now(),
  agent_enabled boolean not null default false,
  signals_scheduler_enabled boolean not null default false,
  trading_enabled boolean not null default false,
  trade_size_usd numeric not null default 10,
  leverage integer not null default 10,
  margin_mode text not null default 'cross' check (margin_mode in ('cross', 'isolated')),
  max_tp_pct numeric not null default 1.5,
  max_sl_pct numeric not null default 1.0,
  tp_r numeric not null default 2,
  long_retest_tp_at_spike_high boolean not null default false,
  scan_threshold_pct numeric not null default 3,
  scan_min_quote_volume numeric not null default 10000000,
  scan_max_symbols integer not null default 80,
  max_open_positions integer not null default 10,
  scan_interval text not null default '5m',
  scan_seconds_before_close integer not null default 20,
  scan_seconds_after_close integer not null default 5,
  working_type text not null default 'MARK_PRICE' check (working_type in ('MARK_PRICE', 'CONTRACT_PRICE')),
  constraint agent2_settings_scan_interval_chk check (
    scan_interval in ('1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d')
  ),
  constraint agent2_settings_leverage_chk check (leverage between 1 and 125),
  constraint agent2_settings_scan_max_symbols_chk check (scan_max_symbols between 1 and 800),
  constraint agent2_settings_max_open_positions_chk check (max_open_positions between 1 and 50)
);

drop trigger if exists trg_agent2_settings_updated_at on public.agent2_settings;
create trigger trg_agent2_settings_updated_at
before update on public.agent2_settings
for each row
execute function public.set_updated_at();

comment on table public.agent2_settings is 'Agent 2 master + scan + trading toggles and risk (defaults: master off).';

-- Post-close scan delay (Agent 2 scheduler). Run on existing DBs that predate this column:
alter table public.agent2_settings
  add column if not exists scan_seconds_after_close integer not null default 5;

alter table public.agent2_settings
  add column if not exists max_open_positions integer not null default 10;

create table if not exists public.agent2_spikes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  candle_open_time_ms bigint not null,
  symbol text not null,
  spike_low numeric not null,
  spike_high numeric not null,
  spike_open numeric,
  spike_close numeric not null,
  base_r numeric not null,
  quote_volume_24h numeric,
  scan_run_at timestamptz not null,
  status text not null default 'recorded',
  skip_reason text,
  replaced_by_spike_id uuid references public.agent2_spikes (id) on delete set null,
  unique (candle_open_time_ms, symbol)
);

create index if not exists idx_agent2_spikes_created_at_desc on public.agent2_spikes (created_at desc);
create index if not exists idx_agent2_spikes_symbol_status on public.agent2_spikes (symbol, status);

comment on table public.agent2_spikes is 'Agent 2: green body spike bars eligible for retest entry.';

create table if not exists public.agent2_entry_orders (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  spike_id uuid not null references public.agent2_spikes (id) on delete cascade,
  symbol text not null,
  binance_order_id bigint,
  client_order_id text,
  stop_price numeric not null,
  status text not null default 'NEW',
  last_exchange_status text
);

create index if not exists idx_agent2_entry_orders_spike on public.agent2_entry_orders (spike_id);
create index if not exists idx_agent2_entry_orders_symbol_status on public.agent2_entry_orders (symbol, status);

drop trigger if exists trg_agent2_entry_orders_updated_at on public.agent2_entry_orders;
create trigger trg_agent2_entry_orders_updated_at
before update on public.agent2_entry_orders
for each row
execute function public.set_updated_at();

create table if not exists public.agent2_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  spike_id uuid references public.agent2_spikes (id) on delete set null,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  position_side text not null check (position_side in ('LONG', 'SHORT', 'BOTH')),
  status text not null default 'open' check (status in ('open', 'closed')),
  theoretical_entry numeric,
  entry_price numeric,
  quantity numeric,
  entry_order_id bigint,
  tp_algo_id text,
  sl_algo_id text,
  bracket_state text not null default 'pending' check (bracket_state in ('pending', 'placed', 'failed')),
  tp_trigger_price numeric,
  sl_trigger_price numeric,
  close_reason text,
  realized_pnl_usdt numeric,
  commission_usdt numeric,
  funding_fee_usdt numeric
);

create unique index if not exists idx_agent2_trades_spike_unique
  on public.agent2_trades (spike_id)
  where spike_id is not null;

create index if not exists idx_agent2_trades_status_opened_desc on public.agent2_trades (status, opened_at desc);

drop trigger if exists trg_agent2_trades_updated_at on public.agent2_trades;
create trigger trg_agent2_trades_updated_at
before update on public.agent2_trades
for each row
execute function public.set_updated_at();

create table if not exists public.agent2_execution_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  logged_at timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null
);

create index if not exists idx_agent2_execution_logs_logged_at_desc on public.agent2_execution_logs (logged_at desc);

-- Seed one settings row if table is empty (master off).
insert into public.agent2_settings (agent_enabled, signals_scheduler_enabled, trading_enabled)
select false, false, false
where not exists (select 1 from public.agent2_settings limit 1);
