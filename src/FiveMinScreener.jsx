import { useCallback, useMemo, useState } from 'react'
import { FiveMinScreenerCharts } from './FiveMinScreenerCharts'
import { FiveMinNetCumulativeChart } from './FiveMinNetCumulativeChart'
import { enrichSpikeSlots } from './fiveMinSlotMetrics'

const DEFAULT_CANDLE_COUNT = 120
const DEFAULT_MIN_VOL = 1_000_000
const DEFAULT_THRESHOLD = 3
const DEFAULT_INTERVAL = '5m'
const INTERVAL_OPTIONS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h']

async function fetchFiveMinScreener(
  candleCount,
  minQuoteVolume,
  thresholdPct,
  interval,
  spikeDirections,
) {
  const q = new URLSearchParams({
    candleCount: String(candleCount),
    minQuoteVolume: String(minQuoteVolume),
    thresholdPct: String(thresholdPct),
    interval,
    spikeDirections: String(spikeDirections),
  })
  const res = await fetch(`/api/binance/5m-screener?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function fmtPct(n) {
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : '—'
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

function chgClass(n) {
  if (n == null || !Number.isFinite(n)) return ''
  if (n > 0) return 'pnl-pos'
  if (n < 0) return 'pnl-neg'
  return ''
}

function spikeDirLabel(d) {
  if (d === 'down') return '↓ down wick'
  return '↑ up wick'
}

export function FiveMinScreener({ spikeDirections: spikeDirectionsProp = 'up' }) {
  const [candleCount, setCandleCount] = useState(String(DEFAULT_CANDLE_COUNT))
  const [minVol, setMinVol] = useState(String(DEFAULT_MIN_VOL))
  const [threshold, setThreshold] = useState(String(DEFAULT_THRESHOLD))
  const [interval, setInterval] = useState(DEFAULT_INTERVAL)
  const spikeDirections = spikeDirectionsProp
  /** perLeg: long each ↑ next %, short each ↓ next %. directionalNext: Wick Σ sign × total next % sum. */
  const [netStrategy, setNetStrategy] = useState('perLeg')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)
  const edgeBuckets = useMemo(() => {
    const t = data?.timeline
    if (!Array.isArray(t) || t.length === 0) return []
    const out = [
      { key: '1 spike', min: 1, max: 1, spikes: 0, pos: 0, neg: 0 },
      { key: '2 spikes', min: 2, max: 2, spikes: 0, pos: 0, neg: 0 },
      { key: '3-4 spikes', min: 3, max: 4, spikes: 0, pos: 0, neg: 0 },
      { key: '5+ spikes', min: 5, max: Infinity, spikes: 0, pos: 0, neg: 0 },
    ]
    for (const row of t) {
      const b = out.find((x) => row.spikeCount >= x.min && row.spikeCount <= x.max)
      if (!b) continue
      b.spikes += row.spikeCount || 0
      b.pos += row.next2PositiveCount || 0
      b.neg += row.next2NegativeCount || 0
    }
    return out.filter((b) => b.spikes > 0).map((b) => ({
      ...b,
      posRatePct: b.spikes > 0 ? (b.pos / b.spikes) * 100 : 0,
    }))
  }, [data])

  const enrichedSlots = useMemo(
    () => enrichSpikeSlots(data?.spikeSlotsTimeWiseV2),
    [data?.spikeSlotsTimeWiseV2],
  )

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const count = Number.parseInt(String(candleCount).trim(), 10)
      if (!Number.isFinite(count) || count < 1 || count > 1500) {
        throw new Error('Lookback candle count must be 1–1500')
      }
      const mv = Number.parseFloat(String(minVol).replace(/,/g, '').trim())
      if (!Number.isFinite(mv) || mv < 0) {
        throw new Error('24h volume filter must be non-negative')
      }
      const th = Number.parseFloat(String(threshold).trim())
      if (!Number.isFinite(th) || th <= 0) {
        throw new Error('Spike threshold % must be positive')
      }
      const result = await fetchFiveMinScreener(count, mv, th, interval, spikeDirections)
      setData(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to run screener')
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [candleCount, minVol, threshold, interval, spikeDirections])

  const showDir = spikeDirections === 'both' || spikeDirections === 'down'

  return (
    <div className="vol-screener">
      <h1 className="vol-screener-title">
        {spikeDirections === 'both'
          ? '5min screener (± wicks)'
          : spikeDirections === 'down'
            ? '5min screener (down wicks)'
            : '5min screener'}
      </h1>
      <p className="vol-screener-lead">
        Scans all USDT-M perpetuals with 24h quote volume above your filter, fetches last{' '}
        <strong>{interval}</strong> candles for selected lookback count, and flags spikes when the
        wick from open is at least the threshold:{' '}
        {spikeDirections === 'down' ? (
          <>
            <strong>(open − low) / open</strong> (lower wick only).
          </>
        ) : spikeDirections === 'both' ? (
          <>
            <strong>(high − open) / open</strong> (upper) and/or <strong>(open − low) / open</strong>{' '}
            (lower).
          </>
        ) : (
          <>
            <strong>(high − open) / open</strong> (upper wick only).
          </>
        )}{' '}
        For each spike, it then checks the <strong>next 2 candles</strong> and marks it
        positive/negative by the sum of those two candle returns.
      </p>

      <div className="vol-screener-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Lookback candles</span>
          <input
            type="number"
            className="vol-screener-input"
            min={1}
            max={1500}
            step={1}
            value={candleCount}
            onChange={(e) => setCandleCount(e.target.value)}
            disabled={loading}
          />
          <span className="vol-screener-hint">Example: 1000 candles on 4h interval</span>
        </label>

        <label className="vol-screener-field">
          <span className="vol-screener-label">24h quote volume filter (USDT)</span>
          <input
            type="text"
            className="vol-screener-input"
            inputMode="decimal"
            value={minVol}
            onChange={(e) => setMinVol(e.target.value)}
            disabled={loading}
          />
          <span className="vol-screener-hint">Default 1,000,000</span>
        </label>

        <label className="vol-screener-field">
          <span className="vol-screener-label">Candle interval</span>
          <select
            className="vol-screener-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
            disabled={loading}
          >
            {INTERVAL_OPTIONS.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </select>
          <span className="vol-screener-hint">Forward windows use this base candle size.</span>
        </label>

        <label className="vol-screener-field">
          <span className="vol-screener-label">Spike threshold %</span>
          <input
            type="number"
            className="vol-screener-input"
            min={0.01}
            step={0.1}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
            disabled={loading}
          />
          <span className="vol-screener-hint">Default 3%</span>
        </label>

        <label className="vol-screener-field">
          <span className="vol-screener-label">Net &amp; chart (per slot)</span>
          <select
            className="vol-screener-input"
            value={netStrategy}
            onChange={(e) => setNetStrategy(e.target.value)}
          >
            <option value="perLeg">
              Per spike: long ↑ next %, short ↓ next % (Σ↑ − Σ↓)
            </option>
            <option value="directionalNext">
              Directional: Wick Σ sign → long or short the total next % (sum)
            </option>
          </select>
          <span className="vol-screener-hint">
            Directional uses signed Wick Σ; if &gt; 0 go long the <strong>total</strong> (sum) of
            next-bar % across all spikes in the slot; if &lt; 0 go short that total.
          </span>
        </label>

        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Scanning…' : 'Run screener'}
          </button>
        </div>
      </div>

      {error && (
        <div className="positions-error" role="alert">
          <p className="positions-error-title">Could not run screener</p>
          <p className="positions-error-msg">{error}</p>
        </div>
      )}

      {loading && !error && (
        <p className="positions-status" role="status">
          Loading 24h data and 5m candles across symbols…
        </p>
      )}

      {data && (
        <>
          <p className="positions-meta vol-screener-meta">
            Spikes:{' '}
            <strong>
              {data.spikeDirections === 'both'
                ? 'up + down wicks'
                : data.spikeDirections === 'down'
                  ? 'down wicks only'
                  : 'up wicks only'}
            </strong>
            {' · '}
            {data.interval} candles · lookback {data.candleCount} candles · threshold ≥{' '}
            {data.thresholdPct}% · symbols {data.symbolCount}
            {data.symbolsCapped ? ` (capped at ${data.cappedAt})` : ''}
            {data.skipped > 0 ? ` · skipped ${data.skipped}` : ''}
            {data.fetchedAt ? ` · ${new Date(data.fetchedAt).toLocaleString()}` : ''}
          </p>
          {Array.isArray(data.timeline) && data.timeline.length > 0 && (
            <>
              <div className="backtest1-summary-grid">
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">{data.interval} intervals</span>
                  <span className="backtest1-stat-value">{fmtInt(data.timeline.length)}</span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Max spikes in one interval</span>
                  <span className="backtest1-stat-value">{fmtInt(data.maxSpikeCount)}</span>
                </div>
                <div className="backtest1-stat">
                  <span className="backtest1-stat-label">Avg spikes / interval</span>
                  <span className="backtest1-stat-value">
                    {Number.isFinite(data.avgSpikeCount) ? data.avgSpikeCount.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
              <p className="backtest1-chart-hint">
                TradingView-style charts: interval bars for aggregated post-spike returns.
              </p>
              <FiveMinScreenerCharts
                timeline={data.timeline}
                interval={data.interval}
                intervalMinutes={data.intervalMinutes}
              />

              {edgeBuckets.length > 0 && (
                <div className="backtest1-summary-grid" style={{ marginTop: '0.75rem' }}>
                  {edgeBuckets.map((b) => (
                    <div key={b.key} className="backtest1-stat">
                      <span className="backtest1-stat-label">{b.key}</span>
                      <span className={`backtest1-stat-value ${b.posRatePct >= 50 ? 'pnl-pos' : 'pnl-neg'}`}>
                        {b.pos} / {b.spikes} ({b.posRatePct.toFixed(1)}%)
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {enrichedSlots.length > 0 && (
                <FiveMinNetCumulativeChart
                  slots={enrichedSlots}
                  interval={data.interval}
                  netMode={netStrategy}
                />
              )}
              {enrichedSlots.length > 0 && (
                <div className="table-wrap vol-screener-table-wrap" style={{ marginBottom: '1rem' }}>
                  <h2 className="vol-screener-subtitle">Spikes — time-wise (one row per candle)</h2>
                  <p className="vol-screener-lead vol-screener-lead--tight">
                    Grouped by <strong>spike candle open time</strong>. <strong>Wick Σ</strong> is the
                    sum of signed wick % (↑ positive, ↓ negative). <strong>Σ next (↑)</strong> /{' '}
                    <strong>Σ next (↓)</strong> are per-leg next-bar sums.{' '}
                    {netStrategy === 'perLeg' ? (
                      <>
                        <strong>Net</strong> = Σ(↑) − Σ(↓) (long ↑ legs, short ↓ legs).
                      </>
                    ) : (
                      <>
                        <strong>Net (directional)</strong>: if Wick Σ &gt; 0, +sum of next % (long total);
                        if &lt; 0, −that sum (short); if 0, flat.
                      </>
                    )}{' '}
                    Detail lists each symbol’s wick % → next %.
                  </p>
                  <table className="positions-table vol-screener-table vol-screener-table--v2 zebra">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Time (UTC)</th>
                        <th>Spikes</th>
                        <th>Avg spike %</th>
                        <th>Avg next %</th>
                        <th>Wick Σ (signed)</th>
                        <th>Σ next (↑)</th>
                        <th>Σ next (↓)</th>
                        <th>
                          {netStrategy === 'perLeg'
                            ? 'Net (per-leg)'
                            : 'Net (directional total %)'}
                        </th>
                        <th>Per symbol (↑/↓ spike % → next %)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {enrichedSlots.map((slot, i) => (
                        <tr key={slot.openTime}>
                          <td className="cell-mono">{i + 1}</td>
                          <td className="cell-mono">{fmtTime(slot.openTime)}</td>
                          <td className="cell-mono">{fmtInt(slot.spikeCount)}</td>
                          <td className={`cell-mono ${chgClass(slot.avgSpikePct)}`}>
                            {fmtPct(slot.avgSpikePct)}
                          </td>
                          <td
                            className={`cell-mono cell-pnl ${chgClass(slot.avgNextCandlePct)}`}
                          >
                            {slot.avgNextCandlePct == null
                              ? '—'
                              : fmtPct(slot.avgNextCandlePct)}
                          </td>
                          <td className={`cell-mono ${chgClass(slot.wickSignedSum)}`}>
                            {fmtPct(slot.wickSignedSum)}
                          </td>
                          <td className={`cell-mono cell-pnl ${chgClass(slot.sumNextAfterUpSpikes)}`}>
                            {data.spikeDirections === 'down'
                              ? '—'
                              : fmtPct(slot.sumNextAfterUpSpikes ?? 0)}
                          </td>
                          <td className={`cell-mono cell-pnl ${chgClass(slot.sumNextAfterDownSpikes)}`}>
                            {data.spikeDirections === 'up'
                              ? '—'
                              : fmtPct(slot.sumNextAfterDownSpikes ?? 0)}
                          </td>
                          <td
                            className={`cell-mono cell-pnl ${chgClass(
                              netStrategy === 'perLeg'
                                ? slot.longShortNetNextSum
                                : slot.directionalNet,
                            )}`}
                          >
                            {fmtPct(
                              netStrategy === 'perLeg'
                                ? slot.longShortNetNextSum ?? 0
                                : slot.directionalNet ?? 0,
                            )}
                          </td>
                          <td className="spike-v2-detail-cell">
                            <ul className="spike-v2-detail-list">
                              {slot.events.map((ev) => (
                                <li key={`${ev.symbol}-${ev.openTime}-${ev.direction ?? 'up'}`}>
                                  <span className="cell-mono">{ev.symbol}</span>
                                  {showDir && (
                                    <span className="spike-dir-badge" title={spikeDirLabel(ev.direction)}>
                                      {ev.direction === 'down' ? ' ↓' : ' ↑'}
                                    </span>
                                  )}
                                  <span className={chgClass(ev.spikePct)}>
                                    {' '}
                                    {fmtPct(ev.spikePct)}
                                  </span>
                                  <span className="spike-v2-arrow"> → </span>
                                  <span
                                    className={`cell-pnl ${chgClass(ev.nextCandlePct)}`}
                                  >
                                    {ev.nextCandlePct == null ? '—' : fmtPct(ev.nextCandlePct)}
                                  </span>
                                </li>
                              ))}
                            </ul>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          {!Array.isArray(data.timeline) || data.timeline.length === 0 ? (
            <p className="positions-empty">No symbols matched this filter.</p>
          ) : null}
        </>
      )}
    </div>
  )
}

