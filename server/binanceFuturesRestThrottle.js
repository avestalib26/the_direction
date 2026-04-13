/**
 * USDS-M Futures REST REQUEST_WEIGHT throttle (per IP).
 *
 * Docs: exchangeInfo `rateLimits` → REQUEST_WEIGHT **2400 / minute** (standard tier).
 * - Klines weight depends on `limit`: &lt;100→1, &lt;500→2, ≤1000→5, &gt;1000→10
 * - GET /fapi/v1/ticker/24hr with no symbol → **40**
 * - GET /fapi/v1/exchangeInfo → **1**
 *
 * We spend only a fraction of the budget by default so parallel jobs + bursts stay under bans.
 *
 * Env:
 * - BINANCE_FUTURES_WEIGHT_BUDGET_PER_MINUTE — hard cap (weight units / min), optional
 * - BINANCE_FUTURES_WEIGHT_BUDGET_RATIO — fraction of 2400 (default 0.45 →1080/min)
 * - BINANCE_FUTURES_MIN_REQUEST_GAP_MS — extra minimum ms between request starts (default 25)
 */

/** From Exchange Information `rateLimits` REQUEST_WEIGHT (standard). */
export const FUTURES_DOC_REQUEST_WEIGHT_PER_MINUTE = 2400

function budgetPerMinute() {
  const explicit = Number.parseInt(process.env.BINANCE_FUTURES_WEIGHT_BUDGET_PER_MINUTE ?? '', 10)
  if (Number.isFinite(explicit) && explicit >= 60) {
    return Math.min(explicit, FUTURES_DOC_REQUEST_WEIGHT_PER_MINUTE)
  }
  const ratio = Number.parseFloat(process.env.BINANCE_FUTURES_WEIGHT_BUDGET_RATIO ?? '0.45')
  const r = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.45
  return Math.max(120, Math.floor(FUTURES_DOC_REQUEST_WEIGHT_PER_MINUTE * r))
}

function minRequestGapMs() {
  const raw = Number.parseInt(process.env.BINANCE_FUTURES_MIN_REQUEST_GAP_MS ?? '25', 10)
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 5000) : 25
}

const REFILL_INTERVAL_MS = 60_000

let tokens = 0
let lastRefill = Date.now()
let lastRequestStart = 0
let chain = Promise.resolve()

function refillTokens() {
  const cap = budgetPerMinute()
  const now = Date.now()
  const dt = Math.min(Math.max(0, now - lastRefill), REFILL_INTERVAL_MS)
  lastRefill = now
  tokens = Math.min(cap, tokens + (dt * cap) / REFILL_INTERVAL_MS)
}

/** Klines weight from official table (by `limit`). */
export function futuresKlinesRequestWeight(limit) {
  const n = Math.floor(Number(limit))
  if (!Number.isFinite(n) || n < 1) return 2
  if (n < 100) return 1
  if (n < 500) return 2
  if (n <= 1000) return 5
  return 10
}

export const FUTURES_EXCHANGE_INFO_WEIGHT = 1
export const FUTURES_TIME_WEIGHT = 1
export const FUTURES_TICKER_24HR_ALL_WEIGHT = 40
export const FUTURES_INCOME_WEIGHT = 30
export const FUTURES_USER_TRADES_WEIGHT = 5

export function futuresSignedPathWeight(path) {
  const p = String(path ?? '')
  if (p.includes('/fapi/v1/income')) return FUTURES_INCOME_WEIGHT
  if (p.includes('/fapi/v1/userTrades')) return FUTURES_USER_TRADES_WEIGHT
  return 5
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * Wait until `cost` weight units can be spent, then spend them (and optional min gap).
 * Serialized so token math stays correct under concurrent awaits.
 */
export async function acquireFuturesRestWeight(cost) {
  const w = Math.max(1, Math.ceil(Number(cost) || 1))
  const gap = minRequestGapMs()

  const run = async () => {
    while (true) {
      refillTokens()
      if (tokens >= w) {
        tokens -= w
        break
      }
      const cap = budgetPerMinute()
      const need = w - tokens
      const waitMs = Math.ceil((need * REFILL_INTERVAL_MS) / cap)
      await sleep(Math.max(20, Math.min(waitMs, 120_000)))
    }
    if (gap > 0) {
      const now = Date.now()
      const waitGap = lastRequestStart + gap - now
      if (waitGap > 0) await sleep(waitGap)
      lastRequestStart = Date.now()
    }
  }

  const p = chain.then(run, run)
  chain = p.catch(() => {})
  return p
}
