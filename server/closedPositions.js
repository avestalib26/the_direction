/**
 * Closed USDT-M position PnL: aggregate userTrades where realizedPnl != 0
 * by (symbol, orderId, positionSide) — one row per closing order / position reduction.
 * Symbols to scan come from paginated REALIZED_PNL income (not all 500+ perpetuals).
 */

const IS_VERCEL = process.env.VERCEL === '1'
/** Tighter on Vercel so /closed-positions finishes before the ~10s Hobby timeout. */
const INCOME_PAGES_MAX = IS_VERCEL ? 4 : 10
const USER_TRADES_LIMIT = 1000
const TRADES_CONCURRENCY = IS_VERCEL ? 3 : 7

function closedSymbolsCap() {
  if (!IS_VERCEL) return 0
  const raw = process.env.CLOSED_MAX_SYMBOLS
  if (raw === '0' || raw === '') return 0
  const n = Number.parseInt(String(raw ?? ''), 10)
  if (Number.isFinite(n) && n > 0) return n
  return 45
}

async function mapPool(items, concurrency, fn) {
  const out = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(concurrency, items.length) || 1
  await Promise.all(Array.from({ length: n }, () => worker()))
  return out
}

async function collectSymbolsFromRealizedIncome(signedJson) {
  const symbols = new Set()
  let endTime
  for (let p = 0; p < INCOME_PAGES_MAX; p++) {
    const params = {
      incomeType: 'REALIZED_PNL',
      limit: 1000,
    }
    if (endTime != null) params.endTime = endTime
    const batch = await signedJson('/fapi/v1/income', params)
    if (!Array.isArray(batch) || batch.length === 0) break
    for (const r of batch) {
      if (r.symbol && typeof r.symbol === 'string') symbols.add(r.symbol)
    }
    const minT = Math.min(...batch.map((r) => r.time))
    endTime = minT - 1
    if (batch.length < 1000) break
  }
  return [...symbols].sort()
}

/**
 * @param {(path: string, params: Record<string, string | number>) => Promise<unknown>} signedJson
 */
export async function computeClosedPositionPnl(signedJson, { limit = 1000 } = {}) {
  let symbols = await collectSymbolsFromRealizedIncome(signedJson)
  const incomeSymbolCount = symbols.length
  const symCap = closedSymbolsCap()
  let closedTruncated = false
  if (symCap > 0 && symbols.length > symCap) {
    symbols = symbols.slice(0, symCap)
    closedTruncated = true
  }

  if (symbols.length === 0) {
    return {
      closes: [],
      symbolsScanned: 0,
      incomePagesUsed: true,
      note: 'No REALIZED_PNL income in the paginated window — nothing to map to symbols.',
    }
  }

  const perSymbol = await mapPool(symbols, TRADES_CONCURRENCY, async (symbol) => {
    try {
      const trades = await signedJson('/fapi/v1/userTrades', {
        symbol,
        limit: USER_TRADES_LIMIT,
      })
      return Array.isArray(trades) ? trades : []
    } catch {
      return []
    }
  })

  const groups = new Map()
  for (const trades of perSymbol) {
    for (const t of trades) {
      const pnl = parseFloat(t.realizedPnl)
      if (!Number.isFinite(pnl) || Math.abs(pnl) < 1e-12) continue
      const symbol = t.symbol
      const orderId = t.orderId
      const positionSide = t.positionSide || 'BOTH'
      const key = `${symbol}|${orderId}|${positionSide}`
      let g = groups.get(key)
      if (!g) {
        g = {
          symbol,
          orderId,
          positionSide,
          times: [],
          realizedPnl: 0,
          qty: 0,
          fills: 0,
        }
        groups.set(key, g)
      }
      g.realizedPnl += pnl
      g.times.push(t.time)
      g.qty += parseFloat(t.qty) || 0
      g.fills += 1
    }
  }

  const closes = [...groups.values()].map((g) => ({
    symbol: g.symbol,
    orderId: g.orderId,
    positionSide: g.positionSide,
    closedAt: Math.max(...g.times),
    realizedPnl: Number(g.realizedPnl.toFixed(8)),
    fills: g.fills,
    qty: Number(g.qty.toFixed(8)),
  }))

  closes.sort((a, b) => b.closedAt - a.closedAt)
  const top = closes.slice(0, limit)

  const baseNote =
    'Each row is total realized PnL for one reduce/close order (all fills with that orderId). ' +
    'Only symbols that appear in recent REALIZED_PNL income are scanned; each symbol uses at most ' +
    `${USER_TRADES_LIMIT} latest trades.`

  return {
    closes: top,
    symbolsScanned: symbols.length,
    incomeSymbolCount,
    closedTruncated,
    tradesPerSymbolLimit: USER_TRADES_LIMIT,
    note:
      closedTruncated && IS_VERCEL
        ? `${baseNote} On Vercel, only the first ${symbols.length} of ${incomeSymbolCount} income symbols are scanned (time limit). Set CLOSED_MAX_SYMBOLS or use Pro / self-host for full scans.`
        : baseNote,
  }
}
