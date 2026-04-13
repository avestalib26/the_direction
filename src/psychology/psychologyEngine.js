/**
 * Behavioral / psychology model from closed-position rows (chronological realized PnL).
 * Formulas are documented inline; tune defaults in psychologyThresholds.js.
 */

import {
  BURST_COUNT_ALERT,
  BURST_WINDOW_MS,
  DD_CAPITAL,
  DD_DEFENSE,
  DD_WARN_STEPS,
  LOSS_STREAK_HIGH,
  LOSS_STREAK_MEDIUM,
  MIN_CLOSES_FOR_FULL_MODEL,
  NEW_SYMBOLS_AFTER_LOSS_ALERT,
  OVERTRADE_RATE_MULT_EXTREME,
  OVERTRADE_RATE_MULT_HIGH,
  OVERTRADE_WINDOW_MS,
  PEAK_EPS,
  PENALTY_DD_PER_TIER,
  PENALTY_LOSS_STREAK,
  PENALTY_OVERTRADE_HIGH,
  PENALTY_RECOVERY_EXTREME,
  RANDOM_SYMBOL_MULT_HIGH,
  RECOVERY_DD_MIN,
  RECOVERY_FREQ_MULT_HIGH,
  RECOVERY_FREQ_MULT_MEDIUM,
  RECOVERY_SYMBOL_ROTATION_MULT,
  SESSION_GAP_MS,
  SIDE_CLUSTER_MIN_TRADES,
  SIDE_CLUSTER_WINDOW_MS,
} from './psychologyThresholds.js'

/** @typedef {{ symbol: string, orderId: number|string, positionSide: string, closedAt: number, realizedPnl: number, fills: number, qty: number }} NormalizedTrade */

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n))
}

function sum(arr) {
  return arr.reduce((a, b) => a + b, 0)
}

function median(arr) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function riskFromScore(score) {
  if (score < 25) return 'low'
  if (score < 50) return 'medium'
  if (score < 75) return 'high'
  return 'extreme'
}

function formatPct(x) {
  if (!Number.isFinite(x)) return '—'
  return `${(x * 100).toFixed(1)}%`
}

/**
 * @param {unknown} raw
 * @returns {NormalizedTrade | null}
 */
export function normalizeClose(raw) {
  if (!raw || typeof raw !== 'object') return null
  const symbol = String(raw.symbol ?? '')
  const orderId = raw.orderId
  const positionSide = String(raw.positionSide ?? 'BOTH')
  const closedAt = Number(raw.closedAt)
  const realizedPnl = Number(raw.realizedPnl)
  const fills = Number(raw.fills) || 0
  const qty = Number(raw.qty) || 0
  if (!symbol || !Number.isFinite(closedAt) || !Number.isFinite(realizedPnl)) return null
  return { symbol, orderId, positionSide, closedAt, realizedPnl, fills, qty }
}

/**
 * @param {unknown[]} closes
 * @param {{ sinceMs?: number, untilMs?: number, symbol?: string }} filters
 */
export function filterCloses(closes, filters = {}) {
  const sinceMs = filters.sinceMs
  const untilMs = filters.untilMs
  const sym = filters.symbol?.trim().toUpperCase()
  const out = []
  for (const c of closes) {
    const t = normalizeClose(c)
    if (!t) continue
    if (sinceMs != null && t.closedAt < sinceMs) continue
    if (untilMs != null && t.closedAt > untilMs) continue
    if (sym && t.symbol.toUpperCase() !== sym) continue
    out.push(t)
  }
  return out.sort((a, b) => a.closedAt - b.closedAt)
}

/**
 * Unique chart times for lightweight-charts (no duplicate seconds).
 * @param {NormalizedTrade[]} asc
 */
export function assignChartTimes(asc) {
  const used = new Set()
  return asc.map((c) => {
    let t = Math.floor(c.closedAt / 1000)
    while (used.has(t)) t += 1
    used.add(t)
    return { ...c, chartTime: t }
  })
}

