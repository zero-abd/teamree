// Markdown under Source: a leading YAML block is front matter, one muted block, not a rule and a setext heading.

import { markdown } from '@codemirror/lang-markdown'
import { LanguageSupport, syntaxTree } from '@codemirror/language'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { frontMatterTag } from './codeTheme'

const OPEN = /^---[ \t]*$/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/
/** A block parser sees one line ahead, so a `key:` line after the opener is what tells it from a rule. */
const FIRST_KEY = /^[^\s#-][^:]*:(?:[ \t]|$)/

export function markdownSource(): LanguageSupport {
  const support = markdown({
    extensions: {
      defineNodes: [{ name: 'FrontMatter', block: true, style: frontMatterTag }],
      parseBlock: [
        {
          name: 'FrontMatter',
          before: 'HorizontalRule',
          parse(cx, line) {
            if (cx.lineStart !== 0 || !OPEN.test(line.text) || !FIRST_KEY.test(cx.peekLine())) return false
            let to = line.text.length
            while (cx.nextLine()) {
              to = cx.lineStart + line.text.length
              if (!CLOSE.test(line.text)) continue
              cx.nextLine()
              break
            }
            cx.addElement(cx.elt('FrontMatter', 0, to))
            return true
          }
        }
      ]
    }
  })
  return new LanguageSupport(support.language, [support.support, frontMatterLines, frontMatterBlock])
}

const line = Decoration.line({ class: 'cm-frontMatter' })

function decorate(state: EditorState): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const block = syntaxTree(state).topNode.firstChild
  if (block?.name === 'FrontMatter') {
    for (let at = state.doc.lineAt(block.from).number; at <= state.doc.lineAt(block.to).number; at += 1) {
      builder.add(state.doc.line(at).from, state.doc.line(at).from, line)
    }
  }
  return builder.finish()
}

const frontMatterLines = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = decorate(view.state)
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) {
        this.decorations = decorate(update.state)
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
)

const frontMatterBlock = EditorView.baseTheme({ '.cm-frontMatter': { backgroundColor: 'var(--bg-panel)' } })
