"""Vectorized signed % feature for each OHLCV candle."""

from __future__ import annotations

import numpy as np
import pandas as pd


def compute_signed_candle_feature(
    df: pd.DataFrame,
    open_col: str = "open",
    high_col: str = "high",
    low_col: str = "low",
    close_col: str = "close",
) -> pd.Series:
    """
    Signed percentage feature per candle (1h assumed upstream).

    * Green or neutral (close >= open): ``((high - open) / open) * 100``
    * Red (close < open): ``-((open - low) / open) * 100``

    Non-positive ``open`` yields NaN. Inf values are replaced with NaN.
    """
    o = pd.to_numeric(df[open_col], errors="coerce")
    h = pd.to_numeric(df[high_col], errors="coerce")
    l = pd.to_numeric(df[low_col], errors="coerce")
    c = pd.to_numeric(df[close_col], errors="coerce")

    green = c >= o
    pos = (h - o) / o * 100.0
    neg = -(o - l) / o * 100.0
    out = np.where(green, pos, neg)
    out = np.where(o > 0, out, np.nan)
    out = np.asarray(out, dtype=np.float64)
    out[~np.isfinite(out)] = np.nan
    return pd.Series(out, index=df.index, name="signed_pct")
