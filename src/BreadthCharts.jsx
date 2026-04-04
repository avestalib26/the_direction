import { useMemo } from 'react'

const VW = 880
const VH = 200
const PAD_L = 44
const PAD_R = 12
const PAD_T = 8
const PAD_B = 36

/** Sum of each coin's open→close % for that candle (equal-weight coins, raw sum). */
function sumCoinPctPerCandle(symbolRows, nCandles) {
  const out = new Array(nCandles).fill(0)
  if (!symbolRows.length || nCandles === 0) return out
  for (let j = 0; j < nCandles; j++) {
    let sum = 0
    for (const row of symbolRows) {
      const p = row.candles[j]?.changePct
      if (p != null && Number.isFinite(p)) {
        sum += p
      }
    }
    out[j] = sum
  }
  return out
}

function cumulativeSum(values) {
  const out = []
  let s = 0
  for (const v of values) {
    s += v
    out.push(s)
  }
  return out
}

function DivergingPairChart({
  candles,
  upKey,
  downKey,
  upLabel,
  downLabel,
  title,
  subtitle,
  maxScale,
}) {
  const n = candles.length
  const plotW = VW - PAD_L - PAD_R
  const plotH = VH - PAD_T - PAD_B
  const midY = PAD_T + plotH / 2
  const halfH = plotH / 2 - 4

  const { maxMag, slotW, barW } = useMemo(() => {
    let maxUp = 1
    let maxDown = 1
    for (const c of candles) {
      maxUp = Math.max(maxUp, c[upKey])
      maxDown = Math.max(maxDown, c[downKey])
    }
    let maxMag = Math.max(maxUp, maxDown, 1e-9)
    if (typeof maxScale === 'number') maxMag = maxScale
    const slotW = n > 0 ? plotW / n : plotW
    const barW = Math.max(3, Math.min(16, slotW * 0.55))
    return { maxMag, slotW, barW }
  }, [candles, upKey, downKey, maxScale, n, plotW])

  return (
    <figure className="breadth-chart-figure">
      <figcaption className="breadth-chart-title">{title}</figcaption>
      {subtitle && <p className="breadth-chart-sub">{subtitle}</p>}
      <div className="breadth-chart-svg-wrap">
        <svg
          className="breadth-chart-svg"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={title}
        >
          <line
            x1={PAD_L}
            y1={midY}
            x2={VW - PAD_R}
            y2={midY}
            className="breadth-chart-axis"
          />
          {candles.map((c, i) => {
            const x =
              PAD_L + (i + 0.5) * slotW - barW / 2
            const g = Number(c[upKey]) || 0
            const r = Number(c[downKey]) || 0
            const hG = (g / maxMag) * halfH
            const hR = (r / maxMag) * halfH
            return (
              <g key={c.index ?? i}>
                <rect
                  x={x}
                  y={midY - hG}
                  width={barW}
                  height={Math.max(hG, 0.5)}
                  className="breadth-bar breadth-bar--up"
                  rx={1}
                />
                <rect
                  x={x}
                  y={midY}
                  width={barW}
                  height={Math.max(hR, 0.5)}
                  className="breadth-bar breadth-bar--down"
                  rx={1}
                />
              </g>
            )
          })}
          <text
            x={PAD_L}
            y={VH - 10}
            className="breadth-chart-caption"
          >
            {upLabel} ↑ and {downLabel} ↓ on the same column · oldest → newest
          </text>
        </svg>
      </div>
    </figure>
  )
}

function SumCoinPctChart({ candles, symbolRows }) {
  const n = candles.length
  const plotW = VW - PAD_L - PAD_R
  const plotH = VH - PAD_T - PAD_B
  const midY = PAD_T + plotH / 2
  const halfH = plotH / 2 - 4

  const { sums, maxMag, slotW, barW } = useMemo(() => {
    const sums = sumCoinPctPerCandle(symbolRows, n)
    const maxAbs = Math.max(...sums.map((v) => Math.abs(v)), 0.01)
    const maxMag = maxAbs * 1.08
    const slotW = n > 0 ? plotW / n : plotW
    const barW = Math.max(3, Math.min(14, slotW * 0.55))
    return { sums, maxMag, slotW, barW }
  }, [symbolRows, n, plotW])

  const title = '3 · Sum of coin % change (per candle)'
  const subtitle =
    'Each bar is the sum of every coin’s open→close % for that candle (scales with how many symbols are included).'

  return (
    <figure className="breadth-chart-figure">
      <figcaption className="breadth-chart-title">{title}</figcaption>
      <p className="breadth-chart-sub">{subtitle}</p>
      <div className="breadth-chart-svg-wrap">
        <svg
          className="breadth-chart-svg"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={title}
        >
          <line
            x1={PAD_L}
            y1={midY}
            x2={VW - PAD_R}
            y2={midY}
            className="breadth-chart-axis"
          />
          {candles.map((c, i) => {
            const v = sums[i]
            const x = PAD_L + i * slotW + (slotW - barW) / 2
            const h = (Math.abs(v) / maxMag) * halfH
            if (v >= 0) {
              return (
                <rect
                  key={c.index ?? i}
                  x={x}
                  y={midY - h}
                  width={barW}
                  height={Math.max(h, 0.5)}
                  className="breadth-bar breadth-bar--up"
                  rx={1}
                />
              )
            }
            return (
              <rect
                key={c.index ?? i}
                x={x}
                y={midY}
                width={barW}
                height={Math.max(h, 0.5)}
                className="breadth-bar breadth-bar--down"
                rx={1}
              />
            )
          })}
          <text x={PAD_L} y={16} className="breadth-chart-y-label">
            {`max ≈ ${maxMag.toFixed(2)}%`}
          </text>
          <text
            x={PAD_L}
            y={VH - 10}
            className="breadth-chart-caption"
          >
            One bar per candle: height = sum of all coin % · center = 0
          </text>
        </svg>
      </div>
    </figure>
  )
}

