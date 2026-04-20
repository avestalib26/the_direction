/**
 * Shadow simulation baseline: defaults + map Supabase `agent1_shadow_sim_config` rows.
 * Live values come from the DB table; these defaults apply when the row is missing or Supabase is offline.
 */
import { AGENT1_SCAN_INTERVALS } from './agent1ScanIntervals.js'

export const SHADOW_SIM_CONFIG_KEY = 'main'

export function defaultShadowSimLongBase() {
  return {
    scanInterval: '5m',
    scanThresholdPct: 3,
    maxSlPct: 1,
    scanSpikeMetric: 'body',
    scanDirection: 'both',
    scanMinQuoteVolume: 0,
    scanMaxSymbols: 800,
  }
}

export function defaultShadowSimShortBase() {
  return {
    scanThresholdPct: 3,
    maxSlPct: 1,
    scanSpikeMetric: 'body',
    scanDirection: 'down',
    scanMinQuoteVolume: 0,
    scanMaxSymbols: 800,
  }
}

function clampSpikeMetric(v, fallback) {
  const s = String(v ?? fallback).toLowerCase()
  return s === 'wick' ? 'wick' : 'body'
}

function clampScanDirection(v, fallback) {
  const d = String(v ?? fallback).toLowerCase()
  if (d === 'up' || d === 'down' || d === 'both') return d
  return fallback
}

/**
 * @param {object | null} row — PostgREST row (snake_case)
 * @returns {{ long: object, short: object }}
 */
export function shadowSimRowToBases(row) {
  const dL = defaultShadowSimLongBase()
  const dS = defaultShadowSimShortBase()
  if (!row || typeof row !== 'object') return { long: dL, short: dS }

  let scanInterval = String(row.scan_interval ?? dL.scanInterval).trim()
  if (!AGENT1_SCAN_INTERVALS.has(scanInterval)) scanInterval = dL.scanInterval

  const long = {
    scanInterval,
    scanThresholdPct: Number.isFinite(Number(row.scan_threshold_pct))
      ? Number(row.scan_threshold_pct)
      : dL.scanThresholdPct,
    maxSlPct: Number.isFinite(Number(row.max_sl_pct)) ? Number(row.max_sl_pct) : dL.maxSlPct,
    scanSpikeMetric: clampSpikeMetric(row.scan_spike_metric, dL.scanSpikeMetric),
    scanDirection: clampScanDirection(row.scan_direction, dL.scanDirection),
    scanMinQuoteVolume: Math.max(
      0,
      Number.isFinite(Number(row.scan_min_quote_volume))
        ? Number(row.scan_min_quote_volume)
        : dL.scanMinQuoteVolume,
    ),
    scanMaxSymbols: Math.min(
      800,
      Math.max(
        1,
        Number.isFinite(Number(row.scan_max_symbols)) ? Math.floor(Number(row.scan_max_symbols)) : dL.scanMaxSymbols,
      ),
    ),
  }

  const short = {
    scanThresholdPct: Number.isFinite(Number(row.short_threshold_pct))
      ? Number(row.short_threshold_pct)
      : dS.scanThresholdPct,
    maxSlPct: Number.isFinite(Number(row.short_max_sl_pct))
      ? Number(row.short_max_sl_pct)
      : dS.maxSlPct,
    scanSpikeMetric: clampSpikeMetric(row.short_spike_metric, dS.scanSpikeMetric),
    scanDirection: clampScanDirection(row.short_scan_direction, dS.scanDirection),
    scanMinQuoteVolume: Math.max(
      0,
      Number.isFinite(Number(row.short_scan_min_quote_volume))
        ? Number(row.short_scan_min_quote_volume)
        : dS.scanMinQuoteVolume,
    ),
    scanMaxSymbols: Math.min(
      800,
      Math.max(
        1,
        Number.isFinite(Number(row.short_scan_max_symbols))
          ? Math.floor(Number(row.short_scan_max_symbols))
          : dS.scanMaxSymbols,
      ),
    ),
  }

  return { long, short }
}

/**
 * @param {object} long
 * @param {object} short
 */
