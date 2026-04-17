import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  computeEquityEmaFilterStats,
  computePerTradeSubsampleStats,
  normalizeEquityEmaPair,
} from './equityEmaInteractiveFilter.js'
import {
  SpikeTpSlEquityLightChart,
  SpikeTpSlPerTradeCandleLightChart,
  SpikeTpSlPerTradeLightChart,
} from './spikeTpSlLightweightCharts.jsx'
import { SpikeTpSlSymbolCandleCharts } from './spikeTpSlSymbolCandleCharts.jsx'

const DEFAULT_MIN_VOL = 1_000_000
const DEFAULT_CANDLES = 500
const DEFAULT_THRESHOLD = 3
/** Must match server SPIKE_TPSL_MAX_RANGE_DAYS */
const MAX_HIST_RANGE_DAYS_UTC = 3

function parseUtcDayStart(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd ?? '').trim())
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const t = Date.UTC(y, mo - 1, d)
  if (
    new Date(t).getUTCFullYear() !== y ||
    new Date(t).getUTCMonth() !== mo - 1 ||
    new Date(t).getUTCDate() !== d
  ) {
    return null
  }
  return t
}

/** @returns {string | null} error message */
function validateHistRange(fromDate, toDate) {
  const f = String(fromDate ?? '').trim()
  const t = String(toDate ?? '').trim()
  if (!f && !t) return null
  if (!f || !t) return 'Set both From and To (UTC dates), or leave both empty for latest candles.'
  const fromMs = parseUtcDayStart(f)
  const toDayStart = parseUtcDayStart(t)
  if (fromMs == null || toDayStart == null) {
    return 'From and To must be valid calendar dates as YYYY-MM-DD (interpreted in UTC).'
  }
  if (fromMs > toDayStart + 86400000 - 1) {
    return 'From must be on or before To.'
  }
  const spanDays = (toDayStart + 86400000 - fromMs) / 86400000
  if (spanDays > MAX_HIST_RANGE_DAYS_UTC) {
    return `Historical range cannot exceed ${MAX_HIST_RANGE_DAYS_UTC} UTC days (inclusive).`
  }
  return null
}

const INTERVAL_OPTIONS = [
  { value: '1m', label: '1m' },
  { value: '3m', label: '3m' },
  { value: '5m', label: '5m' },
  { value: '15m', label: '15m' },
  { value: '30m', label: '30m' },
  { value: '1h', label: '1h' },
  { value: '2h', label: '2h' },
  { value: '4h', label: '4h' },
]

function computeEmaSeries(closes, period) {
  const out = closes.map(() => null)
  if (!Array.isArray(closes) || closes.length < period || period < 2) return out
  let sum = 0
  for (let i = 0; i < period; i++) sum += closes[i]
  let ema = sum / period
  out[period - 1] = ema
  const alpha = 2 / (period + 1)
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * alpha + ema * (1 - alpha)
    out[i] = ema
  }
  return out
}

function buildInteractiveEmaCurvePoints(pcts, filterOn, emaFastPeriod, emaSlowPeriod) {
  if (!Array.isArray(pcts) || pcts.length === 0) return null
  const numeric = pcts.map((x) => (Number.isFinite(Number(x)) ? Number(x) : 0))
  const closes = []
  let level = 100
  for (let i = 0; i < numeric.length; i++) {
    level += numeric[i]
    closes.push(level)
  }
  const emaFast = computeEmaSeries(closes, emaFastPeriod)
  const emaSlow = computeEmaSeries(closes, emaSlowPeriod)

  let keptCum = 0
  const points = [{ tradeIndex: 0, pnlPctFromStart: 0, entryOpenTime: null }]
  for (let i = 0; i < numeric.length; i++) {
    let keep = true
    if (filterOn && i > 0) {
      const ef = emaFast[i - 1]
      const es = emaSlow[i - 1]
      keep =
        ef == null ||
        es == null ||
        !Number.isFinite(ef) ||
        !Number.isFinite(es) ||
        ef > es
    }
    if (keep) keptCum += numeric[i]
    points.push({
      tradeIndex: i + 1,
      pnlPctFromStart: keptCum,
      entryOpenTime: null,
    })
  }
  return points.length > 1 ? points : null
}

async function fetchBacktest(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue
    q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/spike-tpsl-backtest?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

function fmtR(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  const d = Math.abs(x) >= 1 ? 3 : 4
  return `${x.toFixed(d)}R`
}

function fmtPx(p) {
  if (p == null || !Number.isFinite(p)) return '—'
  const a = Math.abs(p)
  if (a >= 10_000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (a >= 1) return p.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })
  return p.toLocaleString(undefined, { maximumFractionDigits: 8 })
}

function fmtBodyPct(p) {
  if (p == null || !Number.isFinite(p)) return '—'
  return `${p.toFixed(2)}%`
}

