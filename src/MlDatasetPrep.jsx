/**
 * In-app pointer to the Python dataset pipeline under /ml (no training).
 */
export function MlDatasetPrep() {
  return (
    <div className="backtest1">
      <h1 className="backtest1-title">ML dataset preparation</h1>
      <p className="vol-screener-lead" style={{ textAlign: 'left', maxWidth: '42rem' }}>
        Part 1 runs <strong>outside the browser</strong>: a Python CLI in{' '}
        <code className="inline-code">ml/src/data/prepare_dataset.py</code> loads local 1h OHLCV
        files, builds the signed % feature, 50-candle input windows, time-based train/val/test
        splits, and exports <code className="inline-code">dataset.npz</code> plus metadata. No model
        is trained in this repo step.
      </p>

      <section className="hourly-spikes-section" style={{ marginTop: '1rem' }}>
        <h2 className="hourly-spikes-h2">Where the code lives</h2>
        <ul className="vol-screener-lead" style={{ textAlign: 'left', maxWidth: '40rem' }}>
          <li>
            <code className="inline-code">ml/src/data/prepare_dataset.py</code> — main CLI
          </li>
          <li>
            <code className="inline-code">ml/src/data/features.py</code> — signed candle feature
          </li>
          <li>
            <code className="inline-code">ml/src/data/validation.py</code> — export checks
          </li>
          <li>
            <code className="inline-code">ml/README.md</code> — full usage and output layout
          </li>
        </ul>
      </section>

      <section className="hourly-spikes-section">
        <h2 className="hourly-spikes-h2">Quick command</h2>
        <p className="hourly-spikes-hint">
          From <code className="inline-code">ml/</code> after <code className="inline-code">pip install -r requirements.txt</code>:
        </p>
        <pre
          className="inline-code"
          style={{
            display: 'block',
            padding: '0.75rem 1rem',
            overflow: 'auto',
            fontSize: '0.8rem',
            lineHeight: 1.45,
            background: 'var(--menu-surface)',
            borderRadius: 8,
            border: '1px solid var(--menu-border)',
          }}
        >
          {`python -m src.data.prepare_dataset \\
  --input-dir data/raw_ohlcv \\
  --output-dir data/ml_prepared \\
  --sequence-length 50 \\
  --min-candles-per-symbol 200 \\
  --train-end 2024-06-30T23:59:59+00:00 \\
  --val-end 2024-12-31T23:59:59+00:00 \\
  --test-end 2025-12-31T23:59:59+00:00 \\
  --save-format both`}
        </pre>
      </section>

      <section className="hourly-spikes-section">
        <h2 className="hourly-spikes-h2">Data you provide</h2>
        <p className="hourly-spikes-hint">
          Put one file per symbol under <code className="inline-code">ml/data/raw_ohlcv/</code> (or
          your <code className="inline-code">--input-dir</code>): CSV or Parquet with timestamp +
          OHLC (volume optional). See <code className="inline-code">ml/README.md</code> for column
          names and assumptions.
        </p>
      </section>
    </div>
  )
}
