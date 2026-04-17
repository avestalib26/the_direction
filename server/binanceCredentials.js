/**
 * Resolve Binance Futures API credentials by account profile (env-backed).
 * Master falls back to legacy BINANCE_API_KEY / BINANCE_API_SECRET when master-specific vars are unset.
 */

const PROFILES = ['master', 'sub1', 'sub2']

/** First non-empty trimmed value, else null. Fixes `BINANCE_MASTER_API_KEY=` blocking fallback to `BINANCE_API_KEY`. */
function pickEnv(...names) {
  for (const name of names) {
    const v = String(process.env[name] ?? '').trim()
    if (v) return v
  }
  return null
}

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
    apiKey = pickEnv('BINANCE_MASTER_API_KEY', 'BINANCE_API_KEY')
    apiSecret = pickEnv('BINANCE_MASTER_API_SECRET', 'BINANCE_API_SECRET')
  } else if (id === 'sub1') {
    apiKey = pickEnv('BINANCE_SUB1_API_KEY')
    apiSecret = pickEnv('BINANCE_SUB1_API_SECRET')
  } else {
    apiKey = pickEnv('BINANCE_SUB2_API_KEY')
    apiSecret = pickEnv('BINANCE_SUB2_API_SECRET')
  }
  return { accountId: id, apiKey, apiSecret }
}