/**
 * @param {NormalizedTrade[]} tradesAsc
 */
export function buildEquityPoints(tradesAsc) {
  const withT = assignChartTimes(tradesAsc)
  let cum = 0
  let peak = 0
  const points = []
  for (const tr of withT) {
    cum += tr.realizedPnl
    if (cum > peak) peak = cum
    const ddFromPeak = peak > PEAK_EPS ? (peak - cum) / Math.max(peak, PEAK_EPS) : 0
    points.push({
      chartTime: tr.chartTime,
      closedAt: tr.closedAt,
      symbol: tr.symbol,
      orderId: tr.orderId,
      cum,
      peak,
      drawdownFromPeak: ddFromPeak,
      trade: tr,
    })
  }
  return points
}

/**
 * @param {NormalizedTrade[]} tradesAsc
 * @param {number} gapMs
 */
export function splitSessions(tradesAsc, gapMs = SESSION_GAP_MS) {
  if (!tradesAsc.length) return []
  /** @type {NormalizedTrade[][]} */
  const sessions = []
  let cur = [tradesAsc[0]]
  for (let i = 1; i < tradesAsc.length; i++) {
    const prev = tradesAsc[i - 1]
    const t = tradesAsc[i]
    if (t.closedAt - prev.closedAt > gapMs) {
      sessions.push(cur)
      cur = [t]
    } else {
      cur.push(t)
    }
  }
  sessions.push(cur)
  return sessions
}

function sessionNet(sesTrades) {
  return sum(sesTrades.map((t) => t.realizedPnl))
}

function sessionWinRate(sesTrades) {
  const d = sesTrades.filter((t) => t.realizedPnl !== 0)
  if (!d.length) return null
  return d.filter((t) => t.realizedPnl > 0).length / d.length
}

function avgGapSeconds(sesTrades) {
  if (sesTrades.length < 2) return null
  let s = 0
  for (let i = 1; i < sesTrades.length; i++) {
    s += (sesTrades[i].closedAt - sesTrades[i - 1].closedAt) / 1000
  }
  return s / (sesTrades.length - 1)
}

function distinctSymbols(sesTrades) {
  return new Set(sesTrades.map((t) => t.symbol))
}

function countTradesInWindow(tradesAsc, endMs, windowMs) {
  const start = endMs - windowMs
  let n = 0
  for (let i = tradesAsc.length - 1; i >= 0; i--) {
    const t = tradesAsc[i].closedAt
    if (t < start) break
    if (t <= endMs) n += 1
  }
  return n
}

function consecutiveLossStreakFromEnd(tradesAsc) {
  let streak = 0
  for (let i = tradesAsc.length - 1; i >= 0; i--) {
    const p = tradesAsc[i].realizedPnl
    if (p === 0) continue
    if (p < 0) streak += 1
    else break
  }
  return streak
}

function consecutiveWinStreakFromEnd(tradesAsc) {
  let streak = 0
  for (let i = tradesAsc.length - 1; i >= 0; i--) {
    const p = tradesAsc[i].realizedPnl
    if (p === 0) continue
    if (p > 0) streak += 1
    else break
  }
  return streak
}

/**
 * Baseline from sessions excluding the last (current) one when possible.
 * @param {NormalizedTrade[][]} sessionGroups
 */
function computeBaseline(sessionGroups) {
  const forStats =
    sessionGroups.length > 1 ? sessionGroups.slice(0, -1) : sessionGroups
  const tradesPerSession = forStats.map((s) => s.length)
  const symbolsPerSession = forStats.map((s) => distinctSymbols(s).size)
  const gaps = forStats.map((s) => avgGapSeconds(s)).filter((g) => g != null)

  const medTrades = median(tradesPerSession) ?? 5
  const medSyms = median(symbolsPerSession) ?? 3
  const medGap = median(gaps) ?? 600

  const profitable = forStats.filter((s) => sessionNet(s) > 0)
  const medTradesWhenGreen = median(profitable.map((s) => s.length)) ?? medTrades
  const medSymsWhenGreen = median(profitable.map((s) => distinctSymbols(s).size)) ?? medSyms

  return {
    medianTradesPerSession: Math.max(1, medTrades),
    medianSymbolsPerSession: Math.max(1, medSyms),
    medianGapSec: Math.max(30, medGap),
    medianTradesWhenProfitable: Math.max(1, medTradesWhenGreen),
    medianSymbolsWhenProfitable: Math.max(1, medSymsWhenGreen),
    sessionCount: forStats.length,
  }
}

