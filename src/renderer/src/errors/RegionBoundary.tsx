// One region of the window that can fail on its own: a render error there replaces that region with
// one line, and the sidebar, workspace and dialogs each keep working without the others.

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { copyText } from '../clipboard/clipboard'

type Props = {
  /** Named in the log, so a report says where it came from. */
  region: string
  children?: ReactNode
  /** A new value starts the region over, as a newly opened dialog should. */
  resetKey?: string
  /** Offers Close instead of Retry, for a region that can simply go. */
  onDismiss?: () => void
}

type State = { details: string | null; resetKey: string | undefined }

export class RegionBoundary extends Component<Props, State> {
  override state: State = { details: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { details: error instanceof Error ? (error.stack ?? String(error)) : String(error) }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey === state.resetKey ? null : { details: null, resetKey: props.resetKey }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const stack = error instanceof Error ? (error.stack ?? String(error)) : String(error)
    const details = `${this.props.region}: ${stack}${info.componentStack ?? ''}`
    this.setState({ details })
    try {
      window.teamree?.errors?.report(details)
    } catch {
      // The line on screen already says it; the log is a nicety.
    }
  }

  override render(): ReactNode {
    const { details } = this.state
    if (details === null) return this.props.children
    const { onDismiss } = this.props
    return (
      <div className="region-error" role="alert" data-region={this.props.region}>
        <span className="region-error__text">Something went wrong</span>
        {onDismiss === undefined ? (
          <button type="button" className="notice__action" onClick={() => this.setState({ details: null })}>
            Retry
          </button>
        ) : (
          <button type="button" className="notice__action" onClick={onDismiss}>
            Close
          </button>
        )}
        <button type="button" className="notice__action" onClick={() => copyText(details)}>
          Copy Details
        </button>
      </div>
    )
  }
}
