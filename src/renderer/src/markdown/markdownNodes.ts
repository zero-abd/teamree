// The nodes the schema has beyond markdown's own — raw HTML kept verbatim, an
// artifact link card, a GitHub alert — and the code block and image drawn our way.

import { mergeAttributes, Node } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { Image, type ImageOptions } from '@tiptap/extension-image'
import { CODE_LANGUAGES } from './codeLanguages'

/** A block of raw HTML, drawn as it was written and saved back the same way. */
export const HtmlBlock = Node.create({
  name: 'htmlBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { html: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'pre[data-html-block]', getAttrs: (element) => ({ html: element.textContent ?? '' }) }]
  },
  renderHTML({ node }) {
    return ['pre', { 'data-html-block': '', class: 'md-html' }, String(node.attrs.html)]
  }
})

/** Top-level `key: value` rows of a YAML block; nested lines join their key's value, which ends at `end`. */
export function frontMatterRows(yaml: string): { key: string; value: string; end: number }[] {
  const rows: { key: string; value: string; end: number }[] = []
  let at = 0
  for (const line of yaml.split('\n')) {
    const key = /^([^\s#-][^:]*):(?:[ \t]+(.*))?$/.exec(line)
    const last = rows[rows.length - 1]
    const end = at + line.trimEnd().length
    at += line.length + 1
    if (key !== null) rows.push({ key: (key[1] ?? '').trim(), value: (key[2] ?? '').trim(), end })
    else if (last !== undefined && line.trim().length > 0 && !line.trim().startsWith('#')) {
      const item = line.trim().replace(/^-[ \t]+/, '')
      last.value = last.value.length > 0 ? `${last.value}, ${item}` : item
      last.end = end
    }
  }
  return rows
}

/** YAML front matter, drawn as property rows; a click edits the YAML as written. */
export const FrontMatter = Node.create({
  name: 'frontMatter',
  group: 'block',
  atom: true,
  // Else the page opens with it selected, and the first key typed replaces it.
  selectable: false,
  draggable: false,
  addAttributes() {
    return { yaml: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-front-matter]', getAttrs: (element) => ({ yaml: element.textContent ?? '' }) }]
  },
  renderHTML({ node }) {
    return ['div', { 'data-front-matter': '', class: 'md-props' }, String(node.attrs.yaml)]
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'md-props'
      dom.setAttribute('data-front-matter', '')
      dom.contentEditable = 'false'
      const rows = document.createElement('dl')
      rows.className = 'md-props__rows'
      const source = document.createElement('textarea')
      source.className = 'md-props__source'
      source.spellcheck = false
      source.setAttribute('aria-label', 'Front matter')
      const draw = (): void => {
        const yaml = String(current.attrs.yaml)
        const found = frontMatterRows(yaml)
        rows.replaceChildren(
          ...found.flatMap(({ key, value, end }) => {
            const term = document.createElement('dt')
            term.textContent = key
            const detail = document.createElement('dd')
            detail.textContent = value
            term.dataset.end = detail.dataset.end = String(end)
            return [term, detail]
          })
        )
        if (found.length === 0) rows.textContent = yaml.length > 0 ? yaml : 'front matter'
      }
      const editing = (on: boolean): void => {
        dom.classList.toggle('md-props--editing', on)
        rows.hidden = on
        source.hidden = !on
        if (!on) draw()
      }
      const commit = (): void => {
        const pos = getPos()
        editing(false)
        if (pos === undefined || source.value === String(current.attrs.yaml)) return
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, yaml: source.value }))
      }
      rows.addEventListener('mousedown', (event) => {
        if (!editor.isEditable) return
        event.preventDefault()
        source.value = String(current.attrs.yaml)
        source.rows = Math.max(2, source.value.split('\n').length)
        editing(true)
        source.focus()
        const end = Number(
          (event.target as HTMLElement).closest<HTMLElement>('[data-end]')?.dataset.end ?? source.value.length
        )
        source.setSelectionRange(end, end)
      })
      source.addEventListener('blur', commit)
      source.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          source.value = String(current.attrs.yaml)
          source.blur()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) source.blur()
      })
      source.addEventListener('input', () => (source.rows = Math.max(2, source.value.split('\n').length)))
      dom.append(rows, source)
      editing(false)
      return {
        dom,
        // Clicks and keys in here are the block's own; the page would select it and take the focus.
        stopEvent: () => true,
        ignoreMutation: () => true,
        update: (updated) => {
          if (updated.type !== current.type) return false
          current = updated
          if (source.hidden) draw()
          return true
        }
      }
    }
  }
})

/** A run of raw HTML inside a line, kept verbatim. */
export const HtmlInline = Node.create({
  name: 'htmlInline',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { html: { default: '' } }
  },
  parseHTML() {
    return [{ tag: 'code[data-html-inline]', getAttrs: (element) => ({ html: element.textContent ?? '' }) }]
  },
  renderHTML({ node }) {
    return ['code', { 'data-html-inline': '', class: 'md-html-inline' }, String(node.attrs.html)]
  }
})

export type ArtifactCardOptions = {
  /** Where a click goes; the app's single browser-opening path. */
  onOpen: (url: string) => void
}

