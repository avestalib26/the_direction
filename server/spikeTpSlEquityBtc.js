/**
 * Map Binance kline openTime (ms) → candle close for BTCUSDT overlay on equity curve.
 */
export function candlesToBtcCloseMap(candles) {
  const m = new Map()
  if (!Array.isArray(candles)) return m
  for (const c of candles) {
    if (c && Number.isFinite(c.openTime) && Number.isFinite(c.close)) {
      m.set(c.openTime, c.close)
    }
  }
  return m
}

/**
 * Mutates equity curve points: adds btcCloseUsd where entryOpenTime matches a BTC bar open.
 */
export function attachBtcCloseToEquityPoints(points, btcByOpenTime) {
  if (!Array.isArray(points) || !btcByOpenTime || btcByOpenTime.size === 0) {
    return points
  }
  let firstBtc = null
  for (const p of points) {
    if (p.entryOpenTime != null && btcByOpenTime.has(p.entryOpenTime)) {
      firstBtc = btcByOpenTime.get(p.entryOpenTime)
      break
    }
  }
  for (const p of points) {
    if (p.entryOpenTime != null && btcByOpenTime.has(p.entryOpenTime)) {
      p.btcCloseUsd = btcByOpenTime.get(p.entryOpenTime)
    } else if (p.tradeIndex === 0 && firstBtc != null) {
      p.btcCloseUsd = firstBtc
    }
  }
  return points
}
