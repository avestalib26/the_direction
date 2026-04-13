import { useCallback, useEffect, useMemo, useState } from 'react'

/**
 * Trade flow imbalance over last N agg trades (qty-weighted):
 * TFI = (BuyQty_N - SellQty_N) / (BuyQty_N + SellQty_N) ∈ [-1, 1]
 * Aggressive buy: taker lifts the ask (buyer is not maker).
 * Aggressive sell: taker hits the bid (buyer is maker).
 */
function computeTfi(tradesNewestFirst, windowN) {
  const slice = tradesNewestFirst.slice(0, windowN)
  let buyQty = 0
  let sellQty = 0
  for (const t of slice) {
    if (t.buyerIsMaker) sellQty += t.qty
    else buyQty += t.qty
  }
  const denom = buyQty + sellQty
  const tfi = denom > 0 && Number.isFinite(denom) ? (buyQty - sellQty) / denom : null
  return {
    buyQty,
    sellQty,
    tfi,
    tradeCount: slice.length,
    denom,
  }
}

const SYMBOL = 'RAVEUSDT'
const TRADE_CAP = 150
const TABLE_ROWS = 24
const TFI_WINDOW_OPTIONS = [25, 50, 100]
const TFI_SPARK_MAX = 90
const SSE_URL = '/api/binance/hft-raveusdt-sse'

function eventTimeMs(inner) {
  if (!inner || typeof inner !== 'object') return null
  const t = inner.T ?? inner.E
  const n = typeof t === 'number' ? t : Number.parseInt(String(t), 10)
  return Number.isFinite(n) ? n : null
}

function formatPx(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  const d = abs >= 1 ? 4 : 8
  return n.toLocaleString(undefined, { maximumFractionDigits: d })
}

function formatQty(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 })
}

