// The whole surface the runtime wires up, from registerHandlers.ts. Actions are
// passed in, not defaulted, so no harness starts an editor by forgetting an
// argument. Neither method is on `PEER_METHODS`: a teammate must not launch programs here.

import { Params } from '../../shared/methods'
import type { MethodRegistry } from '../runtime/methodRegistry'
import type { EditorActions } from './openInEditor'

export function registerEditorHandlers(registry: MethodRegistry, actions: EditorActions): EditorActions {
  registry.register('editor.list', Params.editorList, () => actions.list())
  registry.register('editor.open', Params.editorOpen, (params) => actions.open(params))
  return actions
}
