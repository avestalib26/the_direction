/**
 * Agent 1 scheduled scan: kline intervals with fixed UTC-aligned duration (ms).
 * Excludes 3d / 1w / 1M — their open times are not simple epoch multiples.
 */

export const AGENT1_SCAN_INTERVALS = new Set([
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '8h',
  '12h',
  '1d',
])

export const AGENT1_INTERVAL_MS = Object.freeze({
  '1m': 60_000,
  '3m': 180_000,
  '5m': 300_000,
  '15m': 900_000,
  '30m': 1_800_000,
  '1h': 3_600_000,
  '2h': 7_200_000,
  '4h': 14_400_000,
  '6h': 21_600_000,
  '8h': 28_800_000,
  '12h': 43_200_000,
  '1d': 86_400_000,
})

export function agent1IntervalMs(interval) {
  const k = typeof interval === 'string' ? interval.trim() : ''
  return AGENT1_INTERVAL_MS[k] ?? AGENT1_INTERVAL_MS['5m']
}

/** Binance includes the current open candle as the last row when limit ≥ 1. */
export function clampScanSecondsBeforeClose(rawSeconds, intervalMs) {
  const cap = Math.max(1, Math.min(299, Math.floor(intervalMs / 1000) - 1))
  const s = Number.parseInt(String(rawSeconds ?? ''), 10)
  if (!Number.isFinite(s)) return Math.min(20, cap)
  return Math.min(Math.max(Math.floor(s), 1), cap)
}

/**
 * Next fire: start of current kline + interval − offset (aligned to Binance-style open times).
 */
export function msUntilNextAgent1Scan(nowMs, secondsBeforeClose, intervalMs) {
  const sec = Number(secondsBeforeClose)
  const clampedSec = Number.isFinite(sec)
    ? Math.min(Math.max(Math.floor(sec), 1), Math.min(299, Math.floor(intervalMs / 1000) - 1))
    : 20
  const offsetMs = clampedSec * 1000
  const open = Math.floor(nowMs / intervalMs) * intervalMs
  const fireAt = open + intervalMs - offsetMs
  if (nowMs < fireAt) {
    return { delayMs: fireAt - nowMs, nextFireAt: fireAt }
  }
  const nextOpen = open + intervalMs
  const nextFire = nextOpen + intervalMs - offsetMs
  return { delayMs: nextFire - nowMs, nextFireAt: nextFire }
}

/**
 * Clamp delay (seconds) after each bar boundary before running a scan.
 * Bar "closes" when the next bar opens (Binance openTime advances by intervalMs).
 */
export function clampScanSecondsAfterClose(rawSeconds, intervalMs) {
  const intervalSec = Math.floor(intervalMs / 1000)
  const cap = Math.max(0, Math.min(120, Math.max(0, intervalSec - 1)))
  const s = Number.parseInt(String(rawSeconds ?? ''), 10)
  if (!Number.isFinite(s)) return Math.min(5, cap)
  return Math.min(Math.max(Math.floor(s), 0), cap)
}

/**
 * Next fire: current bar open (UTC-aligned) + delay — i.e. `secondsAfterClose` after the previous bar finished.
 * Ensures the scan runs only after the completed candle exists, not while the prior bar is still forming.
 */
export function msUntilNextScanAfterBarClose(nowMs, secondsAfterClose, intervalMs) {
  const delayMs = clampScanSecondsAfterClose(secondsAfterClose, intervalMs) * 1000
  const currentOpen = Math.floor(nowMs / intervalMs) * intervalMs
  const fireThis = currentOpen + delayMs
  if (nowMs <= fireThis) {
    return { delayMs: Math.max(0, fireThis - nowMs), nextFireAt: fireThis }
  }
  const nextOpen = currentOpen + intervalMs
  const fireNext = nextOpen + delayMs
  return { delayMs: fireNext - nowMs, nextFireAt: fireNext }
}