export function SpikeTpSlBacktest() {
  const [minQuoteVolume24h, setMinQuoteVolume24h] = useState(String(DEFAULT_MIN_VOL))
  const [interval, setInterval] = useState('5m')
  const [candleCount, setCandleCount] = useState(String(DEFAULT_CANDLES))
  const [thresholdPct, setThresholdPct] = useState(String(DEFAULT_THRESHOLD))
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [strategy, setStrategy] = useState('long')
  /** Empty = no cap. Otherwise cap adverse stop distance as % of entry (tighter stop only). */
  const [maxSlPct, setMaxSlPct] = useState('')
  /** R and +2R / TP levels unchanged; stop price anchored to spike candle open (when valid vs entry). */
  const [slAtSpikeOpen, setSlAtSpikeOpen] = useState(false)
  /** longGreenRetestLow only: TP = spike candle high; Take-profit (R) field ignored. */
  const [longRetestTpAtSpikeHigh, setLongRetestTpAtSpikeHigh] = useState(false)
  /** Adds OHLC candlesticks (per symbol with trades) — larger API payload. */
  const [includeOhlcCharts, setIncludeOhlcCharts] = useState(true)
  /** Long only: require next open > EMA(96) on 5m at spike bar (server aligns 5m to main window). */
  const [emaLongFilter96_5m, setEmaLongFilter96_5m] = useState(false)
  /** Long (incl. retest): require EMA(96) on 5m rising at spike bar vs prior 5m EMA. */
  const [emaLongSlopePositive96_5m, setEmaLongSlopePositive96_5m] = useState(false)
  /** Short only: require next open < EMA(96) on 5m at spike bar (server aligns 5m to main window). */
  const [emaShortFilter96_5m, setEmaShortFilter96_5m] = useState(false)
  /** Long only: allow another same-symbol spike trade even if a prior one is still open. */
  const [allowOverlap, setAllowOverlap] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  /** Fast / slow EMA periods on stacked equity (chart + filter); defaults 10 / 50. */
  const [equityEmaFastPeriod, setEquityEmaFastPeriod] = useState('10')
  const [equityEmaSlowPeriod, setEquityEmaSlowPeriod] = useState('50')
  /** When true, stats count only trades where fast EMA &gt; slow EMA before entry; when false, all subsample trades. */
  const [equityEmaStatsFilterOn, setEquityEmaStatsFilterOn] = useState(true)
  /** Take-profit multiple vs 1R stop (long / red short); green short uses this for stop width (TP still spike low). */
  const [tpR, setTpR] = useState('2')

  const isLongStrategyFamily = strategy === 'long' || strategy === 'longRedSpikeTpHigh'
  const isLongEmaSlopeStrategy =
    strategy === 'long' || strategy === 'longRedSpikeTpHigh' || strategy === 'longGreenRetestLow'
  const isShortStrategyFamily =
    strategy === 'shortSpikeLow' ||
    strategy === 'shortRedSpike' ||
    strategy === 'shortGreenSpike2R' ||
    strategy === 'shortGreenRetestLow'
  const isFixedTpStrategy =
    strategy === 'longRedSpikeTpHigh' ||
    strategy === 'shortGreenSpike2R' ||
    strategy === 'shortGreenRetestLow' ||
    (strategy === 'longGreenRetestLow' && longRetestTpAtSpikeHigh)

  useEffect(() => {
    if (
      strategy === 'longRedSpikeTpHigh' ||
      strategy === 'shortGreenRetestLow' ||
      strategy === 'longGreenRetestLow'
    ) {
      setSlAtSpikeOpen(false)
    }
  }, [strategy])

  useEffect(() => {
    if (strategy !== 'longGreenRetestLow') setLongRetestTpAtSpikeHigh(false)
  }, [strategy])

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const rangeErr = validateHistRange(fromDate, toDate)
      if (rangeErr) {
        throw new Error(rangeErr)
      }
      const mv = Number.parseFloat(String(minQuoteVolume24h).replace(/,/g, ''))
      const n = Number.parseInt(String(candleCount).replace(/,/g, ''), 10)
      const th = Number.parseFloat(String(thresholdPct))
      const fd = String(fromDate).trim()
      const td = String(toDate).trim()
      const maxSl = Number.parseFloat(String(maxSlPct).trim())
      const tpRVal = Number.parseFloat(String(tpR).replace(/,/g, '').trim())
      const out = await fetchBacktest({
        minQuoteVolume24h: Number.isFinite(mv) && mv >= 0 ? mv : DEFAULT_MIN_VOL,
        interval,
        candleCount: n,
        thresholdPct: th,
        strategy,
        ...(fd && td ? { fromDate: fd, toDate: td } : {}),
        ...(Number.isFinite(maxSl) && maxSl > 0 ? { maxSlPct: maxSl } : {}),
        ...(slAtSpikeOpen ? { slAtSpikeOpen: true } : {}),
        includeChartCandles: includeOhlcCharts,
        ...(emaLongFilter96_5m && isLongStrategyFamily ? { emaLongFilter96_5m: true } : {}),
        ...(emaLongSlopePositive96_5m && isLongEmaSlopeStrategy
          ? { emaLongSlopePositive96_5m: true }
          : {}),
        ...(emaShortFilter96_5m && isShortStrategyFamily ? { emaShortFilter96_5m: true } : {}),
        ...(allowOverlap && isLongStrategyFamily ? { allowOverlap: true } : {}),
        ...(strategy === 'longGreenRetestLow' && longRetestTpAtSpikeHigh
          ? { longRetestTpAtSpikeHigh: true }
          : {}),
        ...(strategy !== 'longRedSpikeTpHigh' &&
        strategy !== 'shortGreenSpike2R' &&
        strategy !== 'shortGreenRetestLow' &&
        !(strategy === 'longGreenRetestLow' && longRetestTpAtSpikeHigh) &&
        Number.isFinite(tpRVal) &&
        tpRVal > 0 &&
        tpRVal <= 100
          ? { tpR: tpRVal }
          : {}),
      })
      setData(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [
    minQuoteVolume24h,
    interval,
    candleCount,
    thresholdPct,
    strategy,
    fromDate,
    toDate,
    maxSlPct,
    slAtSpikeOpen,
    includeOhlcCharts,
    emaLongFilter96_5m,
    emaLongSlopePositive96_5m,
    emaShortFilter96_5m,
    allowOverlap,
    tpR,
    longRetestTpAtSpikeHigh,
    isLongStrategyFamily,
    isLongEmaSlopeStrategy,
    isShortStrategyFamily,
    isFixedTpStrategy,
  ])

  const tpRDisplay = useMemo(() => {
    const v = Number.parseFloat(String(tpR).replace(/,/g, '').trim())
    return Number.isFinite(v) && v > 0 ? v : 2
  }, [tpR])

  const s = data?.summary
  const emaFilterCol = Boolean(data?.emaFilterApplied ?? data?.emaLongFilterApplied)

  const { fast: equityEmaFastNum, slow: equityEmaSlowNum } = useMemo(
    () => normalizeEquityEmaPair(equityEmaFastPeriod, equityEmaSlowPeriod),
    [equityEmaFastPeriod, equityEmaSlowPeriod],
  )

  const equityEmaStats = useMemo(() => {
    const pcts = data?.perTradePricePctChron
    const r = data?.perTradeRChron
    if (!Array.isArray(pcts) || !Array.isArray(r) || pcts.length === 0 || r.length !== pcts.length) {
      return null
    }
    const oc = data?.perTradeOutcomeChron
    const outcomes = Array.isArray(oc) && oc.length === pcts.length ? oc : null
    if (equityEmaStatsFilterOn) {
      return computeEquityEmaFilterStats(pcts, r, outcomes, equityEmaFastNum, equityEmaSlowNum)
    }
    return computePerTradeSubsampleStats(pcts, r, outcomes)
  }, [data, equityEmaFastNum, equityEmaSlowNum, equityEmaStatsFilterOn])
  const equityEmaInteractiveCurvePoints = useMemo(() => {
    const pcts = data?.perTradePricePctChron
    return buildInteractiveEmaCurvePoints(
      pcts,
      equityEmaStatsFilterOn,
      equityEmaFastNum,
      equityEmaSlowNum,
    )
  }, [data, equityEmaStatsFilterOn, equityEmaFastNum, equityEmaSlowNum])
  const tpLbl = data?.tpStatLabel ?? 'TP (2R)'
  const slLbl = data?.slStatLabel ?? 'SL (-1R)'
  const longSide = s?.bySide?.long
  const shortSide = s?.bySide?.short

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Spike TP/SL backtest</h1>
      <p className="vol-screener-lead">
        Filters USDT-M perpetuals by <strong>24h quote volume</strong>, loads <strong>N</strong> candles
        per symbol, finds{' '}
        <strong>{strategy === 'shortRedSpike' || strategy === 'longRedSpikeTpHigh' ? 'red' : 'green'}</strong>{' '}
        candles whose <strong>body</strong> is at least your threshold % vs open.{' '}
        {strategy === 'shortRedSpike' ? (
          <>
            <strong>R = spike high − spike close</strong>. <strong>Short</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry + R</code>, target{' '}
            <code className="inline-code">entry − 2R</code> (same 2:1 R-multiple idea as long, mirrored).{' '}
          </>
        ) : strategy === 'shortGreenSpike2R' ? (
          <>
            <strong>R = spike close − spike low</strong>. <strong>Short</strong> at the <strong>next open</strong>:{' '}
            stop <code className="inline-code">entry + R</code>, target{' '}
            <code className="inline-code">entry − 2R</code> (fixed).{' '}
          </>
        ) : strategy === 'shortGreenRetestLow' ? (
          <>
            <strong>Green spike retest short</strong>: after a green spike, wait for price to <strong>touch that spike
            low</strong>, then short at the touch. SL = <strong>spike close</strong>, TP = <strong>1R</strong> below
            entry. If a newer green spike appears before touch, the older setup is dropped.{' '}
          </>
        ) : strategy === 'longGreenRetestLow' ? (
          longRetestTpAtSpikeHigh ? (
            <>
              <strong>Green spike retest long (TP at spike high)</strong>: after a green spike, wait for price to{' '}
              <strong>touch that spike low</strong>, then long at the touch. <strong>R = spike close − spike low</strong>
              , stop is <code className="inline-code">entry − 1R</code>, take-profit at the{' '}
              <strong>spike candle high</strong>. <strong>Take-profit (R multiples)</strong> is ignored. If a newer
              green spike appears before touch, the older setup is dropped.{' '}
            </>
          ) : (
            <>
              <strong>Green spike retest long</strong>: after a green spike, wait for price to <strong>touch that spike
              low</strong>, then long at the touch. <strong>R = spike close − spike low</strong>, stop is{' '}
              <code className="inline-code">entry − 1R</code>, and target is{' '}
              <code className="inline-code">entry + {tpRDisplay}R</code>. If a newer green spike appears before touch,
              the older setup is dropped.{' '}
            </>
          )
        ) : strategy === 'longRedSpikeTpHigh' ? (
          <>
            <strong>Long</strong> at the <strong>next open</strong> after a <strong>red-body spike</strong>: take-profit
            at the <strong>spike candle high</strong>; stop is{' '}
            <code className="inline-code">entry − 2×(TP − entry)</code> (about <strong>+0.5R vs −1R</strong> when the
            stop is not tightened by max SL %). <strong>tpR</strong> does not apply.{' '}
          </>
        ) : strategy === 'regimeFlipEma50' ? (
          <>
            <strong>Regime flip mode</strong>: uses green spikes only and checks cumulative equity vs{' '}
            <strong>EMA 50</strong>. If cumulative is <strong>above</strong> EMA (or EMA not seeded yet), it
            takes the normal <strong>long</strong> setup (<code className="inline-code">TP +{tpRDisplay}R</code>,{' '}
            <code className="inline-code">SL −1R</code>). If cumulative is <strong>below</strong> EMA, it flips to
            <strong> short</strong> with <strong>TP at spike low</strong> and a fixed <strong>SL +2R</strong>
            (roughly 0.5R profile).{' '}
          </>
        ) : strategy === 'shortSpikeLow' ? (
          <>
            <strong>R = spike close − spike low</strong>. <strong>Short</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry + {tpRDisplay}R</code>,
            take-profit when price trades at the <strong>spike candle low</strong> (skipped if next open is already ≤
            that low).{' '}
          </>
        ) : (
          <>
            <strong>R = spike close − spike low</strong>. <strong>Long</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry − R</code>, target{' '}
            <code className="inline-code">entry + {tpRDisplay}R</code>.{' '}
          </>
        )}
        If both stop and target touch in the same bar, <strong>stop is assumed first</strong>{' '}
        (conservative). EOD uses last close. One position per symbol at a time. The cumulative chart is
        the <strong>running sum</strong> of each trade&apos;s price move: long{' '}
        <code className="inline-code">(exit − entry) / entry</code>, short{' '}
        <code className="inline-code">(entry − exit) / entry</code>, as a percent — not compounded.
      </p>
      <p className="hourly-spikes-hint spike-tpsl-api-hint">
        <strong>Binance:</strong> klines are still <strong>public REST</strong> endpoints (no signature).
        If you set <code className="inline-code">BINANCE_API_KEY</code> in the <strong>server</strong>{' '}
        environment, this backtest sends it as <code className="inline-code">X-MBX-APIKEY</code> on each
        request (same key as signed routes). That does <strong>not</strong> guarantee higher rate limits;
        bans are usually IP / weight based — try lowering symbol count (
        <code className="inline-code">SPIKE_TPSL_MAX_SYMBOLS</code>), concurrency (
        <code className="inline-code">SPIKE_TPSL_CONCURRENCY</code>, default 4 parallel symbols), or add{' '}
        <code className="inline-code">SPIKE_TPSL_PAGE_DELAY_MS</code> for historical paging. Server-wide
        Futures REST throttling uses <code className="inline-code">BINANCE_FUTURES_WEIGHT_BUDGET_RATIO</code>{' '}
        (default 0.45 of Binance&apos;s 2400 weight/min) and{' '}
        <code className="inline-code">BINANCE_FUTURES_MIN_REQUEST_GAP_MS</code> (default 25ms between
        requests).
      </p>

      {(strategy === 'shortSpikeLow' || data?.strategy === 'shortSpikeLow') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Short on green spike (plain):</strong> A big green candle (the spike) just closed. You are
          betting it will <strong>give back some of the move</strong> before going much higher. You{' '}
          <strong>sell (short) at the next candle&apos;s open</strong>. Your <strong>stop</strong> sits{' '}
          <strong>above</strong> that entry: distance = <strong>{tpRDisplay}×R</strong>, with{' '}
          <strong>R = spike close − spike low</strong>. Your <strong>profit target</strong> is the{' '}
          <strong>low of that same spike candle</strong>—if price trades down there, you cover the short.
          If price hits the stop first, you lose <strong>1R</strong> (here, 1R means one full stop width =
          {tpRDisplay}×R in price). Trades where the next open is already at or below the spike low are skipped.
        </p>
      )}

      {(strategy === 'shortRedSpike' || data?.strategy === 'shortRedSpike') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Short on red spike (plain):</strong> A big <strong>red</strong> candle (the spike) just
          closed—the opposite of the long setup. You <strong>sell (short) at the next candle&apos;s open</strong>.
          Risk unit <strong>R = spike high − spike close</strong> (the body &quot;stretch&quot; upward). Stop is{' '}
          <strong>entry + R</strong>; target is <strong>entry − {tpRDisplay}R</strong> ({tpRDisplay}R profit vs 1R
          risk, mirrored from the long rule). Same bar priority: if both levels touch one bar,{' '}
          <strong>stop first</strong> (conservative).
        </p>
      )}

      {(strategy === 'shortGreenSpike2R' || data?.strategy === 'shortGreenSpike2R') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Short on green spike (2R fixed):</strong> After a big <strong>green</strong> spike, you{' '}
          <strong>sell (short) at the next candle&apos;s open</strong>. Risk unit{' '}
          <strong>R = spike close − spike low</strong>. Stop is <strong>entry + R</strong>; target is{' '}
          <strong>entry − 2R</strong>. Same-bar rule is conservative: if stop and target both touch in one bar,
          <strong> stop first</strong>.
        </p>
      )}

      {(strategy === 'shortGreenRetestLow' || data?.strategy === 'shortGreenRetestLow') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Short on spike-low retest (latest setup wins):</strong> A green spike creates a pending setup. You
          wait for price to trade back to that spike&apos;s <strong>low</strong>; on touch, you short. Stop is fixed at
          that spike&apos;s <strong>high</strong>, and TP is <strong>1R</strong> below entry. If another green spike
          forms before touch, the old setup is discarded and replaced by the latest spike.
        </p>
      )}

      {(strategy === 'longGreenRetestLow' || data?.strategy === 'longGreenRetestLow') &&
        (longRetestTpAtSpikeHigh || data?.longRetestTpAtSpikeHigh ? (
          <p className="hourly-spikes-hint spike-tpsl-short-plain">
            <strong>Long on spike-low retest, TP at spike high (latest setup wins):</strong> Same wait-and-touch entry at
            the spike <strong>low</strong>. Stop remains <strong>entry − 1R</strong> (body <strong>R</strong> from the
            spike). Take-profit is the <strong>high of the spike candle</strong>, not the TP R field. If another green
            spike forms before touch, the old setup is discarded and replaced by the latest spike.
          </p>
        ) : (
          <p className="hourly-spikes-hint spike-tpsl-short-plain">
            <strong>Long on spike-low retest (latest setup wins):</strong> A green spike creates a pending setup. You
            wait for price to trade back to that spike&apos;s <strong>low</strong>; on touch, you go long.{' '}
            <strong>R = spike close − spike low</strong>. Stop is <strong>entry − 1R</strong>; target is{' '}
            <strong>entry + {tpRDisplay}R</strong>. If another green spike forms before touch, the old setup is
            discarded and replaced by the latest spike.
          </p>
        ))}

      {(strategy === 'longRedSpikeTpHigh' || data?.strategy === 'longRedSpikeTpHigh') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Long on red spike (TP = spike high):</strong> After a large <strong>red</strong> body vs open, you{' '}
          <strong>buy at the next candle&apos;s open</strong>, targeting a fill back up to the{' '}
          <strong>high of that spike candle</strong>. The stop sits below entry by <strong>twice</strong> the distance
          from entry to that TP (about <strong>0.5R reward vs 1R risk</strong> if max SL % does not tighten the stop).
          Trades where the next open is already at or above the spike high are skipped.
        </p>
      )}

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min 24h volume (USDT)</span>
          <input
            className="vol-screener-input"
            type="text"
            inputMode="numeric"
            value={minQuoteVolume24h}
            onChange={(e) => setMinQuoteVolume24h(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Timeframe</span>
          <select
            className="vol-screener-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">From (UTC)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">To (UTC)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Candles per symbol {!fromDate && !toDate ? '' : '(ignored in range mode)'}</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="numeric"
            value={candleCount}
            onChange={(e) => setCandleCount(e.target.value)}
            disabled={Boolean(fromDate && toDate)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min spike body (% vs open)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            value={thresholdPct}
            onChange={(e) => setThresholdPct(e.target.value)}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Side</span>
          <select
            className="vol-screener-input"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            <option value="long">
              Long — TP +{tpRDisplay}R / SL −1R (green spike, R below)
            </option>
            <option value="shortSpikeLow">
              Short — TP spike low / SL +{tpRDisplay}R (green spike)
            </option>
            <option value="shortRedSpike">
              Short — TP −{tpRDisplay}R / SL +1R (red spike, mirrored)
            </option>
            <option value="shortGreenSpike2R">
              Short — TP −2R / SL +1R (green spike, fixed)
            </option>
            <option value="shortGreenRetestLow">
              Short — wait touch spike low, SL spike close, TP 1R (latest spike wins)
            </option>
            <option value="longGreenRetestLow">
              Long — wait touch spike low, SL −1R, TP +{tpRDisplay}R (latest spike wins)
            </option>
            <option value="longRedSpikeTpHigh">
              Long — TP spike high / SL 2× reward (~0.5R, red spike)
            </option>
            <option value="regimeFlipEma50">
              Regime flip — above EMA50: long, below EMA50: short (TP spike low / fixed SL +2R)
            </option>
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Take-profit (R multiples)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            placeholder="default 2"
            value={tpR}
            onChange={(e) => setTpR(e.target.value)}
            disabled={isFixedTpStrategy}
          />
        </label>
        {strategy === 'regimeFlipEma50' && (
          <p className="hourly-spikes-hint spike-tpsl-range-hint">
            In regime flip mode, <strong>TP R</strong> above applies only to the <strong>long</strong> branch. The{' '}
            <strong>short</strong> branch is fixed to <strong>TP at spike low</strong> and{' '}
            <strong>SL = entry + 2R</strong>.
          </p>
        )}
        {strategy === 'longRedSpikeTpHigh' && (
          <p className="hourly-spikes-hint spike-tpsl-range-hint">
            <strong>TP R</strong> is ignored for this mode (TP is fixed at the spike high).
          </p>
        )}
        {strategy === 'shortGreenSpike2R' && (
          <p className="hourly-spikes-hint spike-tpsl-range-hint">
            <strong>TP R</strong> is ignored for this mode (TP is fixed at <strong>2R</strong> below entry).
          </p>
        )}
        {strategy === 'shortGreenRetestLow' && (
          <p className="hourly-spikes-hint spike-tpsl-range-hint">
            <strong>TP R</strong> is ignored for this mode (TP is fixed at <strong>1R</strong> below entry).
          </p>
        )}
        {strategy === 'longGreenRetestLow' && (
          <label className="vol-screener-field spike-tpsl-sl-open-toggle">
            <input
              type="checkbox"
              checked={longRetestTpAtSpikeHigh}
              onChange={(e) => setLongRetestTpAtSpikeHigh(e.target.checked)}
            />
            <span>
              <strong>TP at spike candle high</strong> — for <strong>long retest</strong> only: take-profit is the{' '}
              <strong>spike&apos;s high</strong> (not <strong>entry + TP R</strong>). The Take-profit (R multiples) field
              is ignored when this is on.
            </span>
          </label>
        )}
        {strategy === 'longGreenRetestLow' && longRetestTpAtSpikeHigh && (
          <p className="hourly-spikes-hint spike-tpsl-range-hint">
            <strong>TP R</strong> is ignored — target is <strong>spike high</strong>. Touches are skipped when spike high
            is not above entry.
          </p>
        )}
        <label className="vol-screener-field">
          <span className="vol-screener-label">Max SL (% of entry, optional)</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 10 — no cap if empty"
            value={maxSlPct}
            onChange={(e) => setMaxSlPct(e.target.value)}
          />
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={slAtSpikeOpen}
            disabled={
              strategy === 'longRedSpikeTpHigh' ||
              strategy === 'shortGreenRetestLow' ||
              strategy === 'longGreenRetestLow'
            }
            onChange={(e) => setSlAtSpikeOpen(e.target.checked)}
          />
          <span>
            <strong>Stop at spike open</strong> — <strong>R</strong> still from the spike body (close−low or red
            mirror); <strong>TP</strong> still uses <strong>{tpRDisplay}× that R</strong> (or spike low for the plain
            short). Only the <strong>stop price</strong> uses the spike candle <strong>open</strong> instead of{' '}
            <code className="inline-code">entry ± R</code> / <code className="inline-code">entry + {tpRDisplay}R</code>{' '}
            (skipped when open is on the wrong side of entry).
          </span>
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={emaLongFilter96_5m}
            disabled={!isLongStrategyFamily}
            onChange={(e) => setEmaLongFilter96_5m(e.target.checked)}
          />
          <span>
            <strong>EMA 96 (5m) long filter</strong> — only take a <strong>long</strong> when the{' '}
            <strong>entry open</strong> is above <strong>EMA(96)</strong> on <strong>5m</strong> at the spike bar
            (5m series is loaded for the same time window as your main interval). Ignored for non-long strategies.
          </span>
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={emaLongSlopePositive96_5m}
            disabled={!isLongEmaSlopeStrategy}
            onChange={(e) => setEmaLongSlopePositive96_5m(e.target.checked)}
          />
          <span>
            <strong>EMA 96 (5m) long slope</strong> — only take a <strong>long</strong> when{' '}
            <strong>EMA(96)</strong> on <strong>5m</strong> is <strong>rising</strong> at the spike bar (current 5m
            EMA &gt; previous 5m EMA). Works with <strong>long</strong>, <strong>long red TP high</strong>, and{' '}
            <strong>long green retest</strong> (retest uses the touch bar open for the level filter above, when that
            filter is on).
          </span>
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={emaShortFilter96_5m}
            disabled={!isShortStrategyFamily}
            onChange={(e) => setEmaShortFilter96_5m(e.target.checked)}
          />
          <span>
            <strong>EMA 96 (5m) short filter</strong> — only take a <strong>short</strong> when the{' '}
            <strong>entry open</strong> is below <strong>EMA(96)</strong> on <strong>5m</strong> at the spike bar
            (5m series is loaded for the same time window as your main interval). Ignored for non-short strategies.
          </span>
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={allowOverlap}
            disabled={!isLongStrategyFamily}
            onChange={(e) => setAllowOverlap(e.target.checked)}
          />
          <span>
            <strong>Allow overlapping longs (same symbol)</strong> — in <strong>long</strong> mode, do not block a new
            spike trade on the same coin while a previous one is still open. Turn off to use the current non-overlap
            behavior.
          </span>
        </label>
        <label className="vol-screener-field spike-tpsl-sl-open-toggle">
          <input
            type="checkbox"
            checked={includeOhlcCharts}
            onChange={(e) => setIncludeOhlcCharts(e.target.checked)}
          />
          <span>
            <strong>OHLC charts</strong> at the bottom (TradingView Lightweight candlesticks) for{' '}
            <strong>symbols with at least one trade or EMA-filter skip</strong> — same bar window as this run;
            slightly heavier response. Turn off for a faster run or very large universes.
          </span>
        </label>
        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Running…' : 'Run backtest'}
          </button>
        </div>
        <p className="hourly-spikes-hint spike-tpsl-range-hint">
          Optional <strong>From / To</strong>: inclusive UTC calendar days; max{' '}
          <strong>{MAX_HIST_RANGE_DAYS_UTC} days</strong> span. Leave both empty to use the latest{' '}
          <strong>N candles</strong> per symbol instead.
        </p>
      </div>

      {error && (
        <p className="vol-screener-warn" role="alert">
          {error}
        </p>
      )}

      {data && !error && (
        <>
          <p className="vol-screener-meta">
            <strong>{data.interval}</strong> ·{' '}
            {data.rangeMode && data.fromDate && data.toDate ? (
              <>
                UTC <strong>{data.fromDate}</strong> → <strong>{data.toDate}</strong> · up to{' '}
                {fmtInt(data.candleCount)} bars (max/symbol) ·{' '}
              </>
            ) : (
              <>
                {fmtInt(data.candleCount)} bars ·{' '}
              </>
            )}
            body ≥ <strong>{data.thresholdPct}%</strong> · min 24h vol {fmtInt(data.minQuoteVolume24h)} USDT ·{' '}
            {fmtInt(data.symbolCount)} symbols
            {data.maxSlPct != null && Number.isFinite(data.maxSlPct) ? (
              <>
                {' '}
                · max SL <strong>{data.maxSlPct}%</strong> of entry
              </>
            ) : null}
            {data.slAtSpikeOpen ? (
              <>
                {' '}
                · <strong>SL at spike open</strong>
              </>
            ) : null}
            {data.emaLongFilter96_5m || data.emaShortFilter96_5m || data.emaLongSlopePositive96_5m ? (
              <>
                {' '}
                ·{' '}
                <strong>EMA 96 5m</strong>
                {data.emaFilterApplied
                  ? (() => {
                      const bits = []
                      if (data.emaLongFilterApplied) bits.push('long level')
                      if (data.emaLongSlopeApplied) bits.push('long slope')
                      if (data.emaShortFilterApplied) bits.push('short level')
                      return bits.length ? ` (${bits.join(', ')})` : ' (off for this strategy)'
                    })()
                  : ' (off for this strategy)'}
              </>
            ) : null}
            {data.tpR != null && Number.isFinite(data.tpR) ? (
              <>
                {' '}
                · TP <strong>{data.tpR}R</strong>
              </>
            ) : null}
            {data.symbolsCapped ? ` (capped ${data.cappedAt})` : ''}
            {data.skipped > 0 ? ` · ${data.skipped} fetch errors` : ''}
            {data.binancePublicApiKeySent ? ' · API key header on' : ''}
            {s?.finalPnlPctFromStart != null && Number.isFinite(s.finalPnlPctFromStart) ? (
              <>
                {' '}
                · cumulative Σ price %{' '}
                <strong className={s.finalPnlPctFromStart >= 0 ? 'pnl-pos' : 'pnl-neg'}>
                  {s.finalPnlPctFromStart >= 0 ? '+' : ''}
                  {s.finalPnlPctFromStart.toFixed(2)}%
                </strong>{' '}
                (reference 100 + Σ = {s.finalEquityPct != null ? s.finalEquityPct.toFixed(2) : '—'})
              </>
            ) : null}
          </p>

          {s && (
            <div className="backtest1-summary-grid spike-tpsl-summary">
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Total trades</span>
                <span className="backtest1-stat-value">{fmtInt(s.totalTrades)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">{tpLbl}</span>
                <span className="backtest1-stat-value pnl-pos">{fmtInt(s.tpHits)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">{slLbl}</span>
                <span className="backtest1-stat-value pnl-neg">{fmtInt(s.slHits)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">EOD (last close)</span>
                <span className="backtest1-stat-value">{fmtInt(s.eodHits)}</span>
              </div>
              {data.emaFilterApplied ? (
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Skipped (EMA 96 5m)</span>
                  <span className="backtest1-stat-value">{fmtInt(s.emaFilterSkips ?? 0)}</span>
                </div>
              ) : null}
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Sum R</span>
                <span
                  className={`backtest1-stat-value ${(s.sumR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                >
                  {s.sumR != null && Number.isFinite(s.sumR) ? `${s.sumR.toFixed(2)}R` : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Avg R / trade</span>
                <span
                  className={`backtest1-stat-value ${(s.avgR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                >
                  {s.avgR != null && Number.isFinite(s.avgR) ? `${s.avgR.toFixed(3)}R` : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">TP / (TP+SL)</span>
                <span className="backtest1-stat-value">
                  {s.winRateTpVsSlPct != null && Number.isFinite(s.winRateTpVsSlPct)
                    ? `${s.winRateTpVsSlPct.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Long trades</span>
                <span className="backtest1-stat-value">{fmtInt(longSide?.totalTrades ?? 0)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Long TP / (TP+SL)</span>
                <span className="backtest1-stat-value">
                  {longSide?.winRateTpVsSlPct != null && Number.isFinite(longSide.winRateTpVsSlPct)
                    ? `${longSide.winRateTpVsSlPct.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Short trades</span>
                <span className="backtest1-stat-value">{fmtInt(shortSide?.totalTrades ?? 0)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Short TP / (TP+SL)</span>
                <span className="backtest1-stat-value">
                  {shortSide?.winRateTpVsSlPct != null && Number.isFinite(shortSide.winRateTpVsSlPct)
                    ? `${shortSide.winRateTpVsSlPct.toFixed(1)}%`
                    : '—'}
                </span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Wins (TP + EOD+)</span>
                <span className="backtest1-stat-value pnl-pos">{fmtInt(s.winningTrades)}</span>
              </div>
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Losses (SL + EOD−)</span>
                <span className="backtest1-stat-value pnl-neg">{fmtInt(s.losingTrades)}</span>
              </div>
              {(s.breakevenTrades ?? 0) > 0 && (
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Breakeven EOD</span>
                  <span className="backtest1-stat-value">{fmtInt(s.breakevenTrades)}</span>
                </div>
              )}
              <div className="backtest1-stat">
                <span className="backtest1-stat-label">Cumulative Σ price %</span>
                <span
                  className={`backtest1-stat-value ${(s.finalPnlPctFromStart ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                >
                  {s.finalPnlPctFromStart != null && Number.isFinite(s.finalPnlPctFromStart)
                    ? `${s.finalPnlPctFromStart >= 0 ? '+' : ''}${s.finalPnlPctFromStart.toFixed(2)}%`
                    : '—'}
                </span>
              </div>
            </div>
          )}

          {s && s.totalTrades > 0 && (
            <section className="hourly-spikes-section spike-tpsl-pertrade-section">
              <h2 className="hourly-spikes-h2">Per-trade price % (bar chart)</h2>
              <p className="hourly-spikes-hint">
                Histogram: <strong>green</strong> = positive price % per trade, <strong>red</strong> = negative.{' '}
                Built with <strong>TradingView Lightweight Charts</strong> (canvas, same family as TradingView).
              </p>
              <SpikeTpSlPerTradeLightChart
                perTradePricePctChron={data.perTradePricePctChron}
                tradesFallback={data.trades}
                totalTradeRows={data.totalTradeRows}
                serverSubsampled={Boolean(data.perTradePricePctSubsampled)}
              />
              <div className="spike-tpsl-pertrade-candle-toolbar">
                <h3 className="hourly-spikes-h3 spike-tpsl-pertrade-candle-h3">Stacked equity candles + EMA</h3>
                <label className="spike-tpsl-pertrade-ema-inline">
                  <span className="spike-tpsl-pertrade-ema-inline-label">Fast EMA</span>
                  <input
                    className="vol-screener-input vol-screener-input--narrow"
                    type="text"
                    inputMode="numeric"
                    aria-label="Stacked equity fast EMA period"
                    placeholder="10"
                    value={equityEmaFastPeriod}
                    onChange={(e) => setEquityEmaFastPeriod(e.target.value)}
                  />
                </label>
                <label className="spike-tpsl-pertrade-ema-inline">
                  <span className="spike-tpsl-pertrade-ema-inline-label">Slow EMA</span>
                  <input
                    className="vol-screener-input vol-screener-input--narrow"
                    type="text"
                    inputMode="numeric"
                    aria-label="Stacked equity slow EMA period"
                    placeholder="50"
                    value={equityEmaSlowPeriod}
                    onChange={(e) => setEquityEmaSlowPeriod(e.target.value)}
                  />
                </label>
              </div>
              <p className="hourly-spikes-hint">
                Same order as the histogram: <strong>100 + cumulative Σ price %</strong> after each trade — bodies
                only (no wicks). Two EMAs on the closes; if fast &gt; slow is wrong way round in the fields, periods
                are auto-swapped. Chart updates live.
              </p>
              <SpikeTpSlPerTradeCandleLightChart
                perTradePricePctChron={data.perTradePricePctChron}
                tradesFallback={data.trades}
                totalTradeRows={data.totalTradeRows}
                serverSubsampled={Boolean(data.perTradePricePctSubsampled)}
                emaFastPeriod={equityEmaFastNum}
                emaSlowPeriod={equityEmaSlowNum}
              />
              <div className="spike-tpsl-equity-ema-panel">
                <h4 className="spike-tpsl-equity-ema-title">Equity EMA filter (interactive)</h4>
                <p className="hourly-spikes-hint spike-tpsl-equity-ema-lead">
                  When the filter is <strong>on</strong>, only trades where <strong>fast EMA &gt; slow EMA</strong> on
                  the prior stacked-equity close are counted (same periods as the chart). When <strong>off</strong>,
                  stats use every trade in the subsample. No re-fetch — subsampled runs are approximate.
                </p>
                <label className="vol-screener-field spike-tpsl-sl-open-toggle spike-tpsl-equity-ema-toggle">
                  <input
                    type="checkbox"
                    checked={equityEmaStatsFilterOn}
                    onChange={(e) => setEquityEmaStatsFilterOn(e.target.checked)}
                  />
                  <span>
                    <strong>Equity EMA crossover filter</strong> — off = all trades; on = only when fast EMA is above
                    slow EMA before entry.
                  </span>
                </label>
                {!data.perTradeRChron?.length ? (
                  <p className="hourly-spikes-hint spike-tpsl-equity-ema-warn">
                    Re-run the backtest to load <code className="inline-code">perTradeRChron</code> for this panel.
                  </p>
                ) : equityEmaStats ? (
                  <>
                    <div className="backtest1-summary-grid spike-tpsl-equity-ema-stats">
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Stats mode</span>
                        <span className="backtest1-stat-value">
                          {equityEmaStats.mode === 'filtered' ? 'Fast EMA > slow' : 'All (subsample)'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Fast / slow EMA</span>
                        <span className="backtest1-stat-value">
                          {equityEmaStats.emaFastPeriod != null && equityEmaStats.emaSlowPeriod != null
                            ? `${fmtInt(equityEmaStats.emaFastPeriod)} / ${fmtInt(equityEmaStats.emaSlowPeriod)}`
                            : '—'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Kept / skipped</span>
                        <span className="backtest1-stat-value">
                          {fmtInt(equityEmaStats.kept)} / {fmtInt(equityEmaStats.skipped)}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Sum R</span>
                        <span
                          className={`backtest1-stat-value ${(equityEmaStats.sumR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {equityEmaStats.sumR != null && Number.isFinite(equityEmaStats.sumR)
                            ? `${equityEmaStats.sumR.toFixed(2)}R`
                            : '—'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Avg R</span>
                        <span
                          className={`backtest1-stat-value ${(equityEmaStats.avgR ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {equityEmaStats.avgR != null && Number.isFinite(equityEmaStats.avgR)
                            ? `${equityEmaStats.avgR.toFixed(3)}R`
                            : '—'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">Σ price %</span>
                        <span
                          className={`backtest1-stat-value ${(equityEmaStats.sumPnlPct ?? 0) >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {equityEmaStats.sumPnlPct != null && Number.isFinite(equityEmaStats.sumPnlPct)
                            ? `${equityEmaStats.sumPnlPct >= 0 ? '+' : ''}${equityEmaStats.sumPnlPct.toFixed(2)}%`
                            : '—'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">End stack</span>
                        <span className="backtest1-stat-value">
                          {equityEmaStats.finalStackLevel != null && Number.isFinite(equityEmaStats.finalStackLevel)
                            ? equityEmaStats.finalStackLevel.toFixed(4)
                            : '—'}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">TP / SL / EOD</span>
                        <span className="backtest1-stat-value">
                          {fmtInt(equityEmaStats.tpHits)} / {fmtInt(equityEmaStats.slHits)} /{' '}
                          {fmtInt(equityEmaStats.eodHits)}
                        </span>
                      </div>
                      <div className="backtest1-stat">
                        <span className="backtest1-stat-label">TP / (TP+SL)</span>
                        <span className="backtest1-stat-value">
                          {equityEmaStats.winRateTpVsSlPct != null &&
                          Number.isFinite(equityEmaStats.winRateTpVsSlPct)
                            ? `${equityEmaStats.winRateTpVsSlPct.toFixed(1)}%`
                            : '—'}
                        </span>
                      </div>
                    </div>
                    {equityEmaInteractiveCurvePoints && equityEmaInteractiveCurvePoints.length > 1 ? (
                      <>
                        <h5 className="hourly-spikes-h3">Interactive EMA mode curve</h5>
                        <p className="hourly-spikes-hint">
                          Running Σ price % using current panel mode (
                          <strong>{equityEmaStats.mode === 'filtered' ? 'fast EMA > slow' : 'all trades'}</strong>
                          ).
                        </p>
                        <SpikeTpSlEquityLightChart points={equityEmaInteractiveCurvePoints} />
                      </>
                    ) : null}
                  </>
                ) : null}
              </div>
            </section>
          )}

          {data.equityCurve && data.equityCurve.length > 1 && (
            <section className="hourly-spikes-section spike-tpsl-equity-section">
              <h2 className="hourly-spikes-h2">Cumulative Σ price % (per trade)</h2>
              <p className="hourly-spikes-hint">
                Trades in <strong>entry-time</strong> order. Each trade adds its entry→exit{' '}
                <strong>price</strong> return % (long:{' '}
                <code className="inline-code">(exit−entry)/entry</code>, short:{' '}
                <code className="inline-code">(entry−exit)/entry</code>). The <strong>right</strong> scale is
                the <strong>running sum</strong> of those % (starts at 0). The <strong>left</strong> scale
                (gold line) is <strong>BTCUSDT</strong> close on the entry bar (same kline interval as the
                backtest), aligned in trade order for context.
                {data.equityCurveDownsampled ? (
                  <>
                    {' '}
                    Curve points are <strong>downsampled</strong> in the API for large runs (summary Σ % is
                    still exact). Chart uses TradingView Lightweight Charts (canvas).
                  </>
                ) : (
                  <> Chart uses TradingView Lightweight Charts (canvas).</>
                )}
              </p>
              <SpikeTpSlEquityLightChart points={data.equityCurve} />
            </section>
          )}

          <section className="hourly-spikes-section">
            <h2 className="hourly-spikes-h2">Per symbol</h2>
            <div className="table-wrap hourly-spikes-table-scroll">
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th className="cell-right">24h vol</th>
                    <th className="cell-right">Bars</th>
                    <th className="cell-right">Trades</th>
                    {emaFilterCol ? <th className="cell-right">EMA skip</th> : null}
                    <th className="cell-right">TP</th>
                    <th className="cell-right">SL</th>
                    <th className="cell-right">EOD</th>
                    <th className="cell-right">Sum R</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.perSymbol ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={emaFilterCol ? 9 : 8} className="hourly-spikes-empty">
                        No symbols or no trades.
                      </td>
                    </tr>
                  ) : (
                    (data.perSymbol ?? []).map((r) => (
                      <tr key={r.symbol}>
                        <td className="cell-mono">{r.symbol}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.quoteVolume24h)}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.candleCount)}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.tradeCount)}</td>
                        {emaFilterCol ? (
                          <td className="cell-mono cell-right">{fmtInt(r.emaSkipCount ?? 0)}</td>
                        ) : null}
                        <td className="cell-mono cell-right pnl-pos">{fmtInt(r.tpCount)}</td>
                        <td className="cell-mono cell-right pnl-neg">{fmtInt(r.slCount)}</td>
                        <td className="cell-mono cell-right">{fmtInt(r.eodCount)}</td>
                        <td
                          className={`cell-mono cell-right ${r.sumR >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {Number.isFinite(r.sumR) ? r.sumR.toFixed(2) : '—'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="hourly-spikes-section">
            <h2 className="hourly-spikes-h2">Recent trades</h2>
            <p className="hourly-spikes-hint">
              OHLC is the <strong>spike</strong> candle;{' '}
              <strong>R</strong> ={' '}
              {(data?.strategy ?? strategy) === 'shortRedSpike'
                ? 'spike high − spike close'
                : (data?.strategy ?? strategy) === 'longRedSpikeTpHigh'
                  || (data?.strategy ?? strategy) === 'shortGreenRetestLow'
                  || (data?.strategy ?? strategy) === 'longGreenRetestLow'
                  ? 'stop distance (entry − SL); table column is price risk to SL'
                  : 'spike close − spike low'}
              .{' '}
              <strong>Exit</strong> is the model fill (SL, TP, or last close for EOD). Spike/exit times use
              your browser&apos;s <strong>local</strong> timezone.{' '}
              <strong>Bars</strong> = candles held from entry bar through exit bar (inclusive);{' '}
              <strong>1</strong> means SL/TP was hit on the <strong>same</strong> candle as the entry open.
            </p>
            {data.tradesTruncated && (
              <p className="hourly-spikes-hint">
                Showing {data.trades?.length ?? 0} of {fmtInt(data.totalTradeRows)} rows.
              </p>
            )}
            <div className="table-wrap hourly-spikes-table-scroll">
              <table className="positions-table spike-tpsl-trades-table">
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Spike (local)</th>
                    <th className="cell-right">Body %</th>
                    <th className="cell-right">R</th>
                    <th className="cell-right">Spike O</th>
                    <th className="cell-right">Spike H/L</th>
                    <th className="cell-right">Spike C</th>
                    <th className="cell-right">Entry</th>
                    <th className="cell-right">Exit</th>
                    <th className="cell-right">SL</th>
                    <th className="cell-right">TP</th>
                    <th>Out</th>
                    <th className="cell-right">Bars</th>
                    <th className="cell-right">R mult</th>
                    <th>Exit bar (local)</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.trades ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={16} className="hourly-spikes-empty">
                        No trades.
                      </td>
                    </tr>
                  ) : (
                    data.trades.map((t, j) => (
                      <tr key={`${t.symbol}-${t.entryOpenTime}-${j}`}>
                        <td className="cell-mono">{t.symbol}</td>
                        <td className="cell-mono">
                          {t.side === 'short' ? 'short' : t.side === 'long' ? 'long' : '—'}
                        </td>
                        <td className="cell-mono">{fmtTime(t.spikeOpenTime)}</td>
                        <td className="cell-mono cell-right">{fmtBodyPct(t.spikeBodyPct)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.R)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.spikeOpen)}</td>
                        <td className="cell-mono cell-right">
                          {t.spikeHigh != null && t.spikeLow != null
                            ? `${fmtPx(t.spikeHigh)} / ${fmtPx(t.spikeLow)}`
                            : '—'}
                        </td>
                        <td className="cell-mono cell-right">{fmtPx(t.spikeClose)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.entryPrice ?? t.entry)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.exitPrice)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.slPrice)}</td>
                        <td className="cell-mono cell-right">{fmtPx(t.tpPrice)}</td>
                        <td className="cell-mono">{t.outcome}</td>
                        <td className="cell-mono cell-right">
                          {Number.isFinite(t.barsInTrade) ? fmtInt(t.barsInTrade) : '—'}
                        </td>
                        <td
                          className={`cell-mono cell-right ${t.rMultiple >= 0 ? 'pnl-pos' : 'pnl-neg'}`}
                        >
                          {fmtR(t.rMultiple)}
                        </td>
                        <td className="cell-mono">{fmtTime(t.exitOpenTime)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>

          {includeOhlcCharts &&
            data.chartCandlesBySymbol &&
            Object.keys(data.chartCandlesBySymbol).length > 0 && (
              <SpikeTpSlSymbolCandleCharts
                chartCandlesBySymbol={data.chartCandlesBySymbol}
                chartEmaBySymbol={data.chartEmaBySymbol}
                chartTradeMarkers={data.chartTradeMarkers}
                chartSkippedMarkers={data.chartSkippedMarkers}
                interval={data.interval ?? interval}
                chartMaxCandlesPerSymbol={data.chartMaxCandlesPerSymbol}
                chartMaxSymbols={data.chartMaxSymbols}
                chartSymbolsReturned={data.chartSymbolsReturned}
                chartSymbolsWithTradesTotal={data.chartSymbolsWithTradesTotal}
              />
            )}
        </>
      )}
    </div>
  )
}
