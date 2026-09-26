// How much an agent may do without asking, chosen per task. Default passes nothing, so the
// agent's own config decides; the flags are each CLI's own, checked against its `--help`.

export type PermissionMode = 'default' | 'auto' | 'bypass'

export const PERMISSION_MODES: readonly PermissionMode[] = ['default', 'auto', 'bypass']

const FLAGS: Readonly<Record<string, Readonly<Record<Exclude<PermissionMode, 'default'>, string>>>> = {
  claude: { auto: '--permission-mode auto', bypass: '--dangerously-skip-permissions' },
  codex: {
    auto: '--sandbox workspace-write --ask-for-approval on-request',
    bypass: '--dangerously-bypass-approvals-and-sandbox'
  }
}

/** The modes this harness offers, or none when its flags are unknown. */
export function permissionModesFor(kind: string): readonly PermissionMode[] {
  return Object.hasOwn(FLAGS, kind) ? PERMISSION_MODES : []
}

/** The command-line fragment for a mode; empty for Default and for a harness without modes. */
export function permissionArgs(kind: string, mode: PermissionMode): string {
  if (mode === 'default' || !Object.hasOwn(FLAGS, kind)) return ''
  return FLAGS[kind]?.[mode] ?? ''
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PERMISSION_MODES.some((mode) => mode === value)
}