function newSymbolsAfterFirstLoss(sesTrades, priorSymbols) {
  let idxLoss = -1
  for (let i = 0; i < sesTrades.length; i++) {
    if (sesTrades[i].realizedPnl < -1e-8) {
      idxLoss = i
      break
    }
  }
  if (idxLoss < 0) return { afterLoss: 0, firstLossIndex: null }
  const seen = new Set(priorSymbols)
  let newCount = 0
  for (let i = idxLoss + 1; i < sesTrades.length; i++) {
    const sym = sesTrades[i].symbol
    if (!seen.has(sym)) {
      newCount += 1
      seen.add(sym)
    }
  }
  return { afterLoss: newCount, firstLossIndex: idxLoss }
}

function sameSideClusterScore(sesTrades) {
  let maxCluster = 0
  for (let i = 0; i < sesTrades.length; i++) {
    const side = sesTrades[i].positionSide
    const t0 = sesTrades[i].closedAt
    const windowEnd = t0 + SIDE_CLUSTER_WINDOW_MS
    const syms = new Set()
    let count = 0
    for (let j = i; j < sesTrades.length; j++) {
      if (sesTrades[j].closedAt > windowEnd) break
      if (sesTrades[j].positionSide !== side) continue
      count += 1
      syms.add(sesTrades[j].symbol)
    }
    if (syms.size >= 2 && count >= SIDE_CLUSTER_MIN_TRADES) {
      maxCluster = Math.max(maxCluster, count)
    }
  }
  return maxCluster
}

/**
 * @param {string} primary
 * @param {number} conf 0-1
 */
function mapPrimaryState(primary) {
  const labels = [
    'Calm / Selective',
    'Aggressive but Controlled',
    'Recovery Chasing',
    'Revenge Trading',
    'Overtrading',
    'Execution Drift',
    'Tilt / Shutdown Risk',
  ]
  if (primary === 'tilt') return labels[6]
  if (primary === 'overtrading') return labels[4]
  if (primary === 'revenge') return labels[3]
  if (primary === 'recovery') return labels[2]
  if (primary === 'drift') return labels[5]
  if (primary === 'aggressive') return labels[1]
  return labels[0]
}

function classifySessionState(args) {
  const {
    netPnl,
    overtradeRatio,
    recoveryScore,
    revengeScore,
    randomScore,
    driftScore,
    lossStreak,
    sameSideCluster,
  } = args

  if (lossStreak >= LOSS_STREAK_HIGH || (revengeScore > 70 && overtradeRatio > 1.8)) {
    return { primary: 'tilt', scores: { recovery: recoveryScore, revenge: revengeScore } }
  }
  if (overtradeRatio >= OVERTRADE_RATE_MULT_EXTREME || randomScore > 75) {
    return { primary: 'overtrading', scores: {} }
  }
  if (revengeScore > 65 && lossStreak >= LOSS_STREAK_MEDIUM) {
    return { primary: 'revenge', scores: {} }
  }
  if (recoveryScore > 60 && overtradeRatio > 1.3) {
    return { primary: 'recovery', scores: {} }
  }
  if (driftScore > 55 || sameSideCluster >= SIDE_CLUSTER_MIN_TRADES) {
    return { primary: 'drift', scores: {} }
  }
  if (netPnl > 0 && overtradeRatio <= 1.2 && randomScore < 40) {
    return { primary: 'aggressive', scores: {} }
  }
  return { primary: 'calm', scores: {} }
}

