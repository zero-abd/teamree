// THE SEAM. This is the whole surface the runtime wires up.
//
// In src/main/runtime/handlers/registerHandlers.ts:
//
//   import { createEditorActions, registerEditorHandlers } from '../../editor'
//   registerEditorHandlers(registry, createEditorActions())
//
// The actions are passed in rather than defaulted, so that a test wires its own
// probe and its own spawner and no harness can start an editor by forgetting an
// argument.
//
// Neither method is on `PEER_METHODS`, and that is the point of them being
// local: a teammate across a relay has no business launching a program on
// somebody else's machine, and `peerTransport.test.ts` says so by name.

import { Params } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { EditorActions } from './openInEditor'

export function registerEditorHandlers(registry: MethodRegistry, actions: EditorActions): EditorActions {
  registry.register('editor.list', Params.editorList, () => actions.list())
  registry.register('editor.open', Params.editorOpen, (params) => actions.open(params))
  return actions
}
