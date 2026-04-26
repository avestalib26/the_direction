import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

const START_USD = 100
const GOAL_USD = 100_000

const RATE_PRESETS = [
  { multiplier: 1.01, label: '1%' },
  { multiplier: 1.02, label: '2%' },
  { multiplier: 1.08, label: '8%' },
  { multiplier: 1.1, label: '10%' },
  { multiplier: 1.12, label: '12%' },
]

function parseUsdt(raw) {
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  return Number.isFinite(n) ? n : 0
}

async function fetchTotalAccountWallet() {
  const res = await fetch('/api/binance/total-account-wallet', {
    cache: 'no-store',
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    const err = new Error(
      res.ok
        ? 'Invalid JSON from wallet API'
        : `Request failed (${res.status})`,
    )
    err.httpStatus = res.status
    throw err
  }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`)
    err.code = data.code
    err.httpStatus = res.status
    throw err
  }
  const rawTotal = data.totalWalletBalance
  const total =
    typeof rawTotal === 'number' ? rawTotal : parseFloat(String(rawTotal ?? ''))
  if (!Number.isFinite(total)) {
    throw new Error('Wallet API returned no usable balance')
  }
  return {
    totalWalletBalance: total,
    spotUsdt: parseUsdt(data.spotUsdt),
    futuresUsdt: parseUsdt(data.futuresUsdt),
    fundingUsdt: parseUsdt(data.fundingUsdt),
    fetchedAt: data.fetchedAt ?? null,
  }
}

/** Sum of USDT-M open-position unrealized P&L. Returns null if the request fails. */
async function fetchFuturesUnrealizedSum() {
  const res = await fetch('/api/binance/open-positions', { cache: 'no-store' })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    return null
  }
  const positions = Array.isArray(data.positions) ? data.positions : []
  let sum = 0
  for (const p of positions) {
    const u = parseFloat(p.unRealizedProfit)
    if (Number.isFinite(u)) sum += u
  }
  return sum
}

function formatMoney(n) {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatPct(p) {
  if (!Number.isFinite(p)) return '—'
  return `${p.toFixed(1)}%`
}

function buildCompoundRows(multiplier) {
  const rows = []
  let n = 0
  while (true) {
    const balance = START_USD * multiplier ** n
    const prevBal = n === 0 ? null : START_USD * multiplier ** (n - 1)
    const diff = prevBal == null ? null : balance - prevBal
    rows.push({ step: n, balance, diff })
    if (balance >= GOAL_USD) break
    n += 1
  }
  return rows
}

function currentStepIndex(wallet, rows) {
  if (!Number.isFinite(wallet) || wallet < START_USD) return -1
  let idx = -1
  for (let i = 0; i < rows.length; i++) {
    if (wallet + 1e-8 >= rows[i].balance) idx = i
    else break
  }
  return idx
}

function dollarProgressPct(wallet) {
  if (!Number.isFinite(wallet) || wallet <= START_USD) return 0
  if (wallet >= GOAL_USD) return 100
  const span = GOAL_USD - START_USD
  return Math.min(100, ((wallet - START_USD) / span) * 100)
}

function goalRowIndex(rows) {
  return rows.length > 0 ? rows.length - 1 : 0
}

function Sparkline({ rows, currentIdx, wallet }) {
  const w = 420
  const h = 96
  const pad = 6
  if (rows.length < 2) return null
  const balances = rows.map((r) => r.balance)
  const minB = Math.min(...balances)
  const maxB = Math.max(...balances)
  const spanB = maxB - minB || 1
  const n = rows.length
  const innerW = w - pad * 2
  const innerH = h - pad * 2
  const pts = rows.map((r, i) => {
    const x = pad + (i / (n - 1)) * innerW
    const t = (r.balance - minB) / spanB
    const y = pad + (1 - t) * innerH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = pts.join(' ')
  let markerCx = null
  let markerCy = null
  if (
    currentIdx >= 0 &&
    currentIdx < n &&
    wallet != null &&
    Number.isFinite(wallet) &&
    wallet >= START_USD
  ) {
    const i = Math.min(currentIdx, n - 1)
    const r = rows[i]
    markerCx = pad + (i / (n - 1)) * innerW
    const t = (r.balance - minB) / spanB
    markerCy = pad + (1 - t) * innerH
  }

  return (
    <figure className="the100k-sparkline-figure">
      <figcaption className="the100k-sparkline-cap">
        Ladder curve (theoretical) · <span className="the100k-spark-hint">oldest → newest</span>
      </figcaption>
      <svg
        className="the100k-sparkline-svg"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden
      >
        <polyline
          fill="none"
          stroke="var(--text-heading)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
          points={line}
          opacity="0.85"
        />
        {markerCx != null && markerCy != null && (
          <circle
            cx={markerCx}
            cy={markerCy}
            r="5"
            fill="var(--pnl-pos)"
            stroke="var(--menu-surface)"
            strokeWidth="2"
          />
        )}
      </svg>
    </figure>
  )
}

function ProgressTrack({ wallet }) {
  const pct = dollarProgressPct(wallet)
  const label =
    wallet != null && Number.isFinite(wallet)
      ? formatPct(pct)
      : '—'
  return (
    <div className="the100k-progress">
      <p className="the100k-progress-caption">
        Linear progress from {formatMoney(START_USD)} → {formatMoney(GOAL_USD)} (the ladder uses compound steps separately)
      </p>
      <div className="the100k-progress-labels">
        <span className="the100k-progress-end">{formatMoney(START_USD)}</span>
        <span className="the100k-progress-mid">
          <strong>{label}</strong>
          <span className="the100k-progress-sub"> of the way</span>
        </span>
        <span className="the100k-progress-end">{formatMoney(GOAL_USD)}</span>
      </div>
      <div
        className="the100k-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-label="Progress"
      >
        <div
          className="the100k-progress-fill"
          style={{ width: `${pct}%` }}
        />
        {wallet != null &&
          Number.isFinite(wallet) &&
          wallet >= START_USD &&
          wallet < GOAL_USD && (
            <span
              className="the100k-progress-pin"
              style={{ left: `${pct}%` }}
              title={`${formatMoney(wallet)}`}
            />
          )}
      </div>
    </div>
  )
}

export function The100k() {
  const summaryId = useId()
  const highlightRef = useRef(null)
  const [rateMultiplier, setRateMultiplier] = useState(1.01)
  const [wallet, setWallet] = useState(null)
  /** Sum of USDT-M unrealized P&L; null = not loaded or open-positions failed */
  const [unrealizedTotal, setUnrealizedTotal] = useState(null)
  const [walletBreakdown, setWalletBreakdown] = useState(null)
  const [fetchedAt, setFetchedAt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [errorCode, setErrorCode] = useState(null)

  const ladderRows = useMemo(
    () => buildCompoundRows(rateMultiplier),
    [rateMultiplier],
  )

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setErrorCode(null)
    try {
      const [data, unre] = await Promise.all([
        fetchTotalAccountWallet(),
        fetchFuturesUnrealizedSum(),
      ])
      setWallet(data.totalWalletBalance)
      setUnrealizedTotal(unre)
      setWalletBreakdown({
        spotUsdt: data.spotUsdt,
        futuresUsdt: data.futuresUsdt,
        fundingUsdt: data.fundingUsdt,
      })
      setFetchedAt(data.fetchedAt ?? null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to load wallet'
      const code =
        e && typeof e === 'object' && e.code != null ? e.code : null
      setError(msg)
      setErrorCode(code)
      setWallet(null)
      setUnrealizedTotal(null)
      setWalletBreakdown(null)
      setFetchedAt(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  /** Ladder step reached by stored wallet balances (spot + futures wallet + funding). */
  const walletStepIdx = useMemo(
    () => (wallet == null ? -2 : currentStepIndex(wallet, ladderRows)),
    [wallet, ladderRows],
  )

  /** Ladder step if you mark USDT-M open P&L to wallet (wallet + unrealized). */
  const equityAtMark = useMemo(() => {
    if (wallet == null || unrealizedTotal == null || !Number.isFinite(wallet)) {
      return null
    }
    return wallet + unrealizedTotal
  }, [wallet, unrealizedTotal])

  const equityStepIdx = useMemo(() => {
    if (equityAtMark == null || !Number.isFinite(equityAtMark)) return -2
    return currentStepIndex(equityAtMark, ladderRows)
  }, [equityAtMark, ladderRows])

  const dollarsToGo = useMemo(() => {
    if (wallet == null || !Number.isFinite(wallet)) return null
    if (wallet >= GOAL_USD) return 0
    return Math.max(0, GOAL_USD - wallet)
  }, [wallet])

  const progressPct = useMemo(
    () => (wallet != null ? dollarProgressPct(wallet) : 0),
    [wallet],
  )

  const nextMilestone = useMemo(() => {
    if (wallet == null || !Number.isFinite(wallet)) return null
    if (wallet >= GOAL_USD) {
      return { kind: 'done' }
    }
    if (walletStepIdx < 0) {
      return {
        kind: 'below',
        target: START_USD,
        gap: START_USD - wallet,
      }
    }
    const nextRow = ladderRows[walletStepIdx + 1]
    if (!nextRow) {
      return { kind: 'done' }
    }
    return {
      kind: 'next',
      step: nextRow.step,
      target: nextRow.balance,
      gap: Math.max(0, nextRow.balance - wallet),
    }
  }, [wallet, walletStepIdx, ladderRows])

  const rateLabel =
    RATE_PRESETS.find((r) => r.multiplier === rateMultiplier)?.label ?? 'Custom'

  const stepsLeftCompound = useMemo(() => {
    if (wallet == null || !Number.isFinite(wallet)) return null
    if (wallet >= GOAL_USD) return 0
    const g = goalRowIndex(ladderRows)
    if (walletStepIdx < 0) return g
    return Math.max(0, g - walletStepIdx)
  }, [wallet, walletStepIdx, ladderRows])

  useEffect(() => {
    if (walletStepIdx < 0) return
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        highlightRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      })
    })
    return () => cancelAnimationFrame(id)
  }, [walletStepIdx, loading, rateMultiplier, wallet, ladderRows.length])

  return (
    <div className="the100k">
      <div className="the100k-toolbar">
        <button
          type="button"
          className="btn-refresh"
          onClick={load}
          disabled={loading}
        >
          {loading ? '…' : 'Refresh'}
        </button>
      </div>

      <div className="the100k-sticky-summary">
        <section
          className="the100k-summary"
          aria-labelledby={summaryId}
        >
          <h1 className="the100k-title" id={summaryId}>
            The 100k
          </h1>
          <p className="the100k-intro">
            Compound ladder from {formatMoney(START_USD)} to {formatMoney(GOAL_USD)}. Each step
            multiplies the <strong>previous balance</strong> by your rate — not a fixed slice of
            the original {formatMoney(START_USD)} every time.
          </p>

          <div className="the100k-rate-control">
            <span className="the100k-rate-label">Compound per step (what-if)</span>
            <div className="the100k-rate-buttons" role="group" aria-label="Compound per step">
              {RATE_PRESETS.map((p) => (
                <button
                  key={p.multiplier}
                  type="button"
                  className={`the100k-rate-btn ${rateMultiplier === p.multiplier ? 'the100k-rate-btn--active' : ''}`}
                  onClick={() => setRateMultiplier(p.multiplier)}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="the100k-rate-hint">
              Changing the rate rebuilds the whole ladder in your browser. Your live balance
              below uses spot + USDT-M futures + funding USDT.
            </p>
          </div>

          {error && (
            <div
              className={`the100k-wallet-error ${errorCode === 'BINANCE_GEO_BLOCKED' ? 'the100k-wallet-error--geo' : ''}`}
              role="alert"
            >
              <p className="the100k-error-title">
                {errorCode === 'BINANCE_GEO_BLOCKED'
                  ? 'Wallet unavailable (region)'
                  : 'Could not load wallet'}
              </p>
              <p className="the100k-error-body">{error}</p>
            </div>
          )}

          {!error && loading && <p className="the100k-wallet-line">…</p>}

          {!error && !loading && wallet != null && (
            <>
              <p className="the100k-wallet-line the100k-wallet-line--emph">
                <strong className="the100k-balance-total">
                  {formatMoney(wallet)} USDT
                </strong>
                <span className="the100k-wallet-tag"> total (spot · futures · funding)</span>
              </p>
              {walletBreakdown && (
                <p className="the100k-wallet-line the100k-wallet-breakdown">
                  <span className="cell-mono">
                    {formatMoney(walletBreakdown.spotUsdt)}
                  </span>
                  {' · '}
                  <span className="cell-mono">
                    {formatMoney(walletBreakdown.futuresUsdt)}
                  </span>
                  {' · '}
                  <span className="cell-mono">
                    {formatMoney(walletBreakdown.fundingUsdt)}
                  </span>
                </p>
              )}
              {fetchedAt && (
                <p className="the100k-fetched-at">
                  Updated {new Date(fetchedAt).toLocaleString()}
                </p>
              )}
              {unrealizedTotal != null && (
                <p className="the100k-wallet-line the100k-unrealized">
                  <span className="the100k-unrealized-label">USDT-M unrealized P&amp;L</span>{' '}
                  <strong
                    className={`cell-mono ${unrealizedTotal >= 0 ? 'the100k-unrealized--pos' : 'the100k-unrealized--neg'}`}
                  >
                    {unrealizedTotal >= 0 ? '+' : ''}
                    {formatMoney(unrealizedTotal)} USDT
                  </strong>
                  {equityAtMark != null && (
                    <span className="the100k-unrealized-mark">
                      {' '}
                      · mark-to-market ≈ <span className="cell-mono">{formatMoney(equityAtMark)}</span>
                    </span>
                  )}
                </p>
              )}
            </>
          )}

          {wallet != null && Number.isFinite(wallet) && (
            <>
              <aside className="the100k-motivate" aria-label="Progress motivation">
                {wallet >= GOAL_USD ? (
                  <p className="the100k-motivate-lead the100k-motivate-lead--done">
                    <strong>You’ve crossed {formatMoney(GOAL_USD)}</strong> on this ladder at{' '}
                    <strong>{rateLabel}</strong> per step. That’s the line you were chasing.
                  </p>
                ) : (
                  <>
                    <p className="the100k-motivate-kicker">Keep going</p>
                    {walletStepIdx >= 0 && stepsLeftCompound != null && (
                      <p className="the100k-motivate-lead">
                        You’re on <strong>step {walletStepIdx}</strong> of this ladder.{' '}
                        <strong>
                          {stepsLeftCompound} compound {stepsLeftCompound === 1 ? 'step' : 'steps'}
                        </strong>{' '}
                        still stand between here and{' '}
                        <strong>{formatMoney(GOAL_USD)}</strong> — at <strong>{rateLabel}</strong>{' '}
                        per hop, one rung at a time.
                      </p>
                    )}
                    {walletStepIdx < 0 && nextMilestone?.kind === 'below' && (
                      <p className="the100k-motivate-lead">
                        Add <strong>{formatMoney(nextMilestone.gap)} USDT</strong> to reach the
                        first rung ({formatMoney(START_USD)}). Then{' '}
                        <strong>
                          {stepsLeftCompound ?? 0} compound{' '}
                          {(stepsLeftCompound ?? 0) === 1 ? 'step' : 'steps'}
                        </strong>{' '}
                        at <strong>{rateLabel}</strong> separate you from{' '}
                        <strong>{formatMoney(GOAL_USD)}</strong> on this ladder.
                      </p>
                    )}
                    {nextMilestone?.kind === 'next' && (
                      <p className="the100k-motivate-next">
                        Next rung: only <strong>{formatMoney(nextMilestone.gap)} USDT</strong> to
                        cross step {nextMilestone.step} (
                        <strong>{formatMoney(nextMilestone.target)}</strong>). Small clip, same
                        rules — stack the wins.
                      </p>
                    )}
                    {nextMilestone?.kind === 'below' && (
                      <p className="the100k-motivate-next">
                        Straight-line gap to $100k:{' '}
                        <strong>{dollarsToGo != null ? formatMoney(dollarsToGo) : '—'} USDT</strong>{' '}
                        (the bar above). The ladder counts compound steps; both matter.
                      </p>
                    )}
                    {nextMilestone?.kind === 'next' && dollarsToGo != null && (
                      <p className="the100k-motivate-foot">
                        About <strong>{formatMoney(dollarsToGo)} USDT</strong> to go until{' '}
                        {formatMoney(GOAL_USD)} in account terms — stay patient and selective.
                      </p>
                    )}
                  </>
                )}
              </aside>

              <ProgressTrack wallet={wallet} />

              <div className="the100k-metrics-grid">
                <div className="the100k-metric the100k-metric--accent">
                  <span className="the100k-metric-label">Journey (linear)</span>
                  <span className="the100k-metric-value">{formatPct(progressPct)}</span>
                  <span className="the100k-metric-hint">
                    from {formatMoney(START_USD)} → {formatMoney(GOAL_USD)} scale
                  </span>
                </div>
                <div className="the100k-metric">
                  <span className="the100k-metric-label">USDT to $100k</span>
                  <span className="the100k-metric-value">
                    {dollarsToGo != null ? formatMoney(dollarsToGo) : '—'}
                  </span>
                  <span className="the100k-metric-hint">raw dollars left</span>
                </div>
                <div className="the100k-metric">
                  <span className="the100k-metric-label">Next rung gap</span>
                  <span className="the100k-metric-value the100k-metric-value--small">
                    {nextMilestone?.kind === 'done' && '—'}
                    {nextMilestone?.kind === 'below' && (
                      <><strong>{formatMoney(nextMilestone.gap)}</strong> USDT</>
                    )}
                    {nextMilestone?.kind === 'next' && (
                      <>
                        <strong>{formatMoney(nextMilestone.gap)}</strong> USDT → step{' '}
                        {nextMilestone.step}
                      </>
                    )}
                  </span>
                  <span className="the100k-metric-hint">to next ladder balance</span>
                </div>
              </div>

              <Sparkline
                rows={ladderRows}
                currentIdx={walletStepIdx >= 0 ? walletStepIdx : -1}
                wallet={wallet}
              />
            </>
          )}

        </section>
      </div>

      <section className="the100k-table-section" aria-label="Ladder table">
        <h2 className="the100k-table-heading">Compound ladder</h2>
        <p className="the100k-table-lead">
          Every row is one compound hop at <strong>{rateLabel}</strong>.{' '}
          <span className="the100k-legend-inline">
            <span className="the100k-legend-swatch the100k-legend-swatch--wallet" /> Wallet
            balance (spot + futures wallet + funding)
          </span>
          {unrealizedTotal != null && (
            <>
              {' '}
              <span className="the100k-legend-inline">
                <span className="the100k-legend-swatch the100k-legend-swatch--equity" /> Wallet
                + USDT-M unrealized (mark-to-market)
              </span>
            </>
          )}
          . The table scrolls to the wallet row.
        </p>
        <div className="table-wrap the100k-table-wrap the100k-table-scroll">
          <table className="positions-table the100k-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Bal</th>
                <th>Δ</th>
              </tr>
            </thead>
            <tbody>
              {ladderRows.map((r) => {
                const isWallet = walletStepIdx >= 0 && r.step === walletStepIdx
                const isEquity =
                  unrealizedTotal != null && equityStepIdx >= 0 && r.step === equityStepIdx
                const rowClass = [
                  'the100k-row',
                  isWallet ? 'the100k-row--wallet' : '',
                  isEquity ? 'the100k-row--equity' : '',
                ]
                  .filter(Boolean)
                  .join(' ')
                return (
                  <tr
                    key={`${rateMultiplier}-${r.step}`}
                    ref={isWallet ? highlightRef : undefined}
                    className={rowClass}
                    aria-label={
                      [isWallet && 'Wallet balance rung', isEquity && 'Mark-to-market rung']
                        .filter(Boolean)
                        .join(' · ') || undefined
                    }
                  >
                    <td className="cell-mono">{r.step}</td>
                    <td className="cell-mono">{formatMoney(r.balance)}</td>
                    <td className="cell-mono">
                      {r.diff == null ? '—' : formatMoney(r.diff)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  )
}