function subScoresRecentWindow(tradesAsc, baseline, equityNow) {
  const lastT = tradesAsc[tradesAsc.length - 1]
  if (!lastT) {
    return {
      recovery: 0,
      revenge: 0,
      overtrading: 0,
      random: 0,
      drift: 0,
    }
  }
  const endMs = lastT.closedAt
  const in60 = countTradesInWindow(tradesAsc, endMs, OVERTRADE_WINDOW_MS)
  const in15 = countTradesInWindow(tradesAsc, endMs, BURST_WINDOW_MS)
  const hours = OVERTRADE_WINDOW_MS / 3600000
  const baselinePerHour = baseline.medianTradesPerSession / 4
  const rate = in60 / Math.max(hours, 0.25)
  const overtradeRatio = baselinePerHour > 0 ? rate / baselinePerHour : rate / 2

  const recent = tradesAsc.slice(-Math.min(24, tradesAsc.length))
  const syms = distinctSymbols(recent)
  const symRatio =
    baseline.medianSymbolsPerSession > 0
      ? syms.size / baseline.medianSymbolsPerSession
      : syms.size

  const dd = equityNow.drawdownFromPeak
  let recovery = 0
  if (dd > RECOVERY_DD_MIN && overtradeRatio > RECOVERY_FREQ_MULT_MEDIUM) {
    recovery = clamp(40 + (dd * 100 - 3) * 8 + (overtradeRatio - 1) * 15, 0, 100)
  }
  let revenge = 0
  const lossStreak = consecutiveLossStreakFromEnd(tradesAsc)
  if (lossStreak >= 2 && in15 >= 3) {
    revenge = clamp(35 + lossStreak * 12 + (in15 - 3) * 10, 0, 100)
  }
  let overtrading = clamp((overtradeRatio - 1) * 35 + (in15 >= BURST_COUNT_ALERT ? 25 : 0), 0, 100)
  let random = clamp((symRatio - 1) * 40 + (symRatio > RANDOM_SYMBOL_MULT_HIGH ? 25 : 0), 0, 100)
  let drift = clamp(
    (overtradeRatio > 1.4 ? 20 : 0) + (symRatio > 1.5 ? 25 : 0) + (lossStreak >= 3 ? 20 : 0),
    0,
    100,
  )

  return { recovery, revenge, overtrading, random, drift, overtradeRatio, symRatio, in60, in15, lossStreak }
}

function modeEngine({ drawdownFromPeak, recoveryRisk, overtradingRisk, lossStreak }) {
  const dd = drawdownFromPeak
  if (
    dd >= DD_CAPITAL ||
    (recoveryRisk === 'extreme' && overtradingRisk === 'high') ||
    (recoveryRisk === 'high' && overtradingRisk === 'extreme') ||
    lossStreak >= LOSS_STREAK_HIGH
  ) {
    return 'Capital Preservation'
  }
  if (
    dd >= DD_DEFENSE ||
    recoveryRisk === 'high' ||
    recoveryRisk === 'extreme' ||
    overtradingRisk === 'extreme' ||
    lossStreak >= LOSS_STREAK_MEDIUM
  ) {
    return 'Defense'
  }
  return 'Attack'
}

function psychologyScoreFrom({ dd, recoveryScore, overtradingScore, randomScore, lossStreak }) {
  let s = 100
  for (const step of DD_WARN_STEPS) {
    if (dd >= step) s -= PENALTY_DD_PER_TIER
  }
  if (overtradingScore > 60) s -= PENALTY_OVERTRADE_HIGH
  if (recoveryScore > 70) s -= PENALTY_RECOVERY_EXTREME
  if (lossStreak >= LOSS_STREAK_MEDIUM) s -= PENALTY_LOSS_STREAK
  if (randomScore > 65) s -= 8
  return clamp(s, 0, 100)
}

