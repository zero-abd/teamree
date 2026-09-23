// The nodes the schema has beyond markdown's own — raw HTML kept verbatim, an
// artifact link card — and the code block and image drawn our way.

import { mergeAttributes, Node } from '@tiptap/core'
import { CodeBlockLowlight } from '@tiptap/extension-code-block-lowlight'
import { Image, type ImageOptions } from '@tiptap/extension-image'

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

/** A highlighted code block, with a field for the language in its corner. */
export const CodeBlockWithLanguage = CodeBlockLowlight.extend({
  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div')
      dom.className = 'md-code'
      const language = document.createElement('input')
      language.className = 'md-code__language'
      language.placeholder = 'language'
      language.spellcheck = false
      language.setAttribute('aria-label', 'Code language')
      language.value = String(node.attrs.language ?? '')
      language.addEventListener('change', () => {
        const pos = getPos()
        if (pos === undefined) return
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: language.value.trim() || null })
        )
      })
      language.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === 'Escape') {
          event.preventDefault()
          language.blur()
          editor.commands.focus()
        }
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
          if (updated.type !== node.type) return false
          const next = String(updated.attrs.language ?? '')
          if (document.activeElement !== language && language.value !== next) language.value = next
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
