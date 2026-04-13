"""Post-export checks for train/val/test ML datasets."""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

import numpy as np

logger = logging.getLogger(__name__)


def validate_exported_dataset(
    output_dir: Path,
    sequence_length: int = 50,
    train_end_ts: int | None = None,
    val_end_ts: int | None = None,
) -> dict[str, Any]:
    """
    Load NPZ splits and metadata; assert shapes, no NaN/inf, time ordering, no leakage.

    Expects files: X_train.npz components or dataset.npz with keys X_train, y_train, ...
    We save separate npz per split: X_train.npz contains array 'X', y_train.npz contains 'y'
    OR combined ml_dataset.npz - the prepare script saves:
      dataset.npz with keys X_train, y_train, X_val, y_val, X_test, y_test

    And parquet: meta_train.parquet, meta_val.parquet, meta_test.parquet with column target_ts (ms).
    """
    output_dir = Path(output_dir)
    combined = output_dir / "dataset.npz"
    if not combined.is_file():
        raise FileNotFoundError(f"Missing {combined}")

    data = np.load(combined, allow_pickle=True)
    issues: list[str] = []

    def check_xy(name_x: str, name_y: str, label: str) -> None:
        x = data[name_x]
        y = data[name_y]
        if x.ndim != 2 or x.shape[1] != sequence_length:
            issues.append(f"{label}: X shape {x.shape}, expected (*, {sequence_length})")
        if y.ndim != 1 or y.shape[0] != x.shape[0]:
            issues.append(f"{label}: y shape {y.shape} vs X rows {x.shape[0]}")
        if not np.isfinite(x).all():
            issues.append(f"{label}: non-finite values in X")
        if not np.isfinite(y).all():
            issues.append(f"{label}: non-finite values in y")

    check_xy("X_train", "y_train", "train")
    check_xy("X_val", "y_val", "val")
    check_xy("X_test", "y_test", "test")

    # Metadata timestamps (pandas optional here — use parquet if exists)
    try:
        import pandas as pd
    except ImportError:
        pd = None  # type: ignore

    if pd is not None:
        def _load_meta_triplet() -> tuple[Any, Any, Any] | None:
            for ext, reader in (
                (".parquet", pd.read_parquet),
                (".csv", pd.read_csv),
            ):
                a, b, c = (
                    output_dir / f"meta_train{ext}",
                    output_dir / f"meta_val{ext}",
                    output_dir / f"meta_test{ext}",
                )
                if a.is_file() and b.is_file() and c.is_file():
                    return reader(a), reader(b), reader(c)
            return None

        loaded = _load_meta_triplet()
        if loaded is not None:
            mt, mv, mte = loaded
            for col in ("target_ts",):
                if col not in mt.columns:
                    issues.append(f"meta_train missing {col}")
            if not issues:
                if len(mt) > 0 and len(mv) > 0:
                    t_max_train = mt["target_ts"].max()
                    t_min_val = mv["target_ts"].min()
                    if t_max_train >= t_min_val:
                        issues.append(
                            f"Leakage: train max target_ts {t_max_train} >= val min {t_min_val}"
                        )
                if len(mv) > 0 and len(mte) > 0:
                    t_max_val = mv["target_ts"].max()
                    t_min_test = mte["target_ts"].min()
                    if t_max_val >= t_min_test:
                        issues.append(
                            f"Leakage: val max target_ts {t_max_val} >= test min {t_min_test}"
                        )
                if len(mt) > 0 and train_end_ts is not None:
                    t_max_train = mt["target_ts"].max()
                    if t_max_train > train_end_ts:
                        issues.append(
                            f"Train target_ts max {t_max_train} > train_end {train_end_ts}"
                        )
                if len(mv) > 0 and val_end_ts is not None:
                    if mv["target_ts"].max() > val_end_ts:
                        issues.append("Val target_ts exceeds val_end")
    summary_path = output_dir / "dataset_summary.json"
    if summary_path.is_file():
        with open(summary_path, encoding="utf-8") as f:
            json.load(f)
    else:
        issues.append("Missing dataset_summary.json")

    ok = len(issues) == 0
    report = {"ok": ok, "issues": issues}
    if ok:
        logger.info("Validation passed: %s", output_dir)
    else:
        logger.warning("Validation issues: %s", issues)
    return report
