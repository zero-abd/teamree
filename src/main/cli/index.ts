// Public face of putting the CLI on PATH. The runtime imports from here.
//
// This is the main process's side of it. The CLI being linked is the one in
// src/cli, which ships next to the app as `resources/cli/teamree`.

export {
  administratorScript,
  appleScriptString,
  createAdministratorRunner,
  linkCommand,
  shellQuote,
  type AdministratorRunner
} from './administrator'
export {
  CLI_COMMAND_NAME,
  CLI_DESTINATION_DIRECTORY,
  CliService,
  LOGIN_PATHS_FILE,
  type CliPromptRecord,
  type CliServiceOptions
} from './cliService'
export { CLI_METHODS, createCliHandlers, registerCliHandlers, type CliHandlers, type CliMethodName } from './handlers'
export { findShippedCli, shippedCliCandidates, type ShippedCli, type ShippedCliOptions } from './shippedCli'
