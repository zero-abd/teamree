// One table mapping a contract method to the schema that guards it and the
// handler that answers it. Nothing else in the runtime is allowed to know which
// methods exist, so adding a method is a single registration.

import type { z } from 'zod'
import type { MethodName, ParamsOf, ResultOf } from '../../shared/methods'
import type { RuntimeContext } from './runtimeContext'

/** Per-call identity. Subscriptions are keyed by the calling connection. */
export type CallContext = {
  readonly connectionId: string
}

export type MethodHandler<M extends MethodName> = (
  params: ParamsOf<M>,
  call: CallContext
) => ResultOf<M> | Promise<ResultOf<M>>

/** What the dispatcher sees: schema and handler with the method's types erased. */
export type RegisteredMethod = {
  readonly method: MethodName
  readonly schema: z.ZodType<unknown>
  readonly handler: (params: never, call: CallContext) => unknown
}

export class MethodRegistry {
  private readonly entries = new Map<string, RegisteredMethod>()

  constructor(readonly context: RuntimeContext) {}

  /** Registering a method that already exists replaces it: real handlers overwrite placeholders. */
  register<M extends MethodName>(method: M, schema: z.ZodType<ParamsOf<M>>, handler: MethodHandler<M>): void {
    this.entries.set(method, {
      method,
      schema: schema as unknown as z.ZodType<unknown>,
      handler: handler as unknown as RegisteredMethod['handler']
    })
  }

  lookup(method: string): RegisteredMethod | undefined {
    return this.entries.get(method)
  }

  has(method: string): boolean {
    return this.entries.has(method)
  }

  methods(): MethodName[] {
    return [...this.entries.keys()] as MethodName[]
  }
}
