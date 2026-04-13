# ML dataset preparation (Part 1)

This folder is self-contained Python code: **no model training** — only loading local 1h OHLCV files, building signed-% features, 50-candle windows, time-based splits, and export.

## Layout

| Path | Purpose |
|------|---------|
| `src/data/prepare_dataset.py` | CLI entry: load, clean, windows, split, save |
| `src/data/features.py` | `compute_signed_candle_feature` |
| `src/data/validation.py` | Post-export checks (leakage, shapes) |
| `data/raw_ohlcv/` | **You** place one CSV/Parquet per symbol (see below) |
| `data/ml_prepared/` | Default output (npz + parquet + json + previews) |

Adjust `--input-dir` / `--output-dir` if you keep data elsewhere.

## Raw file format

- One file per symbol: `BTCUSDT.csv`, `ETHUSDT.parquet`, etc.
- Required columns (names flexible; timestamp column auto-detected): **open, high, low, close**, plus **timestamp** / `open_time` / `datetime`.
- **volume** optional.
- Timestamps sorted ascending after load; 1h timeframe assumed.

## Install

From the repo root:

```bash
cd ml
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Run (example)

From the `ml` directory (so `src` resolves as a package):

```bash
cd ml
python -m src.data.prepare_dataset ^
  --input-dir data/raw_ohlcv ^
  --output-dir data/ml_prepared ^
  --sequence-length 50 ^
  --min-candles-per-symbol 200 ^
  --train-end 2024-06-30T23:59:59+00:00 ^
  --val-end 2024-12-31T23:59:59+00:00 ^
  --test-end 2025-12-31T23:59:59+00:00 ^
  --save-format both
```

Unix/macOS: use `\` line continuation or a single line.

### Flags

| Flag | Meaning |
|------|---------|
| `--input-dir` | Folder with per-symbol CSV/Parquet |
| `--output-dir` | Where `dataset.npz`, metadata, `dataset_summary.json` are written |
| `--sequence-length` | Default **50** |
| `--min-candles-per-symbol` | Skip thin symbols; must be **> sequence-length** |
| `--train-end` | Targets with `target_ts <= train_end` → train |
| `--val-end` | `train_end < target_ts <= val_end` → val |
| `--test-end` | `val_end < target_ts <= test_end` → test; omit for open-ended test |
| `--max-symbols` | Process only first N files (debug) |
| `--max-rows-per-symbol` | Keep only last N rows per symbol (debug) |
| `--save-format` | `npz`, `parquet`, or `both` (arrays in npz; metadata parquet or csv) |

## Output artifacts

- `dataset.npz` — `X_train`, `y_train`, `X_val`, `y_val`, `X_test`, `y_test`
- `meta_{train,val,test}.parquet` (or `.csv` if npz-only) — `symbol`, `target_ts`, `window_start_ts`, `window_end_ts` (ms)
- `dataset_summary.json` — counts, stats, per-symbol logs
- `meta_*_preview.csv` — first 200 rows per split

## UI

The main app includes **ML dataset** in the menu with a short pointer to this README and the command above.
