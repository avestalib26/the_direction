-- Optional: % of USDT-M futures wallet for margin per trade (Agent 1 / Agent 3 execution).
-- 0 = use fixed trade_size_usd only. Safe to run more than once.

alter table public.agent_settings
  add column if not exists trade_size_wallet_pct numeric not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_trade_size_wallet_pct_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_trade_size_wallet_pct_chk
      check (trade_size_wallet_pct >= 0 and trade_size_wallet_pct <= 100);
  end if;
end $$;
