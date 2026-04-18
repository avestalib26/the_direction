-- Per-agent minimum available-balance % of wallet before blocking new entries (Agent 1 / 3 execution).
-- NULL = use server env FUTURES_MIN_AVAILABLE_WALLET_PCT (default 30). 0 = disable check.

alter table public.agent_settings
  add column if not exists min_available_wallet_pct integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'agent_settings_min_available_wallet_pct_chk'
  ) then
    alter table public.agent_settings
      add constraint agent_settings_min_available_wallet_pct_chk
      check (min_available_wallet_pct is null or (min_available_wallet_pct >= 0 and min_available_wallet_pct <= 100));
  end if;
end $$;