function executionQualityScore({ winRateRecent, winRateBase, avgGapRecent, avgGapBase, in15 }) {
  let s = 70
  if (winRateRecent != null && winRateBase != null) {
    s += (winRateRecent - winRateBase) * 80
  }
  if (avgGapRecent != null && avgGapBase != null && avgGapBase > 0) {
    const ratio = avgGapRecent / avgGapBase
    if (ratio < 0.45) s -= 25
    else if (ratio < 0.65) s -= 15
  }
  if (in15 >= BURST_COUNT_ALERT) s -= 20
  const out = clamp(s, 0, 100)
  return Number.isFinite(out) ? out : 50
}

function buildTimeline(equityPoints, tradesAsc, sessions) {
  const events = []
  let lastPeak = -Infinity
  for (const p of equityPoints) {
    if (p.cum > lastPeak + PEAK_EPS) {
      lastPeak = p.cum
      events.push({
        chartTime: p.chartTime,
        closedAt: p.closedAt,
        kind: 'peak',
        label: 'New cumulative PnL high',
        detail: `Equity ≈ ${p.cum.toFixed(2)} USDT (realized)`,
      })
    }
  }
  const firstDdCross = new Map()
  for (const p of equityPoints) {
    const dd = p.drawdownFromPeak
    for (const th of DD_WARN_STEPS) {
      if (dd + 1e-9 >= th && !firstDdCross.has(th)) {
        firstDdCross.set(th, p)
      }
    }
  }
  for (const th of DD_WARN_STEPS) {
    const p = firstDdCross.get(th)
    if (!p) continue
    events.push({
      chartTime: p.chartTime,
      closedAt: p.closedAt,
      kind: 'drawdown',
      label: `Drawdown ≥ ${(th * 100).toFixed(0)}% from peak`,
      detail: `Peak ${p.peak.toFixed(2)} → ${p.cum.toFixed(2)}`,
    })
  }
  for (let i = 0; i < tradesAsc.length; i++) {
    const t0 = tradesAsc[i].closedAt
    let n = 1
    for (let j = i + 1; j < tradesAsc.length; j++) {
      if (tradesAsc[j].closedAt - t0 <= BURST_WINDOW_MS) n += 1
      else break
    }
    if (n >= BURST_COUNT_ALERT) {
      events.push({
        chartTime: Math.floor(t0 / 1000),
        closedAt: t0,
        kind: 'burst',
        label: 'High trade tempo',
        detail: `${n} closes within ${BURST_WINDOW_MS / 60000} min`,
      })
      break
    }
  }
  for (let si = 1; si < sessions.length; si++) {
    const s = sessions[si]
    if (!s.length) continue
    events.push({
      chartTime: Math.floor(s[0].closedAt / 1000),
      closedAt: s[0].closedAt,
      kind: 'session',
      label: 'New session (gap break)',
      detail: `Session ${si + 1} starts`,
    })
  }
  events.sort((a, b) => a.closedAt - b.closedAt)
  return events
}

function buildExplanations(ctx) {
  const lines = []
  const { dd, baseline, sub, lastSession, equityPoints } = ctx
  const last = equityPoints[equityPoints.length - 1]
  if (last) {
    lines.push(
      `You are down ${formatPct(dd)} from the recent realized PnL peak (${last.peak.toFixed(2)} → ${last.cum.toFixed(2)} USDT).`,
    )
  }
  if (sub.in60 > 0) {
    lines.push(
      `${sub.in60} closes in the last ${OVERTRADE_WINDOW_MS / 3600000}h vs ~${baseline.medianTradesPerSession.toFixed(1)} trades/session baseline (median).`,
    )
  }
  if (sub.in15 >= BURST_COUNT_ALERT) {
    lines.push(
      `Burst activity: ${sub.in15} closes within ${BURST_WINDOW_MS / 60000} minutes.`,
    )
  }
  if (sub.symRatio >= RECOVERY_SYMBOL_ROTATION_MULT) {
    lines.push(
      `Symbol count in the recent window is ${sub.symRatio.toFixed(2)}× your typical session breadth.`,
    )
  }
  if (lastSession?.newSymbolsAfterLoss >= NEW_SYMBOLS_AFTER_LOSS_ALERT) {
    lines.push(
      `${lastSession.newSymbolsAfterLoss} first-time-in-window symbols appeared after the first loss of the current session.`,
    )
  }
  if (sub.overtradeRatio >= OVERTRADE_RATE_MULT_HIGH && sub.lossStreak >= 2) {
    lines.push('Trade frequency is elevated while losses stack — recovery-chasing pattern.')
  }
  if (lines.length === 0) {
    lines.push('No strong behavioral flags in the current window — regime looks controlled vs your loaded baseline.')
  }
  return lines
}

