// `teamree guide [topic]`: the agent guide for this build, from `guideTopics.ts`.

import type { CommandSpec } from '../command-spec.js'
import { UsageError } from '../exit.js'
import { GUIDE_TOPICS, type GuideTopic } from '../guideTopics.js'

/** The topics this build can teach, given its command table. */
export function availableTopics(commands: readonly CommandSpec[]): GuideTopic[] {
  const find = (path: readonly string[]): CommandSpec | undefined =>
    commands.find((spec) => spec.path.length === path.length && spec.path.every((word, index) => word === path[index]))
  return GUIDE_TOPICS.filter((topic) => topic.needs?.(find) ?? true)
}

/** One topic's text, the first topic ending with where the others are. */
export function guideText(topics: readonly GuideTopic[], name: string | undefined): string {
  const [first] = topics
  const topic = name === undefined ? first : topics.find((entry) => entry.name === name)
  if (topic === undefined || first === undefined) {
    throw new UsageError(`No guide topic "${name}".`, `Topics: ${topics.map((entry) => entry.name).join(', ')}.`)
  }
  const others = topics.filter((entry) => entry !== first)
  if (topic !== first || others.length === 0) return topic.text
  return `${topic.text}\n\nMore: ${others.map((entry) => `teamree guide ${entry.name} (${entry.summary})`).join('; ')}`
}

/** `commands` is read when the command runs, so the table can hold this spec. */
export function guideCommands(commands: () => readonly CommandSpec[]): readonly CommandSpec[] {
  return [
    {
      path: ['guide'],
      summary: 'Print the agent guide for this build.',
      args: [{ name: 'topic', description: 'pane (default), or a topic the first page lists.', required: false }],
      examples: ['teamree guide', 'teamree guide tree'],
      offline: true,
      run: async (context) => {
        const name = context.args[0]
        const text = guideText(availableTopics(commands()), name)
        return { data: { topic: name ?? 'pane', text }, text }
      }
    }
  ]
}
