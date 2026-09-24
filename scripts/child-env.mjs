/** `env` without NODE_USE_SYSTEM_CA, which makes every node child read the macOS keychain. */
export function withoutSystemCa(env) {
  const { NODE_USE_SYSTEM_CA: _, ...rest } = env
  return rest
}
