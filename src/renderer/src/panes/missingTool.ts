// A shell's "command not found", read off a pane's output: which program is missing, and the usual way to get it.

export type MissingTool = { tool: string; fix?: string }

// zsh: `zsh:1: command not found: pnpm`; bash and sh: `bash: line 1: pnpm: command not found`, `sh: 1: pnpm: not found`.
const ZSH = /command not found: (\S+)\s*$/
const SH = /^[\w./-]*sh(?::\d+)?: (?:line \d+: |\d+: )?([^\s:]+): (?:command )?not found\s*$/

const FIXES: Readonly<Record<string, string>> = {
  pnpm: 'npm i -g pnpm',
  yarn: 'npm i -g yarn',
  bun: 'npm i -g bun',
  node: 'brew install node',
  npm: 'brew install node',
  npx: 'brew install node',
  deno: 'brew install deno',
  uv: 'brew install uv',
  poetry: 'brew install poetry',
  python: 'brew install python',
  python3: 'brew install python',
  pip: 'brew install python',
  pip3: 'brew install python',
  cargo: 'brew install rust',
  rustc: 'brew install rust',
  go: 'brew install go',
  bundle: 'gem install bundler',
  make: 'xcode-select --install'
}

/** The latest missing program these lines report, or null when they report none. */
export function missingTool(lines: readonly string[]): MissingTool | null {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = (lines[index] ?? '').trim()
    const tool = ZSH.exec(line)?.[1] ?? SH.exec(line)?.[1]
    if (tool === undefined) continue
    const fix = FIXES[tool]
    return fix === undefined ? { tool } : { tool, fix }
  }
  return null
}
