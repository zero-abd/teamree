// Channel names for the renderer transport. The preload script cannot import
// this module without pulling main-process files into the renderer's TypeScript
// project, so it repeats the same literals; change both together.

export const RPC_CALL_CHANNEL = 'teamree:rpc:call'
export const RPC_STREAM_CHANNEL = 'teamree:rpc:stream'
/** Renderer says its page is going away, so its subscriptions can be dropped. */
export const RPC_RELEASE_CHANNEL = 'teamree:rpc:release'
