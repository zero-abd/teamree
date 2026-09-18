// Types for `bin/teamree-relay.mjs`, which is plain JavaScript on purpose: it
// ships inside the installed app and runs there with no build step of its own,
// so there is nothing between the file in the repository and the file that
// runs. Its tests are TypeScript like the rest of the suite, and this is what
// lets them import it without `any` creeping in.
export declare const WRANGLER_SPEC: string
export declare const DEFAULT_DIR: string
export declare const TEMPLATE_DIRS: string[]
export declare const TEMPLATE_FILES: string[]
export declare const SERVE_TEMPLATE_DIRS: string[]
export declare const SERVE_DEFAULT_DIR: string
export declare const SERVE_DEFAULT_PORT: number
export declare const SERVE_DEFAULT_HOST: string
export declare const SERVE_LIMITATION: string
export declare const SERVE_TRUST: string
export declare const CHECK_TIMEOUT_MS: number
export declare const FALLBACK_RELAY_PATH: string
export declare const GENERATED_FILES: string[]

export interface ParsedArgs {
  command: string
  dir: string | null
  /** `check`'s one argument, moved out of the positional slot so no path logic can reach it. */
  url: string | null
  here: boolean
  dryRun: boolean
  writeOnly: boolean
  name: string | null
  port: number | null
  host: string | null
  help: boolean
  error: string | null
}

/** One network interface, as much of `os.NetworkInterfaceInfo` as `lanAddresses` reads. */
export interface InterfaceAddress {
  address: string
  family: string
  internal: boolean
}

/** What a dial produced: an HTTP answer, or a connection that never got one. */
export type CheckOutcome = { status: number; code?: undefined } | { code: string; status?: undefined }

export interface CheckVerdict {
  ok: boolean
  headline: string
  advice: string
}

export declare function parseArgs(argv: string[]): ParsedArgs
export declare function templateRoot(scriptUrl?: string): string
export declare function missingTemplatePaths(root: string, dirs?: string[], files?: string[]): string[]
export declare function templatePlan(root: string, dirs?: string[], files?: string[]): { from: string; to: string }[]
export declare function serveTemplatePlan(root: string): { from: string; to: string }[]
export declare function missingServeTemplatePaths(root: string): string[]
export declare function relayPathFrom(wranglerConfig: string): string
export declare function relayDefaultPath(root: string): string
export declare function generatedPackageJson(): string
export declare function generatedTsconfig(): string
export declare function generatedGitignore(): string
export declare function generatedReadme(relayPath: string): string
export declare function generatedProject(wranglerConfig: string): Record<string, string>
export declare function generatedServePackageJson(): string
export declare function generatedServeTsconfig(): string
export declare function generatedServeGitignore(): string
export declare function generatedServeReadme(relayPath: string): string
export declare function generatedServeProject(relayPath: string): Record<string, string>
export declare function projectFault(dir: string): string | null
export declare function serveProjectFault(dir: string): string | null
export declare function occupiedBy(dir: string, fault?: (dir: string) => string | null): string | null
export declare function writeProject(root: string, target: string): { written: string[]; kept: string[] }
export declare function writeServeProject(root: string, target: string): { written: string[]; kept: string[] }
export declare function describeWrite(where: string, written: string[], kept: string[]): string
export declare function describeServeWrite(where: string, written: string[], kept: string[]): string
export declare function relayEndpointFrom(output: string, relayPath?: string): string | null
export declare function wranglerCommand(target: string): { command: string; args: string[] }
export declare function npmCommand(): string
export declare function lanAddresses(interfaces?: Record<string, InterfaceAddress[] | undefined>): string[]
export declare function serveAnnouncement(where: {
  port: number
  path: string
  addresses: string[]
  /** What the relay was told to bind. Decides which of these URLs exist at all. */
  host?: string
}): string[]
/** Whether a bind address means "this machine only". */
export declare function isLoopbackHost(host: string): boolean
/** Whether one line of the relay's log is it saying it has bound. */
export declare function isListeningLine(line: string): boolean
/** Whether a socket error is this machine refusing the far end's certificate. */
export declare function isTlsFailure(code: unknown): boolean
export declare function checkTargetFault(url: string, relayPath?: string): string | null
export declare function describeCheck(url: string, outcome: CheckOutcome, relayPath?: string): CheckVerdict
export declare function checkRelay(url: string, options?: { timeoutMs?: number }): Promise<CheckOutcome>
export declare function main(argv: string[], options?: { cwd?: string; root?: string }): Promise<void>
