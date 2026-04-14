import { useCallback, useState } from 'react'
import {
  SpikeTpSlEquityLightChart,
  SpikeTpSlPerTradeLightChart,
} from './spikeTpSlLightweightCharts.jsx'

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
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

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
      const out = await fetchBacktest({
        minQuoteVolume24h: Number.isFinite(mv) && mv >= 0 ? mv : DEFAULT_MIN_VOL,
        interval,
        candleCount: n,
        thresholdPct: th,
        strategy,
        ...(fd && td ? { fromDate: fd, toDate: td } : {}),
      })
      setData(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [minQuoteVolume24h, interval, candleCount, thresholdPct, strategy, fromDate, toDate])

  const s = data?.summary
  const tpLbl = data?.tpStatLabel ?? 'TP (2R)'
  const slLbl = data?.slStatLabel ?? 'SL (-1R)'

  return (
    <div className="vol-screener spike-tpsl-bt">
      <h1 className="vol-screener-title">Spike TP/SL backtest</h1>
      <p className="vol-screener-lead">
        Filters USDT-M perpetuals by <strong>24h quote volume</strong>, loads <strong>N</strong> candles
        per symbol, finds <strong>{strategy === 'shortRedSpike' ? 'red' : 'green'}</strong> candles whose{' '}
        <strong>body</strong> is at least your threshold % vs open.{' '}
        {strategy === 'shortRedSpike' ? (
          <>
            <strong>R = spike high − spike close</strong>. <strong>Short</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry + R</code>, target{' '}
            <code className="inline-code">entry − 2R</code> (same 2:1 R-multiple idea as long, mirrored).{' '}
          </>
        ) : strategy === 'shortSpikeLow' ? (
          <>
            <strong>R = spike close − spike low</strong>. <strong>Short</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry + 2R</code>, take-profit when
            price trades at the <strong>spike candle low</strong> (skipped if next open is already ≤ that low).{' '}
          </>
        ) : (
          <>
            <strong>R = spike close − spike low</strong>. <strong>Long</strong> at the{' '}
            <strong>next open</strong>: stop <code className="inline-code">entry − R</code>, target{' '}
            <code className="inline-code">entry + 2R</code>.{' '}
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
          <strong>above</strong> that entry: distance = <strong>2×R</strong>, with{' '}
          <strong>R = spike close − spike low</strong>. Your <strong>profit target</strong> is the{' '}
          <strong>low of that same spike candle</strong>—if price trades down there, you cover the short.
          If price hits the stop first, you lose <strong>1R</strong> (here, 1R means one full stop width =
          2×R in price). Trades where the next open is already at or below the spike low are skipped.
        </p>
      )}

      {(strategy === 'shortRedSpike' || data?.strategy === 'shortRedSpike') && (
        <p className="hourly-spikes-hint spike-tpsl-short-plain">
          <strong>Short on red spike (plain):</strong> A big <strong>red</strong> candle (the spike) just
          closed—the opposite of the long setup. You <strong>sell (short) at the next candle&apos;s open</strong>.
          Risk unit <strong>R = spike high − spike close</strong> (the body &quot;stretch&quot; upward). Stop is{' '}
          <strong>entry + R</strong>; target is <strong>entry − 2R</strong> (2R profit vs 1R risk, mirrored from
          the long rule). Same bar priority: if both levels touch one bar, <strong>stop first</strong> (conservative).
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
            <option value="long">Long — TP +2R / SL −1R (green spike, R below)</option>
            <option value="shortSpikeLow">Short — TP spike low / SL +2R (green spike)</option>
            <option value="shortRedSpike">Short — TP −2R / SL +1R (red spike, mirrored)</option>
          </select>
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
                    <th className="cell-right">TP</th>
                    <th className="cell-right">SL</th>
                    <th className="cell-right">EOD</th>
                    <th className="cell-right">Sum R</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.perSymbol ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={8} className="hourly-spikes-empty">
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
        </>
      )}
    </div>
  )
}
