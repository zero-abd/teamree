// The editor in the terminal's colours, read from the theme's own tokens so a
// theme switch carries the editor with it.

import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const chrome = EditorView.theme(
  {
    '&': {
      height: '100%',
      color: 'var(--term-fg)',
      backgroundColor: 'var(--term-bg)',
      fontSize: 'var(--file-font-size, 12.5px)'
    },
    '&.cm-focused': { outline: 'none' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
    '.cm-content': { caretColor: 'var(--term-cursor)', padding: '6px 0' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--term-cursor)', borderLeftWidth: '2px' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
      { backgroundColor: 'var(--term-selection)' },
    '.cm-gutters': { backgroundColor: 'var(--term-bg)', color: 'var(--fg-muted)', border: 'none' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 14px' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--fg-secondary)' },
    '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-raised)', border: 'none', color: 'var(--fg-muted)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: 'var(--bg-press)',
      outline: '1px solid var(--line-strong)'
    },
    '.cm-selectionMatch': { backgroundColor: 'var(--bg-press)' },
    '.cm-searchMatch': { backgroundColor: 'var(--accent-soft)', outline: '1px solid var(--accent-line)' },
    '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-line)' },
    '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--fg)' },
    '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--line)' },
    '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--font-ui)', fontSize: 'var(--text-sm)' },
    '.cm-panel.cm-search input.cm-textfield': {
      backgroundColor: 'var(--bg-input)',
      color: 'var(--fg)',
      border: '1px solid var(--line-strong)',
      borderRadius: 'var(--r1)',
      fontSize: 'var(--text-sm)'
    },
    '.cm-panel.cm-search button.cm-button': {
      backgroundImage: 'none',
      backgroundColor: 'var(--bg-hover)',
      color: 'var(--fg-secondary)',
      border: '1px solid var(--line)',
      borderRadius: 'var(--r1)',
      fontSize: 'var(--text-sm)'
    },
    '.cm-panel.cm-search label': { color: 'var(--fg-secondary)' },
    '.cm-panel.cm-search [name=close]': { color: 'var(--fg-muted)' },
    '.cm-tooltip': { backgroundColor: 'var(--bg-raised)', border: '1px solid var(--line-strong)' }
  },
  { dark: true }
)

const highlight = HighlightStyle.define([
  {
    tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.modifier],
    color: 'var(--term-bright-magenta)'
  },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--term-bright-green)' },
  { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: 'var(--term-bright-yellow)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--fg-muted)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--term-bright-blue)' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName)], color: 'var(--term-bright-cyan)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--term-yellow)' },
  { tag: [t.tagName, t.angleBracket], color: 'var(--term-bright-red)' },
  { tag: [t.meta, t.annotation, t.processingInstruction], color: 'var(--term-magenta)' },
  { tag: [t.escape, t.self, t.special(t.variableName)], color: 'var(--term-cyan)' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: 'var(--fg-secondary)' },
  { tag: t.heading, color: 'var(--term-bright-blue)', fontWeight: '600' },
  { tag: [t.link, t.url], color: 'var(--term-cyan)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '600' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.inserted], color: 'var(--success)' },
  { tag: [t.deleted], color: 'var(--danger)' },
  { tag: t.invalid, color: 'var(--danger)' }
])

export const codeTheme: Extension = [chrome, syntaxHighlighting(highlight)]