export function assertValidShadowSimBases(long, short) {
  if (!long?.scanInterval || !AGENT1_SCAN_INTERVALS.has(String(long.scanInterval).trim())) {
    throw new Error(`scanInterval must be one of: ${[...AGENT1_SCAN_INTERVALS].sort().join(', ')}`)
  }
  for (const [label, o] of [
    ['long', long],
    ['short', short],
  ]) {
    if (!Number.isFinite(o.scanThresholdPct) || o.scanThresholdPct <= 0) {
      throw new Error(`${label} scanThresholdPct must be a positive number`)
    }
    if (!Number.isFinite(o.maxSlPct) || o.maxSlPct <= 0) {
      throw new Error(`${label} maxSlPct must be a positive number`)
    }
    if (o.scanSpikeMetric !== 'body' && o.scanSpikeMetric !== 'wick') {
      throw new Error(`${label} scanSpikeMetric must be body or wick`)
    }
    if (o.scanDirection !== 'up' && o.scanDirection !== 'down' && o.scanDirection !== 'both') {
      throw new Error(`${label} scanDirection must be up, down, or both`)
    }
    if (!Number.isFinite(o.scanMinQuoteVolume) || o.scanMinQuoteVolume < 0) {
      throw new Error(`${label} scanMinQuoteVolume must be >= 0`)
    }
    const m = Math.floor(Number(o.scanMaxSymbols))
    if (!Number.isFinite(m) || m < 1 || m > 800) {
      throw new Error(`${label} scanMaxSymbols must be 1–800`)
    }
  }
}

/**
 * Build PostgREST body from merged long/short objects (snake_case columns).
 */
export function shadowSimBasesToDbRow(configKey, long, short) {
  return {
    config_key: configKey,
    updated_at: new Date().toISOString(),
    scan_interval: long.scanInterval,
    scan_threshold_pct: long.scanThresholdPct,
    max_sl_pct: long.maxSlPct,
    scan_spike_metric: long.scanSpikeMetric,
    scan_direction: long.scanDirection,
    scan_min_quote_volume: long.scanMinQuoteVolume,
    scan_max_symbols: Math.floor(long.scanMaxSymbols),
    short_threshold_pct: short.scanThresholdPct,
    short_max_sl_pct: short.maxSlPct,
    short_spike_metric: short.scanSpikeMetric,
    short_scan_direction: short.scanDirection,
    short_scan_min_quote_volume: short.scanMinQuoteVolume,
    short_scan_max_symbols: Math.floor(short.scanMaxSymbols),
  }
}

/**
 * Apply partial PATCH (camelCase keys) onto current long/short.
 * @param {object} body
 * @param {object} longCur
 * @param {object} shortCur
 */
export function mergeShadowSimConfigPatch(body, longCur, shortCur) {
  if (!body || typeof body !== 'object') throw new Error('JSON body required')
  const long = { ...longCur }
  const short = { ...shortCur }

  if (body.scanInterval != null) long.scanInterval = String(body.scanInterval).trim()
  if (body.scanThresholdPct != null) long.scanThresholdPct = Number(body.scanThresholdPct)
  if (body.maxSlPct != null) long.maxSlPct = Number(body.maxSlPct)
  if (body.scanSpikeMetric != null) long.scanSpikeMetric = String(body.scanSpikeMetric).toLowerCase()
  if (body.scanDirection != null) long.scanDirection = String(body.scanDirection).toLowerCase()
  if (body.scanMinQuoteVolume != null) long.scanMinQuoteVolume = Number(body.scanMinQuoteVolume)
  if (body.scanMaxSymbols != null) long.scanMaxSymbols = Math.floor(Number(body.scanMaxSymbols))

  if (body.shortThresholdPct != null) short.scanThresholdPct = Number(body.shortThresholdPct)
  if (body.shortMaxSlPct != null) short.maxSlPct = Number(body.shortMaxSlPct)
  if (body.shortSpikeMetric != null) short.scanSpikeMetric = String(body.shortSpikeMetric).toLowerCase()
  if (body.shortScanDirection != null) short.scanDirection = String(body.shortScanDirection).toLowerCase()
  if (body.shortScanMinQuoteVolume != null) short.scanMinQuoteVolume = Number(body.shortScanMinQuoteVolume)
  if (body.shortScanMaxSymbols != null) short.scanMaxSymbols = Math.floor(Number(body.shortScanMaxSymbols))

  return { long, short }
}