function CumulativeSumLineChart({ candles, symbolRows }) {
  const n = candles.length
  const plotW = VW - PAD_L - PAD_R
  const plotTop = PAD_T
  const plotBottom = VH - PAD_B
  const plotH = plotBottom - plotTop

  const { pathD, areaD, zeroY, lastV, yMin, yMax } = useMemo(() => {
    const sums = sumCoinPctPerCandle(symbolRows, n)
    const cum = cumulativeSum(sums)
    let yMin = Math.min(...cum, 0)
    let yMax = Math.max(...cum, 0)
    const pad = (yMax - yMin) * 0.08 || 1
    yMin -= pad
    yMax += pad
    const span = Math.max(yMax - yMin, 1e-9)

    const xAt = (i) =>
      PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW)
    const yAt = (v) => plotBottom - ((v - yMin) / span) * plotH

    const pts = cum.map((v, i) => ({ x: xAt(i), y: yAt(v) }))
    const pathD =
      pts.length > 0
        ? `M ${pts.map((p) => `${p.x},${p.y}`).join(' L ')}`
        : ''
    const areaD =
      pts.length > 0
        ? `M ${pts[0].x},${plotBottom} ${pts.map((p) => `L ${p.x},${p.y}`).join(' ')} L ${pts[pts.length - 1].x},${plotBottom} Z`
        : ''
    const zeroY = yMin <= 0 && yMax >= 0 ? yAt(0) : null
    const lastV = cum.length ? cum[cum.length - 1] : 0
    return { pathD, areaD, zeroY, lastV, yMin, yMax }
  }, [symbolRows, n, plotW, plotH, plotBottom])

  const title = '4 · Cumulative sum of coin % (line)'
  const subtitle =
    'Running total of chart 3’s per-candle sums — same units, shows drift over the window.'

  return (
    <figure className="breadth-chart-figure">
      <figcaption className="breadth-chart-title">{title}</figcaption>
      <p className="breadth-chart-sub">{subtitle}</p>
      <div className="breadth-chart-svg-wrap">
        <svg
          className="breadth-chart-svg"
          viewBox={`0 0 ${VW} ${VH}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={title}
        >
          {zeroY != null && (
            <line
              x1={PAD_L}
              y1={zeroY}
              x2={VW - PAD_R}
              y2={zeroY}
              className="breadth-line-chart-zero"
            />
          )}
          {areaD ? (
            <path d={areaD} className="breadth-line-chart-area" />
          ) : null}
          {pathD ? (
            <path d={pathD} className="breadth-line-chart-line" />
          ) : null}
          <text x={PAD_L} y={16} className="breadth-chart-y-label">
            {`range ≈ ${yMin.toFixed(0)} … ${yMax.toFixed(0)} · end ${lastV.toFixed(1)}`}
          </text>
          <text
            x={PAD_L}
            y={VH - 10}
            className="breadth-chart-caption"
          >
            Oldest → newest · y = cumulative Σ (per-candle sum of coin %)
          </text>
        </svg>
      </div>
    </figure>
  )
}

export function BreadthBarCharts({ candles, symbolRows }) {
  if (!candles.length) return null

  return (
    <section className="breadth-charts" aria-label="Breadth bar charts">
      <h2 className="breadth-detail-title">Breadth charts (1–4)</h2>
      <DivergingPairChart
        candles={candles}
        upKey="green"
        downKey="red"
        upLabel="Green (count)"
        downLabel="Red (count)"
        title="1 · Coin counts per candle"
        subtitle="Each vertical slot is one candle: green count grows up from the line, red count grows down — same center line."
      />
      <DivergingPairChart
        candles={candles}
        upKey="greenPct"
        downKey="redPct"
        upLabel="Green %"
        downLabel="Red %"
        title="2 · Green % and red % per candle"
        subtitle="Same layout as chart 1: one column per candle, green % up / red % down from the midline (0–100% scale)."
        maxScale={100}
      />
      {symbolRows.length > 0 ? (
        <>
          <SumCoinPctChart candles={candles} symbolRows={symbolRows} />
          <CumulativeSumLineChart candles={candles} symbolRows={symbolRows} />
        </>
      ) : (
        <p className="breadth-chart-missing">
          Charts 3–4 need symbol rows (re-run breadth).
        </p>
      )}
    </section>
  )
}