export function HFT() {
  const [conn, setConn] = useState('connecting')
  const [err, setErr] = useState(null)
  const [tickCount, setTickCount] = useState(0)
  const [lastWireMs, setLastWireMs] = useState(null)
  const [book, setBook] = useState(null)
  const [trades, setTrades] = useState([])
  const [tfiWindow, setTfiWindow] = useState(50)

  const applyTick = useCallback((serverReceivedAt, raw) => {
    setTickCount((c) => c + 1)
    if (!raw || typeof raw !== 'object') return

    const inner = raw.data && typeof raw.data === 'object' ? raw.data : raw
    const ev = inner.e
    const et = eventTimeMs(inner)
    if (et != null && serverReceivedAt != null) {
      setLastWireMs(Math.max(0, serverReceivedAt - et))
    }

    if (ev === 'bookTicker') {
      const bid = parseFloat(inner.b)
      const ask = parseFloat(inner.a)
      setBook({
        bid,
        ask,
        bidQty: parseFloat(inner.B),
        askQty: parseFloat(inner.A),
        eventTime: inner.E,
      })
      return
    }

    if (ev === 'aggTrade') {
      const px = parseFloat(inner.p)
      const qty = parseFloat(inner.q)
      const buyerIsMaker = Boolean(inner.m)
      setTrades((prev) => {
        const row = {
          id: inner.a ?? `${inner.T}-${inner.p}-${inner.q}`,
          price: px,
          qty,
          buyerIsMaker,
          tradeTime: inner.T,
          serverReceivedAt,
        }
        const next = [row, ...prev]
        return next.slice(0, TRADE_CAP)
      })
    }
  }, [])

  useEffect(() => {
    const es = new EventSource(SSE_URL)

    es.onopen = () => {
      setConn('open')
    }

    es.onmessage = (e) => {
      let row
      try {
        row = JSON.parse(e.data)
      } catch {
        return
      }
      if (row.type === 'error') {
        setErr(row.error ?? 'Stream error')
        return
      }
      if (row.type === 'status') {
        if (row.status === 'binance_ws_closed') setConn('closed')
        return
      }
      if (row.type === 'tick' && row.msg) {
        applyTick(row.serverReceivedAt, row.msg)
      }
    }

    es.onerror = () => {
      setConn((c) => (c === 'open' ? 'reconnecting' : 'error'))
    }

    return () => {
      es.close()
    }
  }, [applyTick])

  const midSpread = useMemo(() => {
    if (!book || !Number.isFinite(book.bid) || !Number.isFinite(book.ask)) {
      return { mid: null, spreadBps: null }
    }
    const mid = (book.bid + book.ask) / 2
    if (!Number.isFinite(mid) || mid <= 0) return { mid: null, spreadBps: null }
    const spreadBps = ((book.ask - book.bid) / mid) * 10_000
    return { mid, spreadBps }
  }, [book])

  const tfiStats = useMemo(
    () => computeTfi(trades, tfiWindow),
    [trades, tfiWindow],
  )

  /** TFI after each trade (chronological), under current window — for sparkline */
  const tfiSpark = useMemo(() => {
    if (trades.length < 2) return []
    const oldestFirst = [...trades].reverse()
    const series = []
    for (let i = 0; i < oldestFirst.length; i++) {
      const win = oldestFirst.slice(Math.max(0, i - tfiWindow + 1), i + 1)
      const newestFirst = [...win].reverse()
      const { tfi } = computeTfi(newestFirst, tfiWindow)
      if (tfi != null && Number.isFinite(tfi)) series.push(tfi)
    }
    return series.slice(-TFI_SPARK_MAX)
  }, [trades, tfiWindow])

  const tfiNeedlePct = useMemo(() => {
    if (tfiStats.tfi == null || !Number.isFinite(tfiStats.tfi)) return 50
    return ((tfiStats.tfi + 1) / 2) * 100
  }, [tfiStats.tfi])

  const sparkPoints = useMemo(() => {
    if (tfiSpark.length < 2) return ''
    const w = 100
    const h = 28
    const pad = 2
    const inner = h - 2 * pad
    return tfiSpark
      .map((v, i) => {
        const x = pad + (i / Math.max(1, tfiSpark.length - 1)) * (w - 2 * pad)
        const vv = Number.isFinite(v) ? v : 0
        const y = pad + (1 - (vv + 1) / 2) * inner
        return `${x.toFixed(2)},${y.toFixed(2)}`
      })
      .join(' ')
  }, [tfiSpark])


  return (
    <div className="hft-page">
      <h1 className="hft-page-title">HFT · {SYMBOL}</h1>
      <p className="hft-page-lead">
        Live USDT-M feed (public WebSocket via this app): top-of-book and aggregated
        trades. Wire delay uses Binance event time vs server receive time (rough
        propagation + processing, not your ping to Binance).
      </p>

      <div className="hft-panel">
        <div className="hft-panel-head">
          <span className="hft-pill hft-pill--symbol">{SYMBOL}</span>
          <span
            className={`hft-pill hft-pill--status hft-pill--status-${conn === 'open' ? 'ok' : 'warn'}`}
          >
            {conn}
          </span>
          <span className="hft-meta">
            ticks <strong>{tickCount}</strong>
            {lastWireMs != null && (
              <>
                {' '}
                · last wire ~<strong>{lastWireMs}</strong> ms
              </>
            )}
          </span>
        </div>
        {err && <p className="hft-warn">{err}</p>}

        <section className="hft-tfi" aria-labelledby="hft-tfi-heading">
          <div className="hft-tfi-head">
            <h2 id="hft-tfi-heading" className="hft-tfi-title">
              Trade flow imbalance (TFI)
            </h2>
            <label className="hft-tfi-window">
              <span className="hft-tfi-window-label">Window</span>
              <select
                className="hft-tfi-select"
                value={tfiWindow}
                onChange={(e) => setTfiWindow(Number(e.target.value))}
              >
                {TFI_WINDOW_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    Last {n} trades
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="hft-tfi-formula">
            TFI = (BuyQty<sub>N</sub> − SellQty<sub>N</sub>) / (BuyQty<sub>N</sub> + SellQty
            <sub>N</sub>) — aggressive buys vs sells in the window.
          </p>
          <div className="hft-tfi-readout">
            <div className="hft-tfi-num">
              <span className="hft-tfi-num-label">TFI</span>
              <span
                className={`hft-tfi-num-value ${tfiStats.tfi != null && tfiStats.tfi > 0.05 ? 'hft-tfi-num-value--pos' : ''} ${tfiStats.tfi != null && tfiStats.tfi < -0.05 ? 'hft-tfi-num-value--neg' : ''}`}
              >
                {tfiStats.tfi != null && Number.isFinite(tfiStats.tfi)
                  ? tfiStats.tfi.toFixed(3)
                  : '—'}
              </span>
            </div>
            <dl className="hft-tfi-qty">
              <div>
                <dt>Aggressive buy qty</dt>
                <dd className="hft-mono">{formatQty(tfiStats.buyQty)}</dd>
              </div>
              <div>
                <dt>Aggressive sell qty</dt>
                <dd className="hft-mono">{formatQty(tfiStats.sellQty)}</dd>
              </div>
              <div>
                <dt>In window</dt>
                <dd>
                  {tfiStats.tradeCount} / {tfiWindow} trades
                </dd>
              </div>
            </dl>
          </div>
          <div className="hft-tfi-meter-wrap">
            <div className="hft-tfi-meter-labels">
              <span>Sellers hit bids</span>
              <span>Neutral</span>
              <span>Buyers lift offers</span>
            </div>
            <div className="hft-tfi-meter" role="presentation">
              <div className="hft-tfi-meter-track" />
              <div
                className="hft-tfi-meter-needle"
                style={{ left: `${tfiNeedlePct}%` }}
              />
            </div>
            <div className="hft-tfi-meter-ticks">
              <span>−1</span>
              <span>0</span>
              <span>+1</span>
            </div>
          </div>
          {tfiSpark.length >= 2 && (
            <div className="hft-tfi-spark-wrap">
              <span className="hft-tfi-spark-caption">TFI over time (recent samples)</span>
              <svg
                className="hft-tfi-spark"
                viewBox="0 0 100 28"
                preserveAspectRatio="none"
              >
                <line
                  className="hft-tfi-spark-mid"
                  x1="2"
                  y1="14"
                  x2="98"
                  y2="14"
                />
                <polyline
                  className="hft-tfi-spark-line"
                  fill="none"
                  points={sparkPoints}
                />
              </svg>
            </div>
          )}
          <ul className="hft-tfi-hints">
            <li>
              <strong>Strongly positive</strong> — taker buys dominate (lifting offers).
            </li>
            <li>
              <strong>Strongly negative</strong> — taker sells dominate (hitting bids).
            </li>
            <li>
              If aggressive buys continue but the ask does not give, watch for continuation; if
              buys print and price stalls, possible <strong>absorption</strong>.
            </li>
          </ul>
        </section>

        <div className="hft-book">
          <div className="hft-book-side hft-book-side--bid">
            <span className="hft-book-label">Bid</span>
            <span className="hft-book-price">{formatPx(book?.bid)}</span>
            <span className="hft-book-qty">{formatQty(book?.bidQty)}</span>
          </div>
          <div className="hft-book-mid">
            <span className="hft-book-label">Mid / spread</span>
            <span className="hft-book-price">{formatPx(midSpread.mid)}</span>
            <span className="hft-book-spread">
              {midSpread.spreadBps != null ? `${midSpread.spreadBps.toFixed(2)} bps` : '—'}
            </span>
          </div>
          <div className="hft-book-side hft-book-side--ask">
            <span className="hft-book-label">Ask</span>
            <span className="hft-book-price">{formatPx(book?.ask)}</span>
            <span className="hft-book-qty">{formatQty(book?.askQty)}</span>
          </div>
        </div>

        <div className="hft-table-wrap">
          <table className="hft-table">
            <caption className="hft-table-caption">
              Recent agg trades (last {TABLE_ROWS} shown; TFI uses buffer up to {TRADE_CAP})
            </caption>
            <thead>
              <tr>
                <th scope="col">Time (UTC)</th>
                <th scope="col">Side</th>
                <th scope="col" className="hft-num">
                  Price
                </th>
                <th scope="col" className="hft-num">
                  Qty
                </th>
                <th scope="col" className="hft-num">
                  Wire ms
                </th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 ? (
                <tr>
                  <td colSpan={5} className="hft-table-empty">
                    Waiting for trades…
                  </td>
                </tr>
              ) : (
                trades.slice(0, TABLE_ROWS).map((t) => {
                  const aggressor = t.buyerIsMaker ? 'Sell' : 'Buy'
                  const utc =
                    t.tradeTime != null
                      ? new Date(t.tradeTime).toISOString().slice(11, 23)
                      : '—'
                  const wire =
                    t.tradeTime != null && t.serverReceivedAt != null
                      ? Math.max(0, t.serverReceivedAt - t.tradeTime)
                      : null
                  return (
                    <tr key={t.id}>
                      <td className="hft-mono">{utc}</td>
                      <td>
                        <span
                          className={
                            t.buyerIsMaker ? 'hft-side hft-side--sell' : 'hft-side hft-side--buy'
                          }
                        >
                          {aggressor}
                        </span>
                      </td>
                      <td className="hft-num hft-mono">{formatPx(t.price)}</td>
                      <td className="hft-num hft-mono">{formatQty(t.qty)}</td>
                      <td className="hft-num hft-mono">{wire != null ? wire : '—'}</td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
