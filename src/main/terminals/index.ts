// Public surface of the terminal service. The runtime imports from here.
// The wiring itself is spelled out at the top of method-handlers.ts.

export {
  createTerminalService,
  registerTerminalHandlers,
  terminalMethodSchemas
} from './method-handlers'
export type {
  MethodRegistry,
  StreamChannel,
  SubscriptionRegistrar,
  TerminalCallContext,
  TerminalHandlers,
  TerminalMethodName,
  TerminalService,
  TerminalServiceOptions
} from './method-handlers'

export { TerminalSessionManager } from './session-manager'
export type { LayoutRepository, TerminalSessionManagerOptions } from './session-manager'

export { isTerminalServiceError, TerminalServiceError } from './service-error'

export { SCROLLBACK_CAP_BYTES } from './scrollback'
export { buildTerminalEnv, resolveLoginShell } from './shell-environment'
