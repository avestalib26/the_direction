import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'

const START_USD = 6
const GOAL_USD = 100_000
const STEP_RATE = 1.1

async function fetchFuturesWallet() {
  const res = await fetch('/api/binance/futures-wallet', {
    cache: 'no-store',
  })
  const text = await res.text()
  let data = {}
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(
      res.ok
        ? 'Invalid JSON from wallet API'
        : `Request failed (${res.status})`,
    )
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  const raw = data.totalWalletBalance
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''))
  if (!Number.isFinite(n)) {
    throw new Error('Wallet API returned no usable balance')
  }
  return { ...data, totalWalletBalance: n }
}

function formatMoney(n) {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function buildCompoundRows() {
  const rows = []
  let n = 0
  while (true) {
    const balance = START_USD * STEP_RATE ** n
    const prevBal = n === 0 ? null : START_USD * STEP_RATE ** (n - 1)
    const diff = prevBal == null ? null : balance - prevBal
    rows.push({ step: n, balance, diff })
    if (balance >= GOAL_USD) break
    n += 1
  }
  return rows
}

const LADDER_ROWS = buildCompoundRows()

function currentStepIndex(wallet, rows) {
  if (!Number.isFinite(wallet) || wallet < START_USD) return -1
  let idx = -1
  for (let i = 0; i < rows.length; i++) {
    if (wallet + 1e-8 >= rows[i].balance) idx = i
    else break
  }
  return idx
}

function goalStepIndex(rows) {
  return rows.findIndex((r) => r.balance >= GOAL_USD)
}

export function The100k() {
  const summaryId = useId()
  const highlightRef = useRef(null)
  const [wallet, setWallet] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchFuturesWallet()
      setWallet(data.totalWalletBalance)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load wallet')
      setWallet(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const goalIdx = useMemo(() => goalStepIndex(LADDER_ROWS), [])
  const currentIdx = useMemo(
    () => (wallet == null ? -2 : currentStepIndex(wallet, LADDER_ROWS)),
    [wallet],
  )

  const stepsToGoal = useMemo(() => {
    if (wallet == null || !Number.isFinite(wallet)) return null
    if (wallet >= GOAL_USD) return 0
    if (currentIdx < 0) return null
    return Math.max(0, goalIdx - currentIdx)
  }, [wallet, currentIdx, goalIdx])

  useEffect(() => {
    if (currentIdx < 0 || !highlightRef.current) return
    highlightRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [currentIdx, loading])

  return (
    <div className="the100k">
      <div className="the100k-toolbar">
        <button
          type="button"
          className="btn-refresh"
          onClick={load}
          disabled={loading}
        >
          {loading ? 'Refreshing…' : 'Refresh wallet'}
        </button>
      </div>

      <section
        className="the100k-summary"
        aria-labelledby={summaryId}
      >
        <h1 className="the100k-title" id={summaryId}>
          The 100k
        </h1>
        {error && (
          <p className="the100k-wallet-error" role="alert">
            {error}
          </p>
        )}
        {!error && loading && (
          <p className="the100k-wallet-line">Loading wallet…</p>
        )}
        {!error && !loading && wallet != null && (
          <p className="the100k-wallet-line">
            Futures wallet:{' '}
            <span className="cell-mono">{formatMoney(wallet)} USDT</span>
          </p>
        )}
        {wallet != null && Number.isFinite(wallet) && (
          <div className="the100k-steps-callout">
            {wallet >= GOAL_USD ? (
              <p className="the100k-steps-main">
                You are at or past <strong>$100,000</strong> on this ladder.
              </p>
            ) : currentIdx < 0 ? (
              <p className="the100k-steps-main">
                Below the <strong>$6</strong> starting step. The ladder needs{' '}
                <span className="cell-mono">{goalIdx}</span> compound steps from
                $6 to reach <strong>$100,000</strong> (see table).
              </p>
            ) : (
              <p className="the100k-steps-main">
                You are at <strong>step {currentIdx}</strong> (balance ≥{' '}
                {formatMoney(LADDER_ROWS[currentIdx].balance)} USDT).{' '}
                <strong>{stepsToGoal}</strong> compound step
                {stepsToGoal === 1 ? '' : 's'} left to hit{' '}
                <strong>$100,000</strong> on this ladder.
              </p>
            )}
          </div>
        )}
        <p className="the100k-legend">
          Wallet = <strong>USDT-M futures</strong> only (not spot). Table: start{' '}
          <strong>$6</strong>, then <strong>+10%</strong> each row.
          <strong> Step diff</strong> is the dollar gain from the previous row.
        </p>
      </section>

      <div className="table-wrap the100k-table-wrap">
        <table className="positions-table the100k-table">
          <thead>
            <tr>
              <th>Step</th>
              <th>Balance (USDT)</th>
              <th>Step diff (USDT)</th>
            </tr>
          </thead>
          <tbody>
            {LADDER_ROWS.map((r) => {
              const isCurrent = currentIdx >= 0 && r.step === currentIdx
              return (
                <tr
                  key={r.step}
                  ref={isCurrent ? highlightRef : undefined}
                  className={
                    isCurrent ? 'the100k-row the100k-row--current' : 'the100k-row'
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
    </div>
  )
}
