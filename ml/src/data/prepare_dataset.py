#!/usr/bin/env python3
"""
Part 1: Dataset preparation for 1h signed-% sequence model (no training).

Run from repo root or ml/:
  python -m src.data.prepare_dataset --help
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

# Allow running as script from ml/ directory
_ML_ROOT = Path(__file__).resolve().parents[2]
if str(_ML_ROOT) not in sys.path:
    sys.path.insert(0, str(_ML_ROOT))

from src.data.features import compute_signed_candle_feature  # noqa: E402

logger = logging.getLogger(__name__)

REQUIRED_OHLC = ("open", "high", "low", "close")
TS_CANDIDATES = (
    "timestamp",
    "time",
    "datetime",
    "open_time",
    "openTime",
    "t",
    "ts",
)


@dataclass
class SymbolLog:
    symbol: str
    rows_loaded: int = 0
    rows_after_clean: int = 0
    rows_dropped_invalid_ohlc: int = 0
    rows_dropped_dup_ts: int = 0
    rows_dropped_feature_nan: int = 0
    skipped_reason: str | None = None


@dataclass
class RunStats:
    symbol_logs: list[SymbolLog] = field(default_factory=list)
    total_samples: int = 0


def _find_timestamp_column(df: pd.DataFrame) -> str:
    lower = {c.lower(): c for c in df.columns}
    for name in TS_CANDIDATES:
        if name in df.columns:
            return name
        if name.lower() in lower:
            return lower[name.lower()]
    raise ValueError(f"No timestamp column; have {list(df.columns)}")


def _normalize_ohlcv(df: pd.DataFrame) -> pd.DataFrame:
    """Rename common variants to open, high, low, close, volume."""
    lower = {c.lower().strip(): c for c in df.columns}
    mapping: dict[str, str] = {}
    for want in list(REQUIRED_OHLC) + ("volume",):
        if want in df.columns:
            continue
        if want in lower:
            mapping[lower[want]] = want
    out = df.rename(columns=mapping)
    for c in REQUIRED_OHLC:
        if c not in out.columns:
            raise ValueError(f"Missing column {c}")
    return out


def load_symbol_file(path: Path) -> tuple[pd.DataFrame, str]:
    """Load CSV or Parquet; return (df, symbol stem)."""
    sym = path.stem.upper().replace("-", "")
    if path.suffix.lower() == ".csv":
        df = pd.read_csv(path)
    elif path.suffix.lower() in (".parquet", ".pq"):
        df = pd.read_parquet(path)
    else:
        raise ValueError(f"Unsupported format: {path.suffix}")
    ts_col = _find_timestamp_column(df)
    df = df.rename(columns={ts_col: "timestamp"})
    df = _normalize_ohlcv(df)
    if "volume" not in df.columns:
        df["volume"] = np.nan
    return df, sym


def clean_ohlcv(df: pd.DataFrame, symbol: str, log: SymbolLog) -> pd.DataFrame:
    """Sort by time, drop dupes, enforce sane OHLC."""
    df = df.copy()
    df["timestamp"] = pd.to_datetime(df["timestamp"], utc=True, errors="coerce")
    n0 = len(df)
    df = df.dropna(subset=["timestamp"])
    for c in REQUIRED_OHLC:
        df[c] = pd.to_numeric(df[c], errors="coerce")

    df = df.sort_values("timestamp").reset_index(drop=True)
    dup = df.duplicated(subset=["timestamp"], keep="first")
    log.rows_dropped_dup_ts = int(dup.sum())
    df = df.loc[~dup].reset_index(drop=True)

    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    valid = (
        (o > 0)
        & (h >= l)
        & (h >= o)
        & (h >= c)
        & (l <= o)
        & (l <= c)
        & np.isfinite(o)
        & np.isfinite(h)
        & np.isfinite(l)
        & np.isfinite(c)
    )
    log.rows_dropped_invalid_ohlc = int((~valid).sum())
    df = df.loc[valid].reset_index(drop=True)

    log.rows_loaded = n0
    log.rows_after_clean = len(df)
    return df


def _ts_series_to_ms(timestamps: pd.Series) -> np.ndarray:
    """UTC timestamps to epoch milliseconds (int64)."""
    t = pd.to_datetime(timestamps, utc=True, errors="coerce")
    ns = t.astype("int64")
    return (ns // 1_000_000).astype(np.int64)


def build_windows_for_symbol(
    df: pd.DataFrame,
    symbol: str,
    feature: pd.Series,
    seq_len: int,
    timestamps: pd.Series,
) -> tuple[np.ndarray, np.ndarray, list[dict[str, Any]]]:
    """Rolling windows; target = feature at index seq_len (next candle)."""
    feat = feature.to_numpy(dtype=np.float64)
    ts = _ts_series_to_ms(timestamps)
    n = len(feat)
    if n < seq_len + 1:
        return (
            np.empty((0, seq_len), dtype=np.float64),
            np.empty((0,), dtype=np.float64),
            [],
        )

    xs: list[np.ndarray] = []
    ys: list[float] = []
    meta_rows: list[dict[str, Any]] = []

    for i in range(0, n - seq_len):
        w = feat[i : i + seq_len]
        y = feat[i + seq_len]
        if not np.all(np.isfinite(w)) or not np.isfinite(y):
            continue
        xs.append(w.copy())
        ys.append(float(y))
        t_target = int(ts[i + seq_len])
        t_start = int(ts[i])
        t_end = int(ts[i + seq_len - 1])
        meta_rows.append(
            {
                "symbol": symbol,
                "target_ts": t_target,
                "window_start_ts": t_start,
                "window_end_ts": t_end,
            }
        )

    if not xs:
        return (
            np.empty((0, seq_len), dtype=np.float64),
            np.empty((0,), dtype=np.float64),
            [],
        )
    return np.stack(xs, axis=0), np.asarray(ys, dtype=np.float64), meta_rows


def time_split_samples(
    meta: pd.DataFrame,
    X: np.ndarray,
    y: np.ndarray,
    train_end: pd.Timestamp,
    val_end: pd.Timestamp,
    test_end: pd.Timestamp | None,
) -> tuple[tuple[np.ndarray, np.ndarray], ...]:
    """Split by target_ts (ms int) with strict ordering."""
    ts = meta["target_ts"].to_numpy()
    train_end_ms = int(train_end.value // 10**6)
    val_end_ms = int(val_end.value // 10**6)
    test_end_ms = int(test_end.value // 10**6) if test_end is not None else None

    m_train = ts <= train_end_ms
    m_val = (ts > train_end_ms) & (ts <= val_end_ms)
    if test_end_ms is not None:
        m_test = (ts > val_end_ms) & (ts <= test_end_ms)
    else:
        m_test = ts > val_end_ms

    def take(m: np.ndarray) -> tuple[np.ndarray, np.ndarray, pd.DataFrame]:
        return X[m], y[m], meta.loc[m].reset_index(drop=True)

    return take(m_train), take(m_val), take(m_test)


def save_outputs(
    output_dir: Path,
    train: tuple,
    val: tuple,
    test: tuple,
    save_npz: bool,
    save_parquet_meta: bool,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    (X_tr, y_tr, meta_tr) = train
    (X_va, y_va, meta_va) = val
    (X_te, y_te, meta_te) = test

    if save_npz:
        np.savez_compressed(
            output_dir / "dataset.npz",
            X_train=X_tr,
            y_train=y_tr,
            X_val=X_va,
            y_val=y_va,
            X_test=X_te,
            y_test=y_te,
        )

    # Metadata is small; always persist parquet when pyarrow available for downstream checks
    if save_parquet_meta:
        meta_tr.to_parquet(output_dir / "meta_train.parquet", index=False)
        meta_va.to_parquet(output_dir / "meta_val.parquet", index=False)
        meta_te.to_parquet(output_dir / "meta_test.parquet", index=False)
    else:
        meta_tr.to_csv(output_dir / "meta_train.csv", index=False)
        meta_va.to_csv(output_dir / "meta_val.csv", index=False)
        meta_te.to_csv(output_dir / "meta_test.csv", index=False)


def target_direction_stats(y: np.ndarray) -> dict[str, float]:
    pos = float(np.sum(y > 0))
    neg = float(np.sum(y < 0))
    zero = float(np.sum(y == 0))
    n = len(y) or 1
    return {
        "pct_positive": 100.0 * pos / n,
        "pct_negative": 100.0 * neg / n,
        "pct_zero": 100.0 * zero / n,
    }


def run_pipeline(args: argparse.Namespace) -> dict[str, Any]:
    rng = np.random.default_rng(args.seed)
    _ = rng  # reserved for future subsampling

    input_dir = Path(args.input_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    seq_len = args.sequence_length

    files = sorted(input_dir.glob("*.csv")) + sorted(input_dir.glob("*.parquet"))
    if not files:
        files = sorted(input_dir.glob("*.pq"))
    if args.max_symbols:
        files = files[: args.max_symbols]

    train_end = pd.Timestamp(args.train_end, tz="UTC")
    val_end = pd.Timestamp(args.val_end, tz="UTC")
    test_end = (
        pd.Timestamp(args.test_end, tz="UTC") if args.test_end else None
    )
    if not train_end < val_end:
        raise ValueError("train_end must be < val_end")
    if test_end is not None and not val_end <= test_end:
        raise ValueError("val_end must be <= test_end when test_end is set")

    all_X: list[np.ndarray] = []
    all_y: list[np.ndarray] = []
    all_meta: list[pd.DataFrame] = []
    stats = RunStats()

    for path in files:
        log = SymbolLog(symbol=path.stem.upper())
        try:
            df, sym = load_symbol_file(path)
            df = clean_ohlcv(df, sym, log)
            if args.max_rows_per_symbol and len(df) > args.max_rows_per_symbol:
                df = df.iloc[-args.max_rows_per_symbol :].reset_index(drop=True)

            if len(df) < args.min_candles_per_symbol:
                log.skipped_reason = (
                    f"only {len(df)} rows < min_candles {args.min_candles_per_symbol}"
                )
                stats.symbol_logs.append(log)
                logger.warning("Skip %s: %s", sym, log.skipped_reason)
                continue

            feat = compute_signed_candle_feature(df)
            bad = ~np.isfinite(feat.to_numpy())
            log.rows_dropped_feature_nan = int(bad.sum())
            df = df.loc[~bad].reset_index(drop=True)
            feat = feat.loc[~bad].reset_index(drop=True)

            if len(df) < args.min_candles_per_symbol:
                log.skipped_reason = "insufficient rows after feature NaN drop"
                stats.symbol_logs.append(log)
                continue

            ts_series = df["timestamp"]
            Xs, ys, meta_list = build_windows_for_symbol(
                df, sym, feat, seq_len, ts_series
            )
            if len(ys) == 0:
                log.skipped_reason = "no valid windows"
                stats.symbol_logs.append(log)
                continue

            meta_df = pd.DataFrame(meta_list)
            all_X.append(Xs)
            all_y.append(ys)
            all_meta.append(meta_df)
            stats.symbol_logs.append(log)
            logger.info(
                "OK %s: samples=%d rows_clean=%d",
                sym,
                len(ys),
                log.rows_after_clean,
            )
        except Exception as e:
            log.skipped_reason = str(e)
            stats.symbol_logs.append(log)
            logger.exception("Failed %s: %s", path, e)

    if not all_X:
        raise RuntimeError("No samples produced; check input paths and filters.")

    X = np.concatenate(all_X, axis=0)
    y = np.concatenate(all_y, axis=0)
    meta = pd.concat(all_meta, axis=0, ignore_index=True)
    stats.total_samples = len(y)

    train_d, val_d, test_d = time_split_samples(
        meta, X, y, train_end, val_end, test_end
    )

    for label, td in ("train", train_d), ("val", val_d), ("test", test_d):
        if td[0].shape[0] == 0:
            logger.warning("Split %s has 0 samples — check --train-end / --val-end / data range", label)

    save_npz = args.save_format in ("npz", "both")
    save_pq_meta = args.save_format in ("parquet", "both")
    save_outputs(output_dir, train_d, val_d, test_d, save_npz, save_pq_meta)

    summary = {
        "symbols_processed": len([s for s in stats.symbol_logs if s.skipped_reason is None]),
        "symbols_skipped": len([s for s in stats.symbol_logs if s.skipped_reason is not None]),
        "total_samples_concat": stats.total_samples,
        "train_samples": int(train_d[0].shape[0]),
        "val_samples": int(val_d[0].shape[0]),
        "test_samples": int(test_d[0].shape[0]),
        "sequence_length": seq_len,
        "train_end": train_end.isoformat(),
        "val_end": val_end.isoformat(),
        "test_end": test_end.isoformat() if test_end is not None else None,
        "y_train_stats": (
            {
                "mean": float(np.mean(train_d[1])),
                "std": float(np.std(train_d[1])),
                "min": float(np.min(train_d[1])),
                "max": float(np.max(train_d[1])),
                **target_direction_stats(train_d[1]),
            }
            if train_d[1].size
            else {}
        ),
        "y_val_stats": (
            {
                "mean": float(np.mean(val_d[1])),
                "std": float(np.std(val_d[1])),
            }
            if val_d[1].size
            else {}
        ),
        "y_test_stats": (
            {
                "mean": float(np.mean(test_d[1])),
                "std": float(np.std(test_d[1])),
            }
            if test_d[1].size
            else {}
        ),
        "example_train_samples": (
            [
                {
                    "X_first_5": train_d[0][i, :5].tolist(),
                    "y": float(train_d[1][i]),
                }
                for i in range(min(3, train_d[0].shape[0]))
            ]
            if train_d[0].shape[0] > 0
            else []
        ),
        "symbol_logs": [
            {
                "symbol": s.symbol,
                "rows_loaded": s.rows_loaded,
                "rows_after_clean": s.rows_after_clean,
                "dropped_dup_ts": s.rows_dropped_dup_ts,
                "dropped_invalid_ohlc": s.rows_dropped_invalid_ohlc,
                "dropped_feature_nan": s.rows_dropped_feature_nan,
                "skipped_reason": s.skipped_reason,
            }
            for s in stats.symbol_logs
        ],
    }

    with open(output_dir / "dataset_summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2)

    # Preview CSV from metadata
    for name, mdf in (
        ("meta_train_preview", train_d[2].head(200)),
        ("meta_val_preview", val_d[2].head(200)),
        ("meta_test_preview", test_d[2].head(200)),
    ):
        mdf.to_csv(output_dir / f"{name}.csv", index=False)

    print(json.dumps(summary["y_train_stats"], indent=2))
    print("Samples:", summary["train_samples"], summary["val_samples"], summary["test_samples"])
    logger.info("Wrote dataset to %s", output_dir)
    return summary


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Prepare 1h signed-% sequence dataset (train/val/test by time)."
    )
    p.add_argument(
        "--input-dir",
        type=str,
        default=str(Path("data/raw_ohlcv")),
        help="Directory with one CSV/Parquet per symbol",
    )
    p.add_argument(
        "--output-dir",
        type=str,
        default=str(Path("data/ml_prepared")),
        help="Output directory for npz/parquet/json",
    )
    p.add_argument("--sequence-length", type=int, default=50)
    p.add_argument(
        "--min-candles-per-symbol",
        type=int,
        default=200,
        help="Minimum clean rows required per symbol (must exceed sequence_length)",
    )
    p.add_argument(
        "--train-end",
        type=str,
        required=True,
        help="ISO8601 UTC: targets with target_ts <= this go to train",
    )
    p.add_argument(
        "--val-end",
        type=str,
        required=True,
        help="Train < target_ts <= val_end -> validation",
    )
    p.add_argument(
        "--test-end",
        type=str,
        default=None,
        help="Val < target_ts <= test_end -> test; omit for open-ended test",
    )
    p.add_argument("--max-symbols", type=int, default=None)
    p.add_argument("--max-rows-per-symbol", type=int, default=None)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument(
        "--save-format",
        choices=("npz", "parquet", "both"),
        default="both",
        help="Export arrays (npz) and/or metadata parquet",
    )
    p.add_argument("--log-level", default="INFO")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    logging.basicConfig(
        level=getattr(logging, args.log_level.upper(), logging.INFO),
        format="%(levelname)s %(name)s: %(message)s",
    )
    if args.min_candles_per_symbol <= args.sequence_length:
        raise SystemExit("min_candles_per_symbol must be > sequence_length")

    # Chdir to ml/ so default paths resolve if user runs from repo root
    ml_root = Path(__file__).resolve().parents[2]
    if Path.cwd().resolve() != ml_root and (ml_root / "src").is_dir():
        logger.info("Tip: run from %s or pass absolute --input-dir / --output-dir", ml_root)

    run_pipeline(args)

    # Post-validate
    from src.data.validation import validate_exported_dataset  # noqa: WPS433

    out = Path(args.output_dir)
    if not out.is_absolute():
        out = (Path.cwd() / out).resolve()
    rep = validate_exported_dataset(
        out,
        sequence_length=args.sequence_length,
        train_end_ts=None,
        val_end_ts=None,
    )
    if not rep["ok"]:
        logger.warning("Post-validation reported: %s", rep["issues"])
        if any("shape" in x or "non-finite" in x for x in rep["issues"]):
            sys.exit(1)


if __name__ == "__main__":
    main()
