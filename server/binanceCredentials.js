/**
 * Resolve Binance Futures API credentials by account profile (env-backed).
 * Master falls back to legacy BINANCE_API_KEY / BINANCE_API_SECRET when master-specific vars are unset.
 */

const PROFILES = ['master', 'sub1', 'sub2']

export function normalizeBinanceAccountId(raw) {
  const v = String(raw ?? 'master')
    .trim()
    .toLowerCase()
  if (v === 'sub_1') return 'sub1'
  if (v === 'sub_2') return 'sub2'
  if (PROFILES.includes(v)) return v
  return null
}

export function resolveBinanceCredentials(accountIdRaw) {
  const id = normalizeBinanceAccountId(accountIdRaw) ?? 'master'
  let apiKey
  let apiSecret
  if (id === 'master') {
    apiKey =
      String(process.env.BINANCE_MASTER_API_KEY ?? process.env.BINANCE_API_KEY ?? '').trim() || null
    apiSecret =
      String(process.env.BINANCE_MASTER_API_SECRET ?? process.env.BINANCE_API_SECRET ?? '').trim() ||
      null
  } else if (id === 'sub1') {
    apiKey = String(process.env.BINANCE_SUB1_API_KEY ?? '').trim() || null
    apiSecret = String(process.env.BINANCE_SUB1_API_SECRET ?? '').trim() || null
  } else {
    apiKey = String(process.env.BINANCE_SUB2_API_KEY ?? '').trim() || null
    apiSecret = String(process.env.BINANCE_SUB2_API_SECRET ?? '').trim() || null
  }
  return { accountId: id, apiKey, apiSecret }
}
