/**
 * GPT backtest: spike at i → 50 candles ending at i (OHLCV) → model outputs
 * continuation vs reversal vs neutral for candle i+1; scored vs actual bar shape.
 */

import {
  acquireFuturesRestWeight,
  futuresKlinesRequestWeight,
} from './binanceFuturesRestThrottle.js'

const WINDOW = 50
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

async function fetchFuturesKlines(futuresBase, symbol, interval, limit) {
  await acquireFuturesRestWeight(futuresKlinesRequestWeight(limit))
  const q = new URLSearchParams({ symbol, interval, limit: String(limit) })
  const url = `${futuresBase}/fapi/v1/klines?${q}`
  const r = await fetch(url)
  const text = await r.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`Binance klines: invalid JSON (${r.status})`)
  }
  if (!r.ok) {
    const msg = data.msg || data.message || text
    throw new Error(`Binance ${r.status}: ${msg}`)
  }
  if (!Array.isArray(data)) throw new Error('Unexpected klines response')
  return data.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }))
}

function isGreenAboveThreshold(c, thresholdPct) {
  if (!Number.isFinite(c.open) || c.open === 0) return false
  if (!(c.close > c.open)) return false
  const bodyPct = ((c.close - c.open) / c.open) * 100
  return bodyPct >= thresholdPct
}

function buildPromptRows(candles50) {
  /** Oldest → newest: OHLC + volume (quote volume, Binance field) */
  const rows = candles50.map((c) => ({
    t: c.openTime,
    o: round6(c.open),
    h: round6(c.high),
    l: round6(c.low),
    c: round6(c.close),
    v: round6(c.volume),
  }))
  return JSON.stringify(rows)
}

