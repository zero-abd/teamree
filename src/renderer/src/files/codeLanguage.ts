// The grammar for a file, by name. Each language is its own chunk, loaded the
// first time a file of it opens.

import { LanguageDescription, type LanguageSupport } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { filePaneName } from '@shared/filePane'

export function languageFor(path: string): LanguageDescription | null {
  return LanguageDescription.matchFilename(languages, filePaneName(path))
}

/** The loaded support for a path, or null for plain text or a grammar that failed to load. */
export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const description = languageFor(path)
  if (description === null) return null
  return description.load().catch(() => null)
}
