import MarkdownIt from 'markdown-it'

// Raw HTML is escaped, not kept: the body is somebody else's text. Images become their alt text, so
// showing the notes fetches nothing, and only web links survive.
const md = new MarkdownIt('default', { html: false, linkify: true, typographer: false })
md.validateLink = (url) => /^https?:\/\//i.test(url.trim())
md.renderer.rules.image = (tokens, index) => md.utils.escapeHtml(tokens[index]?.content ?? '')

/** A release body from GitHub as HTML that carries no markup of its own. */
export function releaseNotesHtml(markdown: string): string {
  return md.render(markdown)
}
