// A saved command as it crosses the wire and sits on disk: trimmed, bounded, and a kind this build knows.

import { z } from 'zod'
import { MAX_AGENT_ARGS_CHARS } from './agentLaunch'
import type { AgentKind, SavedCommand } from './entities'
import { MAX_SAVED_COMMANDS } from './savedCommands'

export const SavedCommandSchema: z.ZodType<SavedCommand> = z.object({
  id: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(MAX_AGENT_ARGS_CHARS),
  kind: z.enum(['shell', 'agent']),
  where: z.enum(['new', 'current', 'task']),
  // Checked against the agents found when it runs; an unknown one falls back to the default.
  agent: z.custom<AgentKind>((value) => typeof value === 'string' && /^[a-z]{1,32}$/.test(value)).optional()
})

export const SavedCommandList = z.array(SavedCommandSchema).max(MAX_SAVED_COMMANDS)