/** A one-line card for a claude.ai artifact; the file holds it as a link. */
export const ArtifactCard = Node.create<ArtifactCardOptions>({
  name: 'artifactCard',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addOptions() {
    return { onOpen: () => {} }
  },
  addAttributes() {
    return { url: { default: '' }, title: { default: '' } }
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-artifact-card]',
        getAttrs: (element) => ({
          url: element.getAttribute('data-url') ?? '',
          title: element.getAttribute('data-title') ?? ''
        })
      }
    ]
  },
  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes({
        'data-artifact-card': '',
        'data-url': String(node.attrs.url),
        'data-title': String(node.attrs.title),
        class: 'md-artifact'
      }),
      String(node.attrs.title)
    ]
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('div')
      dom.className = 'md-artifact'
      dom.setAttribute('data-artifact-card', '')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'md-artifact__open'
      button.title = String(node.attrs.url)
      button.textContent = String(node.attrs.title)
      button.addEventListener('click', (event) => {
        event.preventDefault()
        this.options.onOpen(String(node.attrs.url))
      })
      const url = document.createElement('span')
      url.className = 'md-artifact__url'
      url.textContent = String(node.attrs.url)
      dom.append(button, url)
      return { dom }
    }
  }
})

/** The kinds of GitHub alert a callout can be, in the order a click cycles them. */
export const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

const calloutLabel = (kind: string): string => `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`

/** A GitHub alert (`> [!NOTE]`): a quote with a kind, drawn as a callout whose label cycles the kind. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { kind: { default: 'note' } }
  },
  parseHTML() {
    return [
      { tag: 'div[data-callout]', getAttrs: (element) => ({ kind: element.getAttribute('data-callout') ?? 'note' }) }
    ]
  },
  renderHTML({ node }) {
    return ['div', { 'data-callout': String(node.attrs.kind), class: 'md-callout' }, 0]
  },
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'md-callout'
      const label = document.createElement('button')
      label.type = 'button'
      label.className = 'md-callout__kind'
      label.contentEditable = 'false'
      const body = document.createElement('div')
      body.className = 'md-callout__body'
      const draw = (): void => {
        const kind = String(current.attrs.kind)
        dom.dataset.callout = kind
        label.textContent = calloutLabel(kind)
      }
      draw()
      label.addEventListener('mousedown', (event) => event.preventDefault())
      label.addEventListener('click', () => {
        const pos = getPos()
        if (pos === undefined || !editor.isEditable) return
        const at = CALLOUT_KINDS.indexOf(String(current.attrs.kind) as CalloutKind)
        const kind = CALLOUT_KINDS[(at + 1) % CALLOUT_KINDS.length]
        editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, kind }))
      })
      dom.append(label, body)
      return {
        dom,
        contentDOM: body,
        stopEvent: (event) => event.target === label,
        ignoreMutation: (mutation) => mutation.target === label || label.contains(mutation.target),
        update: (updated) => {
          if (updated.type !== current.type) return false
          current = updated
          draw()
          return true
        }
      }
    }
  }
})

/** A highlighted code block, with a picker for the language in its corner. */
export const CodeBlockWithLanguage = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node
      const dom = document.createElement('div')
      dom.className = 'md-code'
      const language = document.createElement('select')
      language.className = 'md-code__language'
      language.contentEditable = 'false'
      language.disabled = !editor.isEditable
      language.setAttribute('aria-label', 'Code language')
      const fill = (): void => {
        const value = String(current.attrs.language ?? '')
        const known = CODE_LANGUAGES.some((entry) => entry.id === value)
        const options = [...CODE_LANGUAGES, ...(known || value === '' ? [] : [{ id: value, label: value }])]
        language.replaceChildren(new Option('Plain', ''), ...options.map((entry) => new Option(entry.label, entry.id)))
        language.value = value
      }
      fill()
      language.addEventListener('change', () => {
        const pos = getPos()
        if (pos === undefined) return
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...current.attrs, language: language.value || null })
        )
        editor.commands.focus()
      })
      const pre = document.createElement('pre')
      pre.spellcheck = false
      const code = document.createElement('code')
      pre.append(code)
      dom.append(language, pre)
      return {
        dom,
        contentDOM: code,
        stopEvent: (event) => event.target === language,
        ignoreMutation: (mutation) => mutation.target === language || language.contains(mutation.target),
        update: (updated) => {
          if (updated.type !== current.type) return false
          const changed = updated.attrs.language !== current.attrs.language
          current = updated
          if (changed) fill()
          return true
        }
      }
    }
  }
})

/** Turns the path the file names into a URL the window may load, or null for none. */
export type ImageResolver = (src: string) => string | null | Promise<string | null>

export type ImageByPathOptions = ImageOptions & { resolve: ImageResolver }

/** The image node, drawn from a path relative to the page; no source until `resolve` gives one. */
export const ImageByPath = Image.extend<ImageByPathOptions>({
  addOptions() {
    return { ...this.parent?.(), resolve: () => null } as ImageByPathOptions
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement('img')
      dom.className = 'md-image'
      dom.alt = String(node.attrs.alt ?? '')
      if (node.attrs.title) dom.title = String(node.attrs.title)
      void Promise.resolve()
        .then(() => this.options.resolve(String(node.attrs.src ?? '')))
        .then((url) => {
          if (url !== null) dom.src = url
        })
        .catch(() => {})
      return { dom }
    }
  }
})
