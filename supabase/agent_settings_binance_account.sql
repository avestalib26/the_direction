-- Optional: which env-backed key pair an agent uses (server resolves via binanceCredentials.js).
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
