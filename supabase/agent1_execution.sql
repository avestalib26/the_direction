-- Agent 1 execution persistence
-- Run in Supabase SQL editor. Safe to re-run.

create table if not exists public.agent1_trades (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  spike_id uuid references public.agent1_spikes (id) on delete set null,
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

alter table public.agent1_trades
  add column if not exists realized_pnl_usdt numeric;

alter table public.agent1_trades
  add column if not exists commission_usdt numeric;

alter table public.agent1_trades
  add column if not exists funding_fee_usdt numeric;

create unique index if not exists idx_agent1_trades_spike_unique
  on public.agent1_trades (spike_id)
  where spike_id is not null;

create index if not exists idx_agent1_trades_status_opened_desc
  on public.agent1_trades (status, opened_at desc);

drop trigger if exists trg_agent1_trades_updated_at on public.agent1_trades;
create trigger trg_agent1_trades_updated_at
before update on public.agent1_trades
for each row
execute function public.set_updated_at();

create table if not exists public.agent1_execution_logs (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  logged_at timestamptz not null default now(),
  level text not null check (level in ('info', 'warn', 'error')),
  message text not null
);

create index if not exists idx_agent1_execution_logs_logged_at_desc
  on public.agent1_execution_logs (logged_at desc);
