#!/usr/bin/env node
// Thin shell around runCli: set the exit code and let stdout drain naturally
// rather than calling process.exit, which can truncate a piped JSON document.

import { runCli } from './run.js'

const code = await runCli(process.argv.slice(2))
process.exitCode = code
