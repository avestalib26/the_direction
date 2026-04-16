import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { MarketBreadth } from './MarketBreadth'
import { GptBacktest } from './GptBacktest'
import { SpikeTpSlBacktest } from './SpikeTpSlBacktest'
import { SpikeTpSlBacktestV3 } from './SpikeTpSlBacktestV3'
import { The100k } from './The100k'
import { TradeHistory } from './TradeHistory'
import { Emotions } from './Emotions'
import { EmotionsErrorBoundary } from './EmotionsErrorBoundary'
import { MlDatasetPrep } from './MlDatasetPrep'
import { Agent1 } from './Agent1'
import { Agent2 } from './Agent2'
import { LongSim5m } from './LongSim5m'
import { TestPage } from './TestPage'
import './App.css'

const APP_VIEW_STORAGE_KEY = 'app.activeView'
const APP_VIEWS = new Set([
  'home',
  'the100k',
  'breadth',
  'history',
  'emotions',
  'mldataset',
  'gptbacktest',
  'spiketpsl',
  'spiketpslv3',
  'agent1',
  'agent2',
  'longsim5m',
  'testpage',
])

async function fetchOpenPositions() {
  const res = await fetch('/api/binance/open-positions')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

async function fetchFuturesWallet() {
  const res = await fetch('/api/binance/futures-wallet')
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`)
  }
  return data
}

function App() {
  const [view, setView] = useState(() => {
    if (typeof window === 'undefined') return 'home'
    const saved = String(window.localStorage.getItem(APP_VIEW_STORAGE_KEY) ?? '').trim()
    return APP_VIEWS.has(saved) ? saved : 'home'
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const menuId = useId()
  const [positions, setPositions] = useState(null)
  const [walletBalance, setWalletBalance] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [maxTradeSizePct, setMaxTradeSizePct] = useState('4')
  const [maxNegPnlPct, setMaxNegPnlPct] = useState('500')
  const [maxOpenPositions, setMaxOpenPositions] = useState('10')
  const [maxTotalPositionSize, setMaxTotalPositionSize] = useState('0')
  /** null = loading; master on/off persisted in Supabase (header toggle). */
  const [agent1MasterEnabled, setAgent1MasterEnabled] = useState(null)
  const [agent1MasterSaving, setAgent1MasterSaving] = useState(false)
  const [agent2MasterEnabled, setAgent2MasterEnabled] = useState(null)
  const [agent2MasterSaving, setAgent2MasterSaving] = useState(false)
  const [agent2TradingEnabled, setAgent2TradingEnabled] = useState(null)
  const [agent2TradingSaving, setAgent2TradingSaving] = useState(false)

  const loadPositions = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, wallet] = await Promise.all([
        fetchOpenPositions(),
        fetchFuturesWallet().catch(() => null),
      ])
      setPositions(data.positions ?? [])
      const wb = parseFloat(wallet?.totalWalletBalance)
      setWalletBalance(Number.isFinite(wb) ? wb : null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load positions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (view !== 'home') return
    loadPositions()
  }, [view, loadPositions])

  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
  }, [menuOpen])

  const go = (next) => {
    setView(next)
    setMenuOpen(false)
  }

  useEffect(() => {
    if (typeof window === 'undefined') return
    if (!APP_VIEWS.has(view)) return
    window.localStorage.setItem(APP_VIEW_STORAGE_KEY, view)
  }, [view])

  const BACKTEST_VIEWS = [
    'gptbacktest',
    'spiketpsl',
    'spiketpslv3',
  ]
  const isBacktestView = BACKTEST_VIEWS.includes(view)
  const [backtestMenuOpen, setBacktestMenuOpen] = useState(isBacktestView)

  useEffect(() => {
    if (isBacktestView) setBacktestMenuOpen(true)
  }, [view, isBacktestView])

  const AGENTS_VIEWS = ['agent1', 'agent2', 'longsim5m']
  const isAgentsView = AGENTS_VIEWS.includes(view)
  const [agentsMenuOpen, setAgentsMenuOpen] = useState(isAgentsView)

  useEffect(() => {
    if (isAgentsView) setAgentsMenuOpen(true)
  }, [view, isAgentsView])

  useEffect(() => {
    if (view !== 'agent1') return
    let cancelled = false
    setAgent1MasterEnabled(null)
    ;(async () => {
      try {
        const res = await fetch('/api/agents/agent1/settings', { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || String(res.status))
        setAgent1MasterEnabled(data.settings?.agentEnabled !== false)
      } catch {
        if (!cancelled) setAgent1MasterEnabled(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view])

  useEffect(() => {
    if (view !== 'agent2') return
    let cancelled = false
    setAgent2MasterEnabled(null)
    ;(async () => {
      try {
        const res = await fetch('/api/agents/agent2/settings', { cache: 'no-store' })
        const data = await res.json().catch(() => ({}))
        if (cancelled) return
        if (!res.ok) throw new Error(data.error || String(res.status))
        setAgent2MasterEnabled(data.settings?.agentEnabled === true)
      } catch {
        if (!cancelled) setAgent2MasterEnabled(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [view])

  useEffect(() => {
    const onA2 = () => {
      if (view !== 'agent2') return
      void (async () => {
        try {
          const res = await fetch('/api/agents/agent2/settings', { cache: 'no-store' })
          const data = await res.json().catch(() => ({}))
          if (res.ok) {
            setAgent2MasterEnabled(data.settings?.agentEnabled === true)
            setAgent2TradingEnabled(data.settings?.tradingEnabled === true)
          }
        } catch {
          /* */
        }
      })()
    }
    window.addEventListener('agent2-settings-changed', onA2)
    return () => window.removeEventListener('agent2-settings-changed', onA2)
  }, [view])

  const requestAgent1MasterToggle = useCallback(async () => {
    if (agent1MasterEnabled == null || agent1MasterSaving) return
    const next = !agent1MasterEnabled
    const ok = window.confirm(
      next
        ? 'Turn Agent 1 ON? The server will run scheduled 5m spike scans when the API scheduler is enabled.'
        : 'Turn Agent 1 OFF? Scheduled spike scans will stop until you turn the agent on again.',
    )
    if (!ok) return
    setAgent1MasterSaving(true)
    try {
      const res = await fetch('/api/agents/agent1/enabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setAgent1MasterEnabled(data.settings?.agentEnabled !== false)
      window.dispatchEvent(new Event('agent1-enabled-changed'))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to update Agent1')
    } finally {
      setAgent1MasterSaving(false)
    }
  }, [agent1MasterEnabled, agent1MasterSaving])

  const requestAgent2MasterToggle = useCallback(async () => {
    if (agent2MasterEnabled == null || agent2MasterSaving) return
    const next = !agent2MasterEnabled
    const ok = window.confirm(
      next
        ? 'Turn Agent 2 ON? Enable signal scan and/or trading on the Agent 2 page when ready.'
        : 'Turn Agent 2 OFF? Pending entry orders will be canceled on the next execution tick.',
    )
    if (!ok) return
    setAgent2MasterSaving(true)
    try {
      const res = await fetch('/api/agents/agent2/enabled', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setAgent2MasterEnabled(data.settings?.agentEnabled === true)
      window.dispatchEvent(new Event('agent2-settings-changed'))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to update Agent 2')
    } finally {
      setAgent2MasterSaving(false)
    }
  }, [agent2MasterEnabled, agent2MasterSaving])

  const requestAgent2TradingToggle = useCallback(async () => {
    if (agent2TradingEnabled == null || agent2TradingSaving) return
    const next = !agent2TradingEnabled
    if (next && agent2MasterEnabled !== true) {
      window.alert('Turn Agent 2 master on first, then you can enable trading.')
      return
    }
    setAgent2TradingSaving(true)
    try {
      const res = await fetch('/api/agents/agent2/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tradingEnabled: next }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`)
      setAgent2TradingEnabled(data.settings?.tradingEnabled === true)
      window.dispatchEvent(new Event('agent2-settings-changed'))
    } catch (e) {
      window.alert(e instanceof Error ? e.message : 'Failed to update trading')
    } finally {
      setAgent2TradingSaving(false)
    }
  }, [agent2MasterEnabled, agent2TradingEnabled, agent2TradingSaving])

  const totalOpenPnl = useMemo(() => {
    if (!positions?.length) return null
    let s = 0
    for (const p of positions) {
      const n = parseFloat(p.unRealizedProfit)
      if (Number.isFinite(n)) s += n
    }
    return s
  }, [positions])

  const risk = useMemo(() => {
    const tradePct = Number.parseFloat(String(maxTradeSizePct))
    const negPnlPct = Number.parseFloat(String(maxNegPnlPct))
    const openMax = Number.parseInt(String(maxOpenPositions), 10)
    const totalMax = Number.parseFloat(String(maxTotalPositionSize))

    const tradePctSafe = Number.isFinite(tradePct) && tradePct > 0 ? tradePct : 0
    const negPnlPctSafe = Number.isFinite(negPnlPct) && negPnlPct > 0 ? negPnlPct : 0
    const openMaxSafe = Number.isFinite(openMax) && openMax >= 0 ? openMax : 0
    const totalMaxSafe = Number.isFinite(totalMax) && totalMax > 0 ? totalMax : 0

    const maxTradeUsd =
      Number.isFinite(walletBalance) && tradePctSafe > 0
        ? walletBalance * (tradePctSafe / 100)
        : null

    let totalPositionUsd = 0
    let largestPositionUsd = 0
    for (const p of positions ?? []) {
      const sz = absPositionSizeUsd(p)
      if (!Number.isFinite(sz)) continue
      totalPositionUsd += sz
      if (sz > largestPositionUsd) largestPositionUsd = sz
    }

    const posCount = positions?.length ?? 0
    return {
      tradePct: tradePctSafe,
      negPnlPct: negPnlPctSafe,
      openMax: openMaxSafe,
      totalMax: totalMaxSafe,
      maxTradeUsd,
      totalPositionUsd,
      largestPositionUsd,
      posCount,
      openBreach: openMaxSafe > 0 && posCount > openMaxSafe,
      totalSizeBreach: totalMaxSafe > 0 && totalPositionUsd > totalMaxSafe,
      largestTradeBreach:
        Number.isFinite(maxTradeUsd) && largestPositionUsd > maxTradeUsd,
    }
  }, [
    maxTradeSizePct,
    maxNegPnlPct,
    maxOpenPositions,
    maxTotalPositionSize,
    positions,
    walletBalance,
  ])

  /** Highest unrealized PnL first (then symbol for ties). */
  const positionsByUnrealized = useMemo(() => {
    if (!positions?.length) return []
    return [...positions].sort((a, b) => {
      const na = parseFloat(a.unRealizedProfit)
      const nb = parseFloat(b.unRealizedProfit)
      const va = Number.isFinite(na) ? na : 0
      const vb = Number.isFinite(nb) ? nb : 0
      if (vb !== va) return vb - va
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? ''))
    })
  }, [positions])

  return (
    <div className="layout">
      <header
        className={`top-bar ${view === 'agent1' || view === 'agent2' || view === 'longsim5m' ? 'top-bar--agent1' : ''}`}
      >
        <button
          type="button"
          className="hamburger"
          aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => setMenuOpen((o) => !o)}
        >
          <span className="hamburger-line" aria-hidden />
          <span className="hamburger-line" aria-hidden />
          <span className="hamburger-line" aria-hidden />
        </button>
        {view === 'agent1' && (
          <>
            <h1 className="top-bar-title">Agent 1</h1>
            <div className="top-bar-agent1-actions">
              <button
                type="button"
                className={`agent1-master-toggle ${agent1MasterEnabled ? 'agent1-master-toggle--on' : 'agent1-master-toggle--off'}`}
                onClick={() => requestAgent1MasterToggle()}
                disabled={agent1MasterEnabled == null || agent1MasterSaving}
                aria-pressed={agent1MasterEnabled === true}
                title={
                  agent1MasterEnabled
                    ? 'Agent is ON — click to turn OFF (confirmation)'
                    : 'Agent is OFF — click to turn ON (confirmation)'
                }
              >
                <span className="agent1-master-toggle__track" aria-hidden />
                <span className="agent1-master-toggle__thumb" aria-hidden />
                <span className="agent1-master-toggle__text">
                  {agent1MasterSaving ? '…' : agent1MasterEnabled ? 'On' : 'Off'}
                </span>
              </button>
            </div>
          </>
        )}
        {view === 'agent2' && (
          <>
            <h1 className="top-bar-title">Agent 2</h1>
            <div className="top-bar-agent1-actions">
              <button
                type="button"
                className={`agent1-master-toggle ${agent2MasterEnabled ? 'agent1-master-toggle--on' : 'agent1-master-toggle--off'}`}
                onClick={() => requestAgent2MasterToggle()}
                disabled={agent2MasterEnabled == null || agent2MasterSaving}
                aria-label="Agent 2 master switch"
                aria-pressed={agent2MasterEnabled === true}
                title={
                  agent2MasterEnabled
                    ? 'Master ON — click to turn OFF'
                    : 'Master OFF — click to turn ON'
                }
              >
                <span className="agent1-master-toggle__track" aria-hidden />
                <span className="agent1-master-toggle__thumb" aria-hidden />
                <span className="agent1-master-toggle__text">
                  {agent2MasterSaving ? '…' : agent2MasterEnabled ? 'Master on' : 'Master off'}
                </span>
              </button>
              <button
                type="button"
                className={`agent1-master-toggle ${agent2TradingEnabled ? 'agent1-master-toggle--on' : 'agent1-master-toggle--off'}`}
                onClick={() => requestAgent2TradingToggle()}
                disabled={
                  agent2TradingEnabled == null ||
                  agent2TradingSaving ||
                  (agent2TradingEnabled === false && agent2MasterEnabled !== true)
                }
                aria-label="Agent 2 trading switch"
                aria-pressed={agent2TradingEnabled === true}
                title={
                  agent2TradingEnabled === false && agent2MasterEnabled !== true
                    ? 'Enable master first to turn trading on'
                    : agent2TradingEnabled
                      ? 'Trading ON — click to turn OFF'
                      : 'Trading OFF — click to turn ON'
                }
              >
                <span className="agent1-master-toggle__track" aria-hidden />
                <span className="agent1-master-toggle__thumb" aria-hidden />
                <span className="agent1-master-toggle__text">
                  {agent2TradingSaving ? '…' : agent2TradingEnabled ? 'Trading on' : 'Trading off'}
                </span>
              </button>
            </div>
          </>
        )}
        {view === 'longsim5m' && <h1 className="top-bar-title">5m long simulation</h1>}
      </header>

      {menuOpen && (
        <button
          type="button"
          className="menu-backdrop"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <nav
        id={menuId}
        className={`menu-panel ${menuOpen ? 'menu-panel--open' : ''}`}
        aria-hidden={!menuOpen}
        inert={!menuOpen}
      >
        <ul className="menu-list">
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'home' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('home')
              }}
            >
              Home
            </a>
          </li>
          <li className="menu-item--submenu">
            <details
              className="menu-details"
              open={agentsMenuOpen}
              onToggle={(e) => setAgentsMenuOpen(e.currentTarget.open)}
            >
              <summary
                className={`menu-details-summary ${isAgentsView ? 'menu-details-summary--active' : ''}`}
              >
                Agents
              </summary>
              <ul className="menu-sublist">
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'agent1' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('agent1')
                    }}
                  >
                    Agent 1
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'agent2' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('agent2')
                    }}
                  >
                    Agent 2
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'longsim5m' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('longsim5m')
                    }}
                  >
                    5m long simulation
                  </a>
                </li>
              </ul>
            </details>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'testpage' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('testpage')
              }}
            >
              Test Page
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'the100k' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('the100k')
              }}
            >
              The 100k
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'breadth' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('breadth')
              }}
            >
              Market breadth
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'history' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('history')
              }}
            >
              Trade history
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'emotions' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('emotions')
              }}
            >
              Emotions
            </a>
          </li>
          <li>
            <a
              href="#"
              className={`menu-link ${view === 'mldataset' ? 'menu-link--active' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                go('mldataset')
              }}
            >
              ML dataset
            </a>
          </li>
          <li className="menu-item--submenu">
            <details
              className="menu-details"
              open={backtestMenuOpen}
              onToggle={(e) => setBacktestMenuOpen(e.currentTarget.open)}
            >
              <summary
                className={`menu-details-summary ${isBacktestView ? 'menu-details-summary--active' : ''}`}
              >
                Backtest
              </summary>
              <ul className="menu-sublist">
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'gptbacktest' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('gptbacktest')
                    }}
                  >
                    GPT backtest
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spiketpsl' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spiketpsl')
                    }}
                  >
                    Spike 2R backtest
                  </a>
                </li>
                <li>
                  <a
                    href="#"
                    className={`menu-link menu-sublink ${view === 'spiketpslv3' ? 'menu-link--active' : ''}`}
                    onClick={(e) => {
                      e.preventDefault()
                      go('spiketpslv3')
                    }}
                  >
                    2R backtest v3
                  </a>
                </li>
              </ul>
            </details>
          </li>
        </ul>
      </nav>

      <main
        className={`app ${view === 'breadth' || view === 'history' || view === 'emotions' || view === 'mldataset' || view === 'the100k' || view === 'gptbacktest' || view === 'spiketpsl' || view === 'spiketpslv3' || view === 'agent1' || view === 'agent2' || view === 'longsim5m' || view === 'testpage' ? 'app--breadth' : ''} ${view === 'agent1' || view === 'agent2' || view === 'longsim5m' ? 'app--agent1' : ''}`}
        id="main"
      >
        {view === 'home' && (
          <>
            <div className="home-toolbar">
              <button
                type="button"
                className="btn-refresh"
                onClick={loadPositions}
                disabled={loading}
              >
                {loading ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>

            <section className="risk-panel" aria-label="Risk controls">
              <div className="risk-form">
                <label className="backtest1-field">
                  <span className="backtest1-label">Max trade size (% of account)</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={0.1}
                    value={maxTradeSizePct}
                    onChange={(e) => setMaxTradeSizePct(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max negative PnL % (position)</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={1}
                    value={maxNegPnlPct}
                    onChange={(e) => setMaxNegPnlPct(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max open positions</span>
                  <input
                    type="number"
                    className="backtest1-input backtest1-input--narrow"
                    min={0}
                    step={1}
                    value={maxOpenPositions}
                    onChange={(e) => setMaxOpenPositions(e.target.value)}
                  />
                </label>
                <label className="backtest1-field">
                  <span className="backtest1-label">Max total position size (USDT)</span>
                  <input
                    type="number"
                    className="backtest1-input"
                    min={0}
                    step={1}
                    value={maxTotalPositionSize}
                    onChange={(e) => setMaxTotalPositionSize(e.target.value)}
                  />
                </label>
              </div>
              <div className="risk-summary">
                <div className={`risk-chip ${risk.largestTradeBreach ? 'risk-chip--bad' : ''}`}>
                  Max trade allowed:{' '}
                  <strong>
                    {risk.maxTradeUsd != null ? formatUsdt(risk.maxTradeUsd) : '—'}
                  </strong>
                </div>
                <div className={`risk-chip ${risk.openBreach ? 'risk-chip--bad' : ''}`}>
                  Open positions: <strong>{risk.posCount}</strong> / {risk.openMax}
                </div>
                <div className={`risk-chip ${risk.totalSizeBreach ? 'risk-chip--bad' : ''}`}>
                  Total size: <strong>{formatUsdt(risk.totalPositionUsd)}</strong>
                  {risk.totalMax > 0 ? ` / ${formatUsdt(risk.totalMax)}` : ' / no cap'}
                </div>
                {Number.isFinite(walletBalance) && (
                  <div className="risk-chip">
                    Account size (USDT): <strong>{formatUsdt(walletBalance)}</strong>
                  </div>
                )}
              </div>
            </section>

            <section className="positions-section" aria-live="polite">
              {loading && positions === null && (
                <p className="positions-status">Loading positions…</p>
              )}
              {error && (
                <div className="positions-error" role="alert">
                  <p className="positions-error-title">
                    Could not load positions
                  </p>
                  <p className="positions-error-msg">{error}</p>
                </div>
              )}
              {!error && !loading && positions && positions.length === 0 && (
                <p className="positions-empty">No open positions.</p>
              )}
              {!error && positions && positions.length > 0 && (
                <>
                  <p
                    className={`positions-total-pnl cell-mono cell-pnl ${pnlClass(
                      totalOpenPnl,
                    )} ${isPnlBreach(totalOpenPnl, walletBalance, risk.negPnlPct) ? 'risk-breach' : ''}`}
                  >
                    Total open PnL{' '}
                    <span className="positions-total-pnl-value">
                      {totalOpenPnl != null
                        ? formatUsdt(totalOpenPnl)
                        : '—'}
                    </span>
                  </p>
                  <div className="table-wrap">
                    <table className="positions-table">
                      <thead>
                        <tr>
                          <th>Symbol</th>
                          <th>Side</th>
                          <th>Size</th>
                          <th>Pos size (USDT)</th>
                          <th>Unrealized PnL</th>
                          <th
                            title="(Unrealized PnL ÷ (|size| × entry)) × leverage — approx. return on margin when margin ≈ notional ÷ leverage (isolated-style)"
                          >
                            % PnL
                          </th>
                          <th>Lev.</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positionsByUnrealized.map((p) => (
                          <tr
                            key={`${p.symbol}-${p.positionSide || 'default'}`}
                            className={
                              isPositionRiskBreach(p, risk.maxTradeUsd, risk.negPnlPct)
                                ? 'positions-row--risk'
                                : ''
                            }
                          >
                            <td className="cell-mono">{p.symbol}</td>
                            <td>{p.positionSide || '—'}</td>
                            <td className="cell-mono">{p.positionAmt}</td>
                            <td className="cell-mono">
                              {formatUsdt(absPositionSizeUsd(p))}
                            </td>
                            <td
                              className={`cell-mono cell-pnl ${pnlClass(
                                p.unRealizedProfit,
                              )}`}
                            >
                              {formatPnl2(p.unRealizedProfit)}
                            </td>
                            <td
                              className={`cell-mono cell-pnl ${pnlClass(
                                unrealizedPctVsEntry(p),
                              )}`}
                            >
                              {formatUnrealizedPct(p)}
                            </td>
                            <td className="cell-mono">{p.leverage}x</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </section>
          </>
        )}

        {view === 'the100k' && <The100k />}
        {view === 'breadth' && <MarketBreadth />}
        {view === 'history' && <TradeHistory />}
        {view === 'emotions' && (
          <EmotionsErrorBoundary>
            <Emotions />
          </EmotionsErrorBoundary>
        )}
        {view === 'mldataset' && <MlDatasetPrep />}
        {view === 'gptbacktest' && <GptBacktest />}
        {view === 'spiketpsl' && <SpikeTpSlBacktest />}
        {view === 'spiketpslv3' && <SpikeTpSlBacktestV3 />}
        {view === 'agent1' && <Agent1 />}
        {view === 'agent2' && <Agent2 />}
        {view === 'longsim5m' && <LongSim5m />}
        {view === 'testpage' && <TestPage />}
      </main>
    </div>
  )
}

function pnlClass(value) {
  const n = typeof value === 'number' ? value : parseFloat(value)
  if (Number.isNaN(n) || n === 0) return ''
  return n > 0 ? 'pnl-pos' : 'pnl-neg'
}

/**
 * Approx. ROE: (PnL / notional) × 100 × leverage, with notional = |size|×entry.
 * Matches “return on margin” when initial margin ≈ notional/leverage (isolated).
 */
function unrealizedPctVsEntry(p) {
  const pnl = parseFloat(p.unRealizedProfit)
  const qty = parseFloat(p.positionAmt)
  const entry = parseFloat(p.entryPrice)
  const notional = Math.abs(qty) * entry
  if (!Number.isFinite(pnl) || !Number.isFinite(notional) || notional <= 0) {
    return null
  }
  const notionalPct = (pnl / notional) * 100
  const lev = parseFloat(p.leverage)
  const mult = Number.isFinite(lev) && lev > 0 ? lev : 1
  return notionalPct * mult
}

function absPositionSizeUsd(p) {
  const fromNotional = parseFloat(p.notional)
  if (Number.isFinite(fromNotional)) return Math.abs(fromNotional)
  const qty = parseFloat(p.positionAmt)
  const mark = parseFloat(p.markPrice)
  if (Number.isFinite(qty) && Number.isFinite(mark)) {
    return Math.abs(qty * mark)
  }
  const entry = parseFloat(p.entryPrice)
  if (Number.isFinite(qty) && Number.isFinite(entry)) {
    return Math.abs(qty * entry)
  }
  return 0
}

function isPnlBreach(totalOpenPnl, walletBalance, maxNegPnlPct) {
  if (!Number.isFinite(totalOpenPnl) || !Number.isFinite(walletBalance) || walletBalance <= 0) {
    return false
  }
  if (!Number.isFinite(maxNegPnlPct) || maxNegPnlPct <= 0) return false
  const pct = (totalOpenPnl / walletBalance) * 100
  return pct <= -Math.abs(maxNegPnlPct)
}

function isPositionRiskBreach(p, maxTradeUsd, maxNegPnlPct) {
  const sizeUsd = absPositionSizeUsd(p)
  const overTrade =
    Number.isFinite(maxTradeUsd) && maxTradeUsd > 0 && sizeUsd > maxTradeUsd
  const upct = unrealizedPctVsEntry(p)
  const overLoss =
    Number.isFinite(maxNegPnlPct) && maxNegPnlPct > 0 && Number.isFinite(upct) && upct <= -maxNegPnlPct
  return overTrade || overLoss
}

function formatUnrealizedPct(p) {
  const pct = unrealizedPctVsEntry(p)
  if (pct == null || !Number.isFinite(pct)) return '—'
  const sign = pct < 0 ? '' : '+'
  return `${sign}${pct.toFixed(2)}%`
}

function formatUsdt(n) {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function formatPnl2(raw) {
  const n = parseFloat(raw)
  if (!Number.isFinite(n)) return '—'
  return formatUsdt(n)
}

export default App
