/**
 * Simulated account curve from per-trade price % returns (same chronology as quick backtest).
 *
 * **Sequential model:** each row is one closed trade in entry-time order. We book P&L, then the *next* trade may
 * allocate margin from the updated balance — as if margin from the prior trade is released before the next opens.
 * (The engine does not pass overlapping open positions into this client; quick backtest overlap is rare/off by default.)
 *
 * Each trade: margin = max(balance, 0) × (tradeSizePct / 100), notional = margin × leverage,
 * PnL USDT = notional × (priceReturnPct / 100). If balance ≤ 0, margin is 0 → **no new exposure** (cannot take the
 * trade); P&L for that step is 0 and the curve stays flat until a positive balance returns (it won’t, with 0 margin).
 */

export function simulateAccountBalanceFromTradePcts({
  startingBalance,
  tradeSizePct,
  leverage,
  perTradePricePcts,
}) {
  const start = Number(startingBalance)
  const sizePct = Number(tradeSizePct)
  const lev = Number(leverage)
  if (!Number.isFinite(start) || start <= 0) return null
  if (!Number.isFinite(sizePct) || sizePct <= 0 || sizePct > 100) return null
  if (!Number.isFinite(lev) || lev <= 0 || lev > 500) return null
  if (!Array.isArray(perTradePricePcts) || perTradePricePcts.length === 0) return null

  const points = []
  let balance = start
  let tradesSkippedNoFreeMargin = 0
  points.push({ tradeIndex: 0, balance })

  for (let i = 0; i < perTradePricePcts.length; i++) {
    const r = Number(perTradePricePcts[i])
    const ret = Number.isFinite(r) ? r : 0
    const margin = Math.max(balance, 0) * (sizePct / 100)
    let pnlUsd = 0
    if (margin <= 0) {
      tradesSkippedNoFreeMargin += 1
    } else {
      const notional = margin * lev
      pnlUsd = notional * (ret / 100)
      balance += pnlUsd
    }
    points.push({ tradeIndex: i + 1, balance })
  }

  const maxDrawdownUsd = maxDrawdownFromBalancePoints(points.map((p) => p.balance))

  return {
    points,
    startingBalance: start,
    finalBalance: balance,
    maxDrawdownUsd,
    tradesSkippedNoFreeMargin,
  }
}

function maxDrawdownFromBalancePoints(balances) {
  if (!Array.isArray(balances) || balances.length < 2) return null
  let peak = -Infinity
  let maxDd = 0
  for (const v of balances) {
    const x = Number(v)
    if (!Number.isFinite(x)) continue
    if (x > peak) peak = x
    const dd = peak - x
    if (dd > maxDd) maxDd = dd
  }
  return Number.isFinite(maxDd) && maxDd > 0 ? maxDd : null
}