/** Short volume context for the prompt (trend vs recent spike bar). */
function buildVolumeContext(candles50) {
  const vols = candles50.map((c) => c.volume).filter((x) => Number.isFinite(x) && x >= 0)
  if (vols.length < 10) return 'Volume data insufficient for summary.'
  const last = vols[vols.length - 1]
  const last10 = vols.slice(-10)
  const prior = vols.slice(0, Math.max(0, vols.length - 10))
  const avg10 = last10.reduce((a, b) => a + b, 0) / last10.length
  const avgPrior = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : avg10
  const ratio = avgPrior > 0 ? avg10 / avgPrior : null
  const ratioNote =
    ratio != null
      ? `Ratio (mean last 10h / mean earlier in window): ${ratio.toFixed(3)}. Above 1.0 often means volume picked up into the latest bars.`
      : ''
  return [
    `Last candle (the "current" bar in the series) volume: ${last.toFixed(2)}.`,
    `Mean volume last 10 hours: ${avg10.toFixed(2)}; mean over earlier bars in window: ${avgPrior.toFixed(2)}.`,
    ratioNote,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Next-candle label for scoring (maps to close vs open on i+1).
 * continuation = bullish hour (follow-through after impulse)
 * reversal = bearish hour (fade / mean reversion)
 * neutral = doji / ~unchanged
 */
function outcomeFromCandle(c) {
  const d = candleDirectionFromOhlc(c)
  if (d === 'up') return 'continuation'
  if (d === 'down') return 'reversal'
  return 'neutral'
}

/**
 * Hypothetical PnL % on the hour after the spike (i+1) if we trade the model suggestion:
 * continuation → long (body %), reversal → short (−body %), neutral → flat (0).
 */
function suggestedTradePnlPctFrom(prediction, targetBodyPctActual) {
  if (prediction == null || targetBodyPctActual == null || !Number.isFinite(targetBodyPctActual)) {
    return null
  }
  if (prediction === 'continuation') return targetBodyPctActual
  if (prediction === 'reversal') return -targetBodyPctActual
  if (prediction === 'neutral') return 0
  return null
}

function normalizeOutcome(raw) {
  if (raw == null) return null
  const x = String(raw).trim().toLowerCase()
  if (
    ['continuation', 'continue', 'continued', 'follow', 'extend', 'momentum', 'up'].includes(
      x,
    )
  ) {
    return 'continuation'
  }
  if (
    ['reversal', 'reverse', 'revert', 'fade', 'mean_reversion', 'down', 'pullback'].includes(x)
  ) {
    return 'reversal'
  }
  if (['neutral', 'flat', 'chop', 'sideways', 'stall', 'indecision', 'doji'].includes(x)) {
    return 'neutral'
  }
  return null
}

function round6(x) {
  if (!Number.isFinite(x)) return x
  return Math.round(x * 1e6) / 1e6
}

/** Bullish / bearish / flat from a single candle OHLC. */
function candleDirectionFromOhlc(c) {
  if (!c || !Number.isFinite(c.open) || !Number.isFinite(c.close)) return 'flat'
  if (c.close > c.open) return 'up'
  if (c.close < c.open) return 'down'
  return 'flat'
}

async function callOpenAiPredictOutcome({
  apiKey,
  model,
  symbol,
  candles50,
}) {
  const payload = buildPromptRows(candles50)
  const last = candles50[candles50.length - 1]
  const lastBodyPct =
    last.open !== 0
      ? (((last.close - last.open) / last.open) * 100).toFixed(3)
      : 'n/a'
  const volCtx = buildVolumeContext(candles50)

  const userContent = `Context: ${symbol} USDT-M perpetual, 1-hour candles. The JSON below is 50 consecutive hours, oldest first (t=ms, o,h,l,c, v=quote volume).

Setup: the LAST row is a strong bullish impulse (green candle meeting our screen). We are NOT asking "will price go up" in the abstract — after a sharp green bar, the next hour often FADES (reversal) or CHOPS (neutral), not only continues.

Volume / flow:
${volCtx}

Last candle: body vs open ≈ ${lastBodyPct}% — note wick size vs body, close location in the range, and whether volume suggests climax or continuation.

DATA:
${payload}

Your task — for the ONE candle that opens immediately AFTER the last row (the next hour only):

Classify the likely path:
- "continuation" = buying pressure continues; you expect that next candle to CLOSE ABOVE its OPEN (bullish bar / follow-through).
- "reversal" = mean reversion or selling into the move; you expect that next candle to CLOSE BELOW its OPEN (bearish bar).
- "neutral" = balance / indecision; you expect open and close nearly the same (tiny body / doji-like).

Important: Reversal and neutral are common after impulses. Do not default to continuation. Weigh volume trend, exhaustion, and whether the impulse bar looks extended.

Return ONLY valid JSON with a single key "outcome", value exactly one of: "continuation", "reversal", "neutral". No prices, no other keys, no prose.`

  const body = {
    model: model || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content:
          'You output valid JSON only: {"outcome":"continuation"} or {"outcome":"reversal"} or {"outcome":"neutral"}. You specialize in post-impulse behaviour: continuation vs mean-reversion vs chop. You do not output OHLC or dollar levels. You avoid bullish bias: after strong green candles, reversal is a normal hypothesis.',
      },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.35,
    max_tokens: 48,
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    return {
      ok: false,
      error: `OpenAI invalid JSON (${res.status}): ${text.slice(0, 300)}`,
    }
  }
  if (!res.ok) {
    const msg = data.error?.message || data.message || text
    return { ok: false, error: `OpenAI ${res.status}: ${msg}` }
  }
  const raw = data.choices?.[0]?.message?.content
  if (typeof raw !== 'string') {
    return { ok: false, error: 'OpenAI: empty message' }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ok: false, error: `OpenAI: could not parse JSON: ${raw.slice(0, 200)}`, raw }
  }
  const outcome = normalizeOutcome(
    parsed.outcome ?? parsed.direction ?? parsed.prediction,
  )
  if (outcome == null) {
    return {
      ok: false,
      error: `OpenAI: need outcome in {continuation|reversal|neutral}, got: ${JSON.stringify(parsed)}`,
      raw,
    }
  }
  return {
    ok: true,
    outcome,
    raw,
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {object} opts
 * @param {string} opts.futuresBase
 * @param {string} opts.symbol - e.g. BTCUSDT
 * @param {number} opts.candleCount - 20..1500
 * @param {number} opts.thresholdPct - min green body % vs open
 * @param {number} opts.maxEvents - max GPT calls (events to evaluate)
 * @param {string} opts.apiKey - OPENAI_API_KEY
 * @param {string} [opts.model]
 */
export async function runGptBacktest(opts) {
  const {
    futuresBase,
    symbol,
    candleCount,
    thresholdPct,
    maxEvents,
    apiKey,
    model,
    delayMs = 400,
  } = opts

  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('OPENAI_API_KEY is not set on the server')
  }

  const candles = await fetchFuturesKlines(
    futuresBase,
    symbol,
    '1h',
    candleCount,
  )

  /** Need window of WINDOW bars ending at i, plus one more bar i+1 as prediction target. */
  if (candles.length < WINDOW + 1) {
    throw new Error(`Need at least ${WINDOW + 1} candles; got ${candles.length}`)
  }

  const eventIndices = []
  for (let i = WINDOW - 1; i < candles.length - 1; i++) {
    if (isGreenAboveThreshold(candles[i], thresholdPct)) {
      eventIndices.push(i)
    }
  }

  const slice = eventIndices.slice(0, Math.max(0, maxEvents))
  const results = []

  for (const i of slice) {
    const window = candles.slice(i - WINDOW + 1, i + 1)
    const spike = candles[i]
    const actual = candles[i + 1]
    const ai = await callOpenAiPredictOutcome({
      apiKey,
      model,
      symbol,
      candles50: window,
    })

    const outcomeRow = {
      actual: outcomeFromCandle(actual),
      predicted: null,
      match: null,
    }
    if (ai.ok && ai.outcome) {
      outcomeRow.predicted = ai.outcome
      outcomeRow.match = outcomeRow.actual === outcomeRow.predicted
    }

    const targetBodyPctActual =
      actual.open !== 0
        ? ((actual.close - actual.open) / actual.open) * 100
        : null
    const suggestedTradePnlPct = suggestedTradePnlPctFrom(
      outcomeRow.predicted,
      targetBodyPctActual,
    )

    results.push({
      spikeIndex: i,
      targetIndex: i + 1,
      spikeOpenTime: spike.openTime,
      targetOpenTime: actual.openTime,
      spikeBodyPct:
        spike.open !== 0
          ? ((spike.close - spike.open) / spike.open) * 100
          : null,
      targetBodyPctActual,
      suggestedTradePnlPct,
      actual: {
        open: actual.open,
        high: actual.high,
        low: actual.low,
        close: actual.close,
      },
      error: ai.ok ? null : ai.error,
      rawAssistantSnippet:
        ai.ok && typeof ai.raw === 'string' ? ai.raw.slice(0, 400) : undefined,
      outcome: outcomeRow,
    })

    if (delayMs > 0) await sleep(delayMs)
  }

  const withOutcome = results.filter((r) => r.outcome?.predicted != null)
  const outcomeHits = withOutcome.filter((r) => r.outcome.match === true).length

  const withPnl = results.filter((r) => r.suggestedTradePnlPct != null)
  const suggestedPnlTotalPct = withPnl.reduce((sum, r) => sum + r.suggestedTradePnlPct, 0)

  return {
    symbol,
    interval: '1h',
    predictionTarget: 'candle_i_plus_1_continuation_vs_reversal',
    candleCountFetched: candles.length,
    thresholdPct,
    windowSize: WINDOW,
    greenEventsFound: eventIndices.length,
    eventsEvaluated: results.length,
    eventsRemaining: Math.max(0, eventIndices.length - slice.length),
    outcomeHits,
    outcomeEvaluated: withOutcome.length,
    directionHits: outcomeHits,
    directionEvaluated: withOutcome.length,
    suggestedPnlTotalPct,
    suggestedPnlTradeCount: withPnl.length,
    results,
    fetchedAt: new Date().toISOString(),
  }
}