function buildActions(mode, risks, sub, dd) {
  const actions = []
  if (mode === 'Attack') {
    actions.push('Stay in Attack mode while tempo and selectivity match baseline.')
  }
  if (mode === 'Defense') {
    actions.push('Switch to Defense: only A+ setups; halve size until drawdown stabilizes.')
    actions.push('Do not open new symbols for 20–30 minutes unless planned before the session.')
  }
  if (mode === 'Capital Preservation') {
    actions.push('Capital preservation: stop opening risk; one tiny probe max, then reassess flat.')
    actions.push('You are trading for recovery — pause and reset.')
  }
  if (risks.recovery === 'high' || risks.recovery === 'extreme') {
    actions.push('Label the next trade before entry; if the thesis is “get back to green”, skip.')
  }
  if (sub.in15 >= BURST_COUNT_ALERT) {
    actions.push('Cooling-off: step away 15 minutes — tempo is impulsive.')
  }
  if (dd >= DD_CAPITAL) {
    actions.push('>20% giveback from peak — treat flat as the default action.')
  }
  return [...new Set(actions)]
}

/**
 * Full dashboard model.
 * @param {unknown[]} closesRaw
 * @param {{ sessionGapMs?: number, sinceMs?: number, untilMs?: number, symbol?: string }} opts
 */
