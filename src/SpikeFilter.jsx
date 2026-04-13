import { useCallback, useMemo, useState } from 'react'

const DEFAULT_LIMIT = 500
const DEFAULT_THRESHOLD = 3
const DEFAULT_MIN_24H_VOL = 1_000_000
const INTERVAL_OPTIONS = [
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
  '3d',
  '1w',
  '1M',
]

async function fetchSpikeFilter(params) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    q.set(k, String(v))
  }
  const res = await fetch(`/api/binance/spike-filter?${q}`, { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function fmtTime(ms) {
  if (!Number.isFinite(ms)) return '—'
  return new Date(ms).toLocaleString()
}

function fmtVol(n) {
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 })
}

function fmtInt(n) {
  return Number.isFinite(n) ? n.toLocaleString() : '—'
}

function spikeCandleColorLabel(r) {
  if (r.spikeBodyIsGreen === true) return 'green'
  if (r.spikeBodyIsGreen === false) return 'red'
  const pct = r.spikeBodyPct
  if (!Number.isFinite(pct)) return '—'
  if (pct > 0) return 'green'
  if (pct < 0) return 'red'
  return '—'
}

/** Raw vs filtered spike counts by UTC hour (spike candle open). */
function SpikeFilterHourlyCountBars({ hourlyByUtc, includeNegativeSpikes }) {
  const maxCount = useMemo(() => {
    if (!hourlyByUtc?.length) return 1
    let m = 1
    for (const h of hourlyByUtc) {
      if (h.rawSpikeCount > m) m = h.rawSpikeCount
      if (h.filteredSpikeCount > m) m = h.filteredSpikeCount
    }
    return m
  }, [hourlyByUtc])

  if (!hourlyByUtc?.length) return null

  return (
    <div className="hourly-spikes-section spike-filter-charts" aria-label="Spike counts by UTC hour">
      <h2 className="hourly-spikes-h2">Spike counts by UTC hour (0–23)</h2>
      <p className="hourly-spikes-hint">
        <span className="spike-filter-legend-swatch spike-filter-legend-swatch--raw" />{' '}
        {includeNegativeSpikes
          ? 'All green- or red-body spikes ≥ threshold · '
          : 'All green-body spikes ≥ threshold · '}
        <span className="spike-filter-legend-swatch spike-filter-legend-swatch--filt" /> After your
        trend / volume-ratio filters. Spike time = candle open time (UTC).
      </p>
      <div className="spike-filter-dual-bars" role="img" aria-label="Raw and filtered spike histogram">
        {hourlyByUtc.map((h) => (
          <div key={h.utcHour} className="spike-filter-dual-bar-wrap">
            <div className="spike-filter-dual-bar-col">
              <div
                className="spike-filter-bar spike-filter-bar--raw"
                style={{ height: `${(h.rawSpikeCount / maxCount) * 100}%` }}
                title={`${h.utcHour}:00 UTC raw: ${h.rawSpikeCount}`}
              />
              <div
                className="spike-filter-bar spike-filter-bar--filtered"
                style={{ height: `${(h.filteredSpikeCount / maxCount) * 100}%` }}
                title={`${h.utcHour}:00 UTC filtered: ${h.filteredSpikeCount}`}
              />
            </div>
            <span className="hourly-spikes-bar-label">{h.utcHour}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Mean next-candle body % for filtered spikes only, by UTC hour. */
function SpikeFilterHourlyReturnBars({ hourlyByUtc }) {
  const chart = useMemo(() => {
    const W = 560
    const H = 200
    const padL = 40
    const padR = 12
    const padT = 12
    const padB = 22
    const innerW = W - padL - padR
    const innerH = H - padT - padB
    const series = (hourlyByUtc ?? []).map((h) => ({
      utcHour: h.utcHour,
      v: h.meanFilteredNextBodyPct,
      n: h.filteredSpikeCount,
    }))
    const finite = series.filter(
      (s) =>
        s.n > 0 && s.v != null && Number.isFinite(s.v),
    )
    if (finite.length === 0) {
      return {
        bars: [],
        series,
        zeroY: padT + innerH / 2,
        w: W,
        h: H,
        minV: 0,
        maxV: 0,
        padL,
        padR,
      }
    }
    const vals = finite.map((s) => s.v)
    let minV = Math.min(0, ...vals)
    let maxV = Math.max(0, ...vals)
    if (minV === maxV) {
      minV -= 0.05
      maxV += 0.05
    }
    const span = maxV - minV
    const yAt = (v) => padT + ((maxV - v) / span) * innerH
    const zeroY = yAt(0)
    const n = 24
    const slotW = innerW / n
    const barW = Math.max(2, slotW * 0.5)
    const bars = series.map((s, j) => {
      if (s.v == null || !Number.isFinite(s.v) || s.n === 0) {
        return { utcHour: s.utcHour, skip: true }
      }
      const cx = padL + j * slotW + slotW / 2
      const x0 = cx - barW / 2
      const y0 = yAt(s.v)
      const top = Math.min(zeroY, y0)
      const bh = Math.abs(y0 - zeroY)
      return {
        utcHour: s.utcHour,
        skip: false,
        x: x0,
        y: top,
        width: barW,
        height: Math.max(bh, 0.5),
        neg: s.v < 0,
        labX: cx,
        labY: H - 6,
      }
    })
    return { bars, zeroY, w: W, h: H, minV, maxV, padL, padR, series }
  }, [hourlyByUtc])

  if (!hourlyByUtc?.length) return null

  const hasData = (hourlyByUtc ?? []).some(
    (h) =>
      h.filteredSpikeCount > 0 &&
      h.meanFilteredNextBodyPct != null &&
      Number.isFinite(h.meanFilteredNextBodyPct),
  )
  if (!hasData) {
    return (
      <div className="hourly-spikes-section">
        <h2 className="hourly-spikes-h2">Mean next-candle body % (filtered only)</h2>
        <p className="hourly-spikes-hint">No filtered spikes with a next bar in any hour bucket.</p>
      </div>
    )
  }

  const { bars, zeroY, w, h, minV, maxV, padL, padR } = chart

  return (
    <div className="hourly-spikes-section spike-filter-charts">
      <h2 className="hourly-spikes-h2">Mean next-candle body % (filtered trades)</h2>
      <p className="hourly-spikes-hint">
        For each UTC hour, average of <code className="inline-code">(close − open) / open</code> on the
        candle <strong>after</strong> the spike, only for spikes that passed your filters. Hours with
        no filtered spike show no bar.
      </p>
      <div className="gpt-bt-pnl-chart-wrap">
        <svg
          className="gpt-bt-pnl-chart"
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          role="img"
          aria-label="Mean next candle return by UTC hour"
        >
          <text className="gpt-bt-pnl-axis" x={4} y={16}>
            {maxV.toFixed(2)}%
          </text>
          <text className="gpt-bt-pnl-axis" x={4} y={h - 4}>
            {minV.toFixed(2)}%
          </text>
          <line
            className="gpt-bt-pnl-zero"
            x1={padL}
            y1={zeroY}
            x2={w - padR}
            y2={zeroY}
          />
          {bars.map((b) =>
            b.skip ? null : (
              <g key={b.utcHour}>
                <rect
                  className={
                    b.neg ? 'gpt-bt-pnl-bar gpt-bt-pnl-bar--neg' : 'gpt-bt-pnl-bar gpt-bt-pnl-bar--pos'
                  }
                  x={b.x}
                  y={b.y}
                  width={b.width}
                  height={b.height}
                  rx={1}
                />
                <text className="gpt-bt-pnl-xlabel" x={b.labX} y={b.labY} textAnchor="middle">
                  {b.utcHour}
                </text>
              </g>
            ),
          )}
        </svg>
      </div>
    </div>
  )
}

export function SpikeFilter() {
  const [symbol, setSymbol] = useState('')
  const [minQuoteVolume24h, setMinQuoteVolume24h] = useState(String(DEFAULT_MIN_24H_VOL))
  const [interval, setInterval] = useState('1h')
  const [limit, setLimit] = useState(String(DEFAULT_LIMIT))
  const [thresholdPct, setThresholdPct] = useState(String(DEFAULT_THRESHOLD))
  const [minSpikeQuoteVolume, setMinSpikeQuoteVolume] = useState('0')
  /** green = only bullish spike candles; both = include red (negative) body spikes of same magnitude */
  const [spikeBodies, setSpikeBodies] = useState('green')

  const [trendFilter, setTrendFilter] = useState(false)
  const [trendLookback, setTrendLookback] = useState('15')
  const [trendDirection, setTrendDirection] = useState('up')

  const [volumeRatioFilter, setVolumeRatioFilter] = useState(false)
  const [volumeLookback, setVolumeLookback] = useState('15')
  const [volumeMultiplier, setVolumeMultiplier] = useState('2')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [data, setData] = useState(null)

  const run = useCallback(async () => {
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const lim = Number.parseInt(String(limit).replace(/,/g, ''), 10)
      const th = Number.parseFloat(String(thresholdPct))
      const minV = Number.parseFloat(String(minSpikeQuoteVolume).replace(/,/g, ''))
      const min24 = Number.parseFloat(String(minQuoteVolume24h).replace(/,/g, ''))
      const tLb = Number.parseInt(String(trendLookback), 10)
      const vLb = Number.parseInt(String(volumeLookback), 10)
      const vMult = Number.parseFloat(String(volumeMultiplier))

      const params = {
        symbol: symbol.trim(),
        interval,
        limit: lim,
        thresholdPct: th,
        minSpikeQuoteVolume: Number.isFinite(minV) && minV >= 0 ? minV : 0,
        includeNegativeSpikes: spikeBodies === 'both' ? 'true' : 'false',
        trendFilter: trendFilter ? 'true' : 'false',
        trendLookback: tLb,
        trendDirection,
        volumeRatioFilter: volumeRatioFilter ? 'true' : 'false',
        volumeLookback: vLb,
        volumeMultiplier: vMult,
      }
      if (!symbol.trim()) {
        params.minQuoteVolume24h = Number.isFinite(min24) && min24 >= 0 ? min24 : DEFAULT_MIN_24H_VOL
      }

      const out = await fetchSpikeFilter(params)
      setData(out)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed')
    } finally {
      setLoading(false)
    }
  }, [
    symbol,
    minQuoteVolume24h,
    interval,
    limit,
    thresholdPct,
    minSpikeQuoteVolume,
    trendFilter,
    trendLookback,
    trendDirection,
    volumeRatioFilter,
    volumeLookback,
    volumeMultiplier,
    spikeBodies,
  ])

  const isUniverse = data?.mode === 'universe'
  const isSingle = data?.mode === 'single'

  return (
    <div className="vol-screener spike-filter">
      <h1 className="vol-screener-title">Spike filter</h1>
      <p className="vol-screener-lead">
        <strong>Universe mode (default):</strong> all USDT-M perpetuals with 24h quote volume ≥ your
        floor — spike candles are green-body by default, or green + red when you include negative
        spikes; optional trend / spike-volume-ratio filters apply either way.{' '}
        <strong>Single symbol:</strong> enter a symbol below. Charts aggregate by{' '}
        <strong>UTC hour</strong> of the spike candle open (works best with <strong>1h</strong>{' '}
        candles; other intervals still bucket by clock hour).
      </p>

      <div className="vol-screener-form spike-filter-form">
        <label className="vol-screener-field">
          <span className="vol-screener-label">Symbol (empty = all markets by volume)</span>
          <input
            className="vol-screener-input"
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. BTCUSDT or leave blank"
            autoComplete="off"
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Min 24h quote volume (USDT, universe only)</span>
          <input
            className="vol-screener-input"
            type="text"
            inputMode="numeric"
            value={minQuoteVolume24h}
            onChange={(e) => setMinQuoteVolume24h(e.target.value)}
            disabled={!!symbol.trim()}
          />
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Timeframe</span>
          <select
            className="vol-screener-input"
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          >
            {INTERVAL_OPTIONS.map((iv) => (
              <option key={iv} value={iv}>
                {iv}
              </option>
            ))}
          </select>
        </label>
        <label className="vol-screener-field">
          <span className="vol-screener-label">Candles per symbol</span>
          <input
            className="vol-screener-input vol-screener-input--narrow"
            type="text"
            inputMode="numeric"
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
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
          <span className="vol-screener-label">Min spike quote volume (0 = off)</span>
          <input
            className="vol-screener-input"
            type="text"
            inputMode="decimal"
            value={minSpikeQuoteVolume}
            onChange={(e) => setMinSpikeQuoteVolume(e.target.value)}
          />
        </label>

        <div className="spike-filter-filter-block">
          <label className="spike-filter-toggle">
            <input
              type="checkbox"
              checked={trendFilter}
              onChange={(e) => setTrendFilter(e.target.checked)}
            />
            <span>Trend filter</span>
          </label>
          <label className="vol-screener-field">
            <span className="vol-screener-label">Trend lookback (bars before spike)</span>
            <input
              className="vol-screener-input vol-screener-input--narrow"
              type="text"
              inputMode="numeric"
              value={trendLookback}
              onChange={(e) => setTrendLookback(e.target.value)}
              disabled={!trendFilter}
            />
          </label>
          <label className="vol-screener-field">
            <span className="vol-screener-label">Require prior trend</span>
            <select
              className="vol-screener-input"
              value={trendDirection}
              onChange={(e) => setTrendDirection(e.target.value)}
              disabled={!trendFilter}
            >
              <option value="up">Positive % (close up over window)</option>
              <option value="down">Negative % (close down over window)</option>
            </select>
          </label>
        </div>

        <div className="spike-filter-filter-block">
          <label className="spike-filter-toggle">
            <input
              type="checkbox"
              checked={volumeRatioFilter}
              onChange={(e) => setVolumeRatioFilter(e.target.checked)}
            />
            <span>Volume ratio filter</span>
          </label>
          <label className="vol-screener-field">
            <span className="vol-screener-label">Volume lookback (bars before spike)</span>
            <input
              className="vol-screener-input vol-screener-input--narrow"
              type="text"
              inputMode="numeric"
              value={volumeLookback}
              onChange={(e) => setVolumeLookback(e.target.value)}
              disabled={!volumeRatioFilter}
            />
          </label>
          <label className="vol-screener-field">
            <span className="vol-screener-label">Spike vol ≥ × average prior</span>
            <input
              className="vol-screener-input vol-screener-input--narrow"
              type="text"
              inputMode="decimal"
              value={volumeMultiplier}
              onChange={(e) => setVolumeMultiplier(e.target.value)}
              disabled={!volumeRatioFilter}
            />
          </label>
        </div>

        <div className="vol-screener-actions">
          <button type="button" className="btn-refresh" onClick={run} disabled={loading}>
            {loading ? 'Running…' : 'Run scan'}
          </button>
        </div>
      </div>

      {error && (
        <p className="vol-screener-warn" role="alert">
          {error}
        </p>
      )}

      {data && !error && (
        <>
          <p className="vol-screener-meta">
            {isUniverse && (
              <>
                Universe: <strong>{fmtInt(data.symbolCount)}</strong> symbols (≥{' '}
                {fmtInt(data.minQuoteVolume24h)} USDT 24h vol)
                {data.symbolsCapped ? ` · capped at ${data.cappedAt}` : ''}
                {data.skipped > 0 ? ` · ${data.skipped} fetch errors` : ''}
                {' · '}
              </>
            )}
            {isSingle && (
              <>
                <strong>{data.symbol}</strong> · {fmtInt(data.candlesFetched)} candles · {data.interval}{' '}
                ·{' '}
              </>
            )}
            {isUniverse && `${data.interval} · ${fmtInt(data.limit)} bars/symbol · `}
            body ≥ <strong>{data.thresholdPct}%</strong>
            {data.filters?.includeNegativeSpikes ? ' · green + red spikes' : ' · green spikes only'}
            {data.minSpikeQuoteVolume > 0 ? ` · min spike vol ${fmtVol(data.minSpikeQuoteVolume)}` : ''}
            {' · '}
            spikes: <strong>{fmtInt(data.summary?.spikeCount ?? 0)}</strong>, after filters:{' '}
            <strong>{fmtInt(data.summary?.filteredCount ?? 0)}</strong>
            {(data.summary?.filteredCount ?? 0) > 0 ? (
              <>
                {' '}
                · next green: <strong>{fmtInt(data.summary.filteredNextGreen)}</strong>, red:{' '}
                <strong>{fmtInt(data.summary.filteredNextRed)}</strong>
                {data.summary.filteredNextGreenPct != null
                  ? ` (${data.summary.filteredNextGreenPct.toFixed(1)}% green)`
                  : ''}
              </>
            ) : null}
          </p>

          {(isUniverse || isSingle) && Array.isArray(data.hourlyByUtc) && data.hourlyByUtc.length > 0 && (
            <>
              <SpikeFilterHourlyCountBars
                hourlyByUtc={data.hourlyByUtc}
                includeNegativeSpikes={!!data.filters?.includeNegativeSpikes}
              />
              <SpikeFilterHourlyReturnBars hourlyByUtc={data.hourlyByUtc} />
              <div className="table-wrap hourly-spikes-table-wrap">
                <h2 className="hourly-spikes-h2">UTC hour table</h2>
                <table className="positions-table hourly-spikes-hour-table">
                  <thead>
                    <tr>
                      <th>UTC hour</th>
                      <th className="cell-right">Raw spikes</th>
                      <th className="cell-right">Filtered</th>
                      <th className="cell-right">Mean next %</th>
                      <th className="cell-right">Green</th>
                      <th className="cell-right">Red</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.hourlyByUtc.map((h) => (
                      <tr key={h.utcHour}>
                        <td className="cell-mono">{String(h.utcHour).padStart(2, '0')}:00</td>
                        <td className="cell-mono cell-right">{fmtInt(h.rawSpikeCount)}</td>
                        <td className="cell-mono cell-right">{fmtInt(h.filteredSpikeCount)}</td>
                        <td className="cell-mono cell-right">
                          {h.meanFilteredNextBodyPct != null && Number.isFinite(h.meanFilteredNextBodyPct)
                            ? `${h.meanFilteredNextBodyPct.toFixed(3)}%`
                            : '—'}
                        </td>
                        <td className="cell-mono cell-right">{fmtInt(h.filteredGreen)}</td>
                        <td className="cell-mono cell-right">{fmtInt(h.filteredRed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <section className="hourly-spikes-section">
                <h2 className="hourly-spikes-h2">Timeline (global candle open)</h2>
                <p className="hourly-spikes-hint">
                  Each row is one candle open time shared across symbols; counts are summed over the
                  universe.
                </p>
                <div className="table-wrap hourly-spikes-table-scroll">
                  <table className="positions-table">
                    <thead>
                      <tr>
                        <th>Open (local)</th>
                        <th className="cell-right">Raw</th>
                        <th className="cell-right">Filtered</th>
                        <th className="cell-right">Symbols (filt.)</th>
                        <th className="cell-right">Mean next %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.timeline?.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="hourly-spikes-empty">
                            No spikes.
                          </td>
                        </tr>
                      ) : (
                        [...(data.timeline ?? [])]
                          .sort((a, b) => b.openTime - a.openTime)
                          .map((t) => (
                            <tr key={t.openTime}>
                              <td className="cell-mono">{fmtTime(t.openTime)}</td>
                              <td className="cell-mono cell-right">{fmtInt(t.rawSpikeCount)}</td>
                              <td className="cell-mono cell-right">
                                {fmtInt(t.filteredSpikeCount)}
                              </td>
                              <td className="cell-mono cell-right">
                                {fmtInt(t.uniqueSymbolCount)}
                              </td>
                              <td className="cell-mono cell-right">
                                {t.meanFilteredNextBodyPct != null &&
                                Number.isFinite(t.meanFilteredNextBodyPct)
                                  ? `${t.meanFilteredNextBodyPct.toFixed(3)}%`
                                  : '—'}
                              </td>
                            </tr>
                          ))
                      )}
                    </tbody>
                  </table>
                </div>
              </section>

              {isUniverse && (
                <section className="hourly-spikes-section">
                  <h2 className="hourly-spikes-h2">Per symbol</h2>
                  <div className="table-wrap hourly-spikes-table-scroll">
                    <table className="positions-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th className="cell-right">24h vol</th>
                          <th className="cell-right">Bars</th>
                          <th className="cell-right">Raw spikes</th>
                          <th className="cell-right">Filtered</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(data.symbolSummaries ?? []).map((r) => (
                          <tr key={r.symbol}>
                            <td className="cell-mono">{r.symbol}</td>
                            <td className="cell-mono cell-right">{fmtInt(r.quoteVolume24h)}</td>
                            <td className="cell-mono cell-right">{fmtInt(r.candleCount)}</td>
                            <td className="cell-mono cell-right">{fmtInt(r.rawSpikes)}</td>
                            <td className="cell-mono cell-right">{fmtInt(r.filteredSpikes)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          {isSingle && Array.isArray(data.spikes) && data.spikes.length > 0 && (
            <div className="table-wrap gpt-bt-table-wrap spike-filter-table-wrap">
              <h2 className="hourly-spikes-h2">Spike detail</h2>
              <table className="positions-table">
                <thead>
                  <tr>
                    <th>Spike time</th>
                    <th>Spike</th>
                    <th className="cell-right">Body %</th>
                    <th className="cell-right">Spike vol</th>
                    <th className="cell-right">Prior trend %</th>
                    <th>Trend OK</th>
                    <th className="cell-right">Vol × avg</th>
                    <th>Vol OK</th>
                    <th>Trade</th>
                    <th>Next</th>
                    <th className="cell-right">Next body %</th>
                  </tr>
                </thead>
                <tbody>
                  {data.spikes.map((r, j) => (
                    <tr
                      key={`${r.spikeOpenTime}-${j}`}
                      className={r.passedFilters ? 'spike-filter-row--trade' : undefined}
                    >
                      <td className="cell-mono">{fmtTime(r.spikeOpenTime)}</td>
                      <td className="cell-mono">{spikeCandleColorLabel(r)}</td>
                      <td className="cell-mono cell-right">
                        {Number.isFinite(r.spikeBodyPct) ? `${r.spikeBodyPct.toFixed(2)}%` : '—'}
                      </td>
                      <td className="cell-mono cell-right">{fmtVol(r.spikeVolume)}</td>
                      <td className="cell-mono cell-right">
                        {r.trendPctPrior != null && Number.isFinite(r.trendPctPrior)
                          ? `${r.trendPctPrior.toFixed(2)}%`
                          : '—'}
                      </td>
                      <td className="cell-mono">
                        {!data.filters?.trendFilterEnabled
                          ? '—'
                          : r.passTrend
                            ? 'pass'
                            : 'fail'}
                      </td>
                      <td className="cell-mono cell-right">
                        {r.volRatio != null && Number.isFinite(r.volRatio)
                          ? `${r.volRatio.toFixed(2)}×`
                          : '—'}
                      </td>
                      <td className="cell-mono">
                        {!data.filters?.volumeRatioFilterEnabled
                          ? '—'
                          : r.passVolRatio
                            ? 'pass'
                            : 'fail'}
                      </td>
                      <td className="cell-mono">{r.passedFilters ? 'yes' : 'no'}</td>
                      <td className="cell-mono">{r.nextIsGreen ? 'green' : 'red'}</td>
                      <td className="cell-mono cell-right">
                        {r.nextBodyPct != null && Number.isFinite(r.nextBodyPct)
                          ? `${r.nextBodyPct.toFixed(2)}%`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {isSingle && Array.isArray(data.spikes) && data.spikes.length === 0 && (
            <p className="hourly-spikes-hint">No spikes matched the body threshold in this range.</p>
          )}

          {isUniverse && (data.summary?.spikeCount ?? 0) === 0 && (
            <p className="hourly-spikes-hint">No spikes found across the universe for this range.</p>
          )}
        </>
      )}
    </div>
  )
}
