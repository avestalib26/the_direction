/**
 * Central tuning knobs for the psychology / behavioral dashboard.
 * Adjust these when calibrating to your own trading rhythm — avoid scattering
 * magic numbers across the engine.
 */

/** Gap with no closes that starts a new "session" (ms). */
export const SESSION_GAP_MS = 90 * 60 * 1000

/** Minimum closes needed before showing strong confidence in behavioral labels. */
export const MIN_CLOSES_FOR_FULL_MODEL = 12

/** Rolling equity peak: treat peak as max cumulative realized PnL so far. */
export const PEAK_EPS = 1e-8

/** Drawdown from peak thresholds (fraction of peak equity, 0–1) for mode + explanations. */
export const DD_DEFENSE = 0.1
export const DD_CAPITAL = 0.2
export const DD_WARN_STEPS = [0.05, 0.1, 0.15, 0.2, 0.25]

/** Overtrading: compare recent trade rate to baseline session rate. */
export const OVERTRADE_RATE_MULT_HIGH = 1.75
export const OVERTRADE_RATE_MULT_EXTREME = 2.5
export const OVERTRADE_WINDOW_MS = 60 * 60 * 1000

/** Burst clustering (trades in short window). */
export const BURST_WINDOW_MS = 15 * 60 * 1000
export const BURST_COUNT_ALERT = 5

/** Recovery chasing: must be underwater from peak + elevated activity. */
export const RECOVERY_DD_MIN = 0.03
export const RECOVERY_FREQ_MULT_MEDIUM = 1.35
export const RECOVERY_FREQ_MULT_HIGH = 1.7
export const RECOVERY_SYMBOL_ROTATION_MULT = 1.6

/** Random entry: distinct symbols vs baseline. */
export const RANDOM_SYMBOL_MULT_HIGH = 1.85
export const NEW_SYMBOLS_AFTER_LOSS_ALERT = 4

/** Loss cluster: consecutive losing closes. */
export const LOSS_STREAK_MEDIUM = 3
export const LOSS_STREAK_HIGH = 5

/** Same-side / theme proxy: many same positionSide in short time, different symbols. */
export const SIDE_CLUSTER_WINDOW_MS = 10 * 60 * 1000
export const SIDE_CLUSTER_MIN_TRADES = 4

/** Psychology score penalties (points off 100). */
export const PENALTY_DD_PER_TIER = 8
export const PENALTY_OVERTRADE_HIGH = 12
export const PENALTY_RECOVERY_EXTREME = 18
export const PENALTY_LOSS_STREAK = 10
