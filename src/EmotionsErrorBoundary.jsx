import { Component } from 'react'

export class EmotionsErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="emotions emotions--error-boundary">
          <div className="positions-error" role="alert">
            <p className="positions-error-title">Emotions dashboard crashed</p>
            <p className="positions-error-msg">
              {this.state.error?.message ?? String(this.state.error)}
            </p>
            <p className="emotions-error-hint">
              Open the browser console (F12) for the stack trace. Try{' '}
              <strong>Reset filters</strong> on this page or clear site data for this origin,
              then refresh.
            </p>
            <button
              type="button"
              className="btn-refresh"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
