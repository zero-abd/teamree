// Types for `bin/teamree-relay.mjs`, which is plain JavaScript on purpose: it
// ships inside the installed app and runs there with no build step of its own,
// so there is nothing between the file in the repository and the file that
// runs. Its tests are TypeScript like the rest of the suite, and this is what
// lets them import it without `any` creeping in.
export declare const WRANGLER_SPEC: string
export declare const DEFAULT_DIR: string
export declare const TEMPLATE_DIRS: string[]
export declare const TEMPLATE_FILES: string[]
export declare const GENERATED_FILES: string[]

export interface ParsedArgs {
  command: string
  dir: string | null
  here: boolean
  dryRun: boolean
  writeOnly: boolean
  name: string | null
  help: boolean
  error: string | null
}

export declare function parseArgs(argv: string[]): ParsedArgs
export declare function templateRoot(scriptUrl?: string): string
export declare function missingTemplatePaths(root: string): string[]
export declare function templatePlan(root: string): { from: string; to: string }[]
export declare function relayPathFrom(wranglerConfig: string): string
export declare function generatedPackageJson(): string
export declare function generatedTsconfig(): string
export declare function generatedGitignore(): string
export declare function generatedReadme(relayPath: string): string
export declare function generatedProject(wranglerConfig: string): Record<string, string>
export declare function projectFault(dir: string): string | null
export declare function occupiedBy(dir: string): string | null
export declare function writeProject(root: string, target: string): { written: string[]; kept: string[] }
export declare function describeWrite(where: string, written: string[], kept: string[]): string
export declare function relayEndpointFrom(output: string, relayPath?: string): string | null
export declare function wranglerCommand(target: string): { command: string; args: string[] }
export declare function main(argv: string[], options?: { cwd?: string; root?: string }): Promise<void>
