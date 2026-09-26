// What leaves this machine when a note is shared, and the name a received one is saved under.

import { MAX_NOTE_TITLE_CHARS } from '@shared/sharedNote'

const IMAGE = /!\[([^\]]*)\]\(\s*<?([^\s)>]*)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g
const REMOTE = /^https?:\/\//i
const FENCE = /^\s{0,3}(`{3,}|~{3,})/

/**
 * The note as it is sent. A local image is a path on this machine, so it becomes its alt text;
 * a remote one stays in the text and the receiver never loads it.
 */
export function notePayload(markdown: string): { markdown: string; imagesLeftOut: number } {
  let imagesLeftOut = 0
  let fence: string | null = null
  const lines = markdown.split('\n').map((line) => {
    const marker = FENCE.exec(line)?.[1]
    if (marker !== undefined) {
      if (fence === null) fence = marker[0] ?? null
      else if (marker[0] === fence) fence = null
      return line
    }
    if (fence !== null) return line
    return line.replace(IMAGE, (whole, alt: string, src: string) => {
      if (REMOTE.test(src)) return whole
      imagesLeftOut += 1
      return alt.trim() === '' ? '\\[image\\]' : `\\[image: ${alt.trim()}\\]`
    })
  })
  return { markdown: lines.join('\n'), imagesLeftOut }
}

/** A note's title: its first top-level heading, else the file's name without the extension. */
export function noteTitle(markdown: string, path: string): string {
  const heading = /^#[ \t]+(.+?)[ \t#]*$/m.exec(markdown)?.[1]?.trim()
  const name = (path.split('/').pop() ?? path).replace(/\.(md|markdown)$/i, '')
  const title = heading !== undefined && heading !== '' ? heading : name
  return (title === '' ? 'Note' : title).slice(0, MAX_NOTE_TITLE_CHARS)
}

/** The file a saved copy is written to, at the worktree root; `attempt` counts names already taken. */
export function copyName(title: string, attempt = 0): string {
  const safe =
    title
      .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .slice(0, 80)
      .trim() || 'Shared note'
  return attempt === 0 ? `${safe}.md` : `${safe} ${attempt + 1}.md`
}