export function buildPsychologyModel(closesRaw, opts = {}) {
  const gapMs = opts.sessionGapMs ?? SESSION_GAP_MS
  let tradesAsc = filterCloses(closesRaw, {
    sinceMs: opts.sinceMs,
    untilMs: opts.untilMs,
    symbol: opts.symbol,
  })

  const lowData = tradesAsc.length < MIN_CLOSES_FOR_FULL_MODEL

  if (!tradesAsc.length) {
    return {
      empty: true,
      lowData: true,
      trades: [],
      equityPoints: [],
      sessions: [],
      baseline: null,
      summary: null,
      explanations: ['No closed positions in this filter.'],
      timeline: [],
      sessionDetails: [],
      symbolPanel: null,
      tempoPanel: null,
      actions: [],
      markers: [],
    }
  }

  const sessions = splitSessions(tradesAsc, gapMs)
  const baseline = computeBaseline(sessions)

  const equityPoints = buildEquityPoints(tradesAsc)
  const lastEq = equityPoints[equityPoints.length - 1]
  const drawdownFromPeak = lastEq?.drawdownFromPeak ?? 0

  /** Fresh Set per session start — prior = symbols seen before this session’s first close. */
  function symbolsBefore(beforeMs) {
    const set = new Set()
    for (const t of tradesAsc) {
      if (t.closedAt >= beforeMs) break
      set.add(t.symbol)
    }
    return set
  }

  const sessionDetails = []
  for (let si = 0; si < sessions.length; si++) {
    const ses = sessions[si]
    const startMs = ses[0].closedAt
    const priorSet = symbolsBefore(startMs)
    const net = sessionNet(ses)
    const wr = sessionWinRate(ses)
    let run = 0
    let peak = 0
    let maxDd = 0
    for (const t of ses) {
      run += t.realizedPnl
      if (run > peak) peak = run
      const dd = peak - run
      if (dd > maxDd) maxDd = dd
    }
    const syms = distinctSymbols(ses)
    const { afterLoss, firstLossIndex } = newSymbolsAfterFirstLoss(ses, priorSet)
    const symbolCounts = {}
    for (const t of ses) {
      symbolCounts[t.symbol] = (symbolCounts[t.symbol] || 0) + 1
    }
    let topWin = null
    let topLoss = null
    for (const t of ses) {
      if (topWin == null || t.realizedPnl > topWin.pnl) topWin = { symbol: t.symbol, pnl: t.realizedPnl }
      if (topLoss == null || t.realizedPnl < topLoss.pnl) topLoss = { symbol: t.symbol, pnl: t.realizedPnl }
    }
    const lossStreakS = consecutiveLossStreakFromEnd(ses)
    const avgG = avgGapSeconds(ses)
    const medTrades = baseline.medianTradesPerSession
    const overtradeRatio = medTrades > 0 ? ses.length / medTrades : ses.length
    const randomScore =
      baseline.medianSymbolsPerSession > 0
        ? clamp((syms.size / baseline.medianSymbolsPerSession - 1) * 45 + (afterLoss > 3 ? 20 : 0), 0, 100)
        : 50
    const recoveryScore =
      drawdownFromPeak > RECOVERY_DD_MIN && overtradeRatio > 1.2
        ? clamp(30 + drawdownFromPeak * 100 + (afterLoss > 2 ? 15 : 0), 0, 100)
        : 20
    const revengeScore = lossStreakS >= 3 ? 55 + lossStreakS * 8 : lossStreakS * 15
    const driftScore = sameSideClusterScore(ses) >= SIDE_CLUSTER_MIN_TRADES ? 45 : 15

    const cls = classifySessionState({
      netPnl: net,
      overtradeRatio,
      recoveryScore,
      revengeScore,
      randomScore,
      driftScore,
      lossStreak: lossStreakS,
      sameSideCluster: sameSideClusterScore(ses),
    })

    const stateLabel = mapPrimaryState(cls.primary)

    sessionDetails.push({
      index: si,
      startMs,
      endMs: ses[ses.length - 1].closedAt,
      trades: ses,
      netPnl: net,
      maxRunup: peak,
      maxDrawdownSession: maxDd,
      tradeCount: ses.length,
      winRate: wr,
      avgGapSec: avgG,
      symbols: [...syms].sort(),
      symbolCounts,
      topWinningSymbol: topWin,
      topLosingSymbol: topLoss,
      newSymbolsAfterLoss: afterLoss,
      firstLossIndex,
      stateLabel,
      overtradeRatio,
    })
  }

  const lastSession = sessionDetails[sessionDetails.length - 1]

  let winRateRecent = null
  const recent20 = tradesAsc.slice(-20)
  const decR = recent20.filter((t) => t.realizedPnl !== 0)
  if (decR.length) {
    winRateRecent = recent20.filter((t) => t.realizedPnl > 0).length / decR.length
  }
  let winRateBase = null
  const older = tradesAsc.length > 10 ? tradesAsc.slice(0, -5) : []
  const decO = older.filter((t) => t.realizedPnl !== 0)
  if (decO.length) {
    winRateBase = older.filter((t) => t.realizedPnl > 0).length / decO.length
  }

  const sub = subScoresRecentWindow(tradesAsc, baseline, {
    drawdownFromPeak,
    cum: lastEq?.cum ?? 0,
    peak: lastEq?.peak ?? 0,
  })

  const recoveryRisk = riskFromScore(sub.recovery)
  const overtradingRisk = riskFromScore(sub.overtrading)
  const randomEntryRisk = riskFromScore(sub.random)

  const mode = modeEngine({
    drawdownFromPeak,
    recoveryRisk,
    overtradingRisk,
    lossStreak: sub.lossStreak,
  })

  const psychScore = psychologyScoreFrom({
    dd: drawdownFromPeak,
    recoveryScore: sub.recovery,
    overtradingScore: sub.overtrading,
    randomScore: sub.random,
    lossStreak: sub.lossStreak,
  })

  const avgGapRecent =
    tradesAsc.length >= 2
      ? (tradesAsc[tradesAsc.length - 1].closedAt - tradesAsc[tradesAsc.length - 2].closedAt) /
        1000
      : null

  const execScore = executionQualityScore({
    winRateRecent,
    winRateBase,
    avgGapRecent,
    avgGapBase: baseline.medianGapSec,
    in15: sub.in15,
  })

  const explanations = buildExplanations({
    dd: drawdownFromPeak,
    baseline,
    sub,
    lastSession,
    equityPoints,
  })

  const timeline = buildTimeline(equityPoints, tradesAsc, sessions)

  const actions = buildActions(
    mode,
    {
      recovery: recoveryRisk,
      overtrading: overtradingRisk,
      random: randomEntryRisk,
    },
    sub,
    drawdownFromPeak,
  )

  const streakWins = consecutiveWinStreakFromEnd(tradesAsc)
  const streakLosses = consecutiveLossStreakFromEnd(tradesAsc)

  const symbolPanel = {
    distinctInLastSession: lastSession?.symbols.length ?? 0,
    newAfterLoss: lastSession?.newSymbolsAfterLoss ?? 0,
    concentrationVsRandom: clamp(100 - (sub.symRatio - 1) * 40, 0, 100),
    warning:
      sub.symRatio >= RANDOM_SYMBOL_MULT_HIGH
        ? 'You are trading more distinct symbols than your baseline — exploration spike.'
        : null,
  }

  const tempoPanel = {
    avgGapSecGlobal: avgGapSeconds(tradesAsc),
    avgGapSecLast: avgGapRecent,
    tradesLast60m: sub.in60,
    tradesLast15m: sub.in15,
    /** Recent trade-rate vs median session (only shown when already in drawdown). */
    tradeRateVsBaselineInDrawdown:
      drawdownFromPeak > 0.05 ? sub.overtradeRatio : null,
  }

  /** Markers for charts: state timeline + timeline events */
  const markers = []
  for (const ev of timeline) {
    if (ev.kind === 'peak' || ev.kind === 'drawdown' || ev.kind === 'burst') {
      markers.push({
        time: ev.chartTime,
        position: 'belowBar',
        color: ev.kind === 'peak' ? '#0ecb81' : ev.kind === 'burst' ? '#f0b90b' : '#f6465d',
        shape: ev.kind === 'peak' ? 'arrowUp' : 'circle',
        text: ev.label.slice(0, 24),
      })
    }
  }

  return {
    empty: false,
    lowData,
    trades: tradesAsc,
    equityPoints,
    sessions,
    baseline,
    summary: {
      mode,
      psychologyScore: psychScore,
      executionScore: execScore,
      drawdownFromPeak,
      drawdownFromPeakPct: drawdownFromPeak * 100,
      peakEquity: lastEq?.peak ?? 0,
      currentEquity: lastEq?.cum ?? 0,
      streak:
        streakLosses > 0
          ? { kind: 'loss', n: streakLosses }
          : streakWins > 0
            ? { kind: 'win', n: streakWins }
            : { kind: 'flat', n: 0 },
      recoveryChasingRisk: recoveryRisk,
      overtradingRisk,
      randomEntryRisk,
      primaryBehavior: mapPrimaryState(
        classifySessionState({
          netPnl: lastSession?.netPnl ?? 0,
          overtradeRatio: lastSession?.overtradeRatio ?? 1,
          recoveryScore: sub.recovery,
          revengeScore: sub.revenge,
          randomScore: sub.random,
          driftScore: sub.drift,
          lossStreak: sub.lossStreak,
          sameSideCluster: sameSideClusterScore(sessions[sessions.length - 1] ?? []),
        }).primary,
      ),
    },
    explanations,
    timeline,
    sessionDetails,
    symbolPanel,
    tempoPanel,
    actions,
    markers,
    subScores: sub,
  }
}

/** Safe fallback when analysis throws (UI should never hard-crash). */
export function emptyPsychologyModel() {
  return buildPsychologyModel([], {})
}

