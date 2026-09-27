// Errors nothing in the window caught: reported for the main process's log, and otherwise left
// alone, so the console still shows them and nothing on screen is torn down.

const RESIZE_OBSERVER_LOOP = /^ResizeObserver loop/

function describe(value: unknown): string {
  if (value instanceof Error) return value.stack ?? String(value)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Reports each uncaught error and unhandled rejection on `target`; returns the unwatch. */
export function watchWindowErrors(target: EventTarget, report: (details: string) => void): () => void {
  const onError = (event: Event): void => {
    const { error, message } = event as ErrorEvent
    if (RESIZE_OBSERVER_LOOP.test(message ?? '')) return
    report(`uncaught error\n${error === undefined || error === null ? message : describe(error)}`)
  }
  const onRejection = (event: Event): void => {
    report(`unhandled rejection\n${describe((event as PromiseRejectionEvent).reason)}`)
  }
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
