// Check public/index.html against public/demos/manifest.json: every clip slot names a listed clip with its size
// and poster, every listed clip is placed and fully encoded, and every local asset the page names exists.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public')
const page = readFileSync(join(pub, 'index.html'), 'utf8')
const { clips } = JSON.parse(readFileSync(join(pub, 'demos', 'manifest.json'), 'utf8'))
const errors = []
const byId = new Map(clips.map((c) => [c.id, c]))

for (const c of clips) {
  for (const f of [
    `${c.id}.webp`,
    ...(c.smallPoster ? [`${c.id}-${c.smallPoster}.webp`] : []),
    ...c.sizes.flatMap((s) => [`${c.id}-${s}.mp4`, `${c.id}-${s}.webm`])
  ]) {
    if (!existsSync(join(pub, 'demos', f))) errors.push(`demos/${f} is missing`)
  }
}

const slot = /<figure[^>]*data-clip="([^"]+)"[^>]*>([\s\S]*?)<\/figure>/g
const placed = new Set()
for (const [figure, id, body] of page.matchAll(slot)) {
  const c = byId.get(id)
  if (!c) {
    errors.push(`slot "${id}" is not in the manifest`)
    continue
  }
  placed.add(id)
  const sizes = /data-sizes="([^"]*)"/.exec(figure)?.[1]
  if (sizes !== c.sizes.join(','))
    errors.push(`slot "${id}" has data-sizes="${sizes}", manifest says ${c.sizes.join(',')}`)
  const video = /<video[^>]*>/.exec(body)?.[0] ?? ''
  if (!video.includes(`width="${c.width}"`) || !video.includes(`height="${c.height}"`))
    errors.push(`slot "${id}" <video> is not ${c.width}x${c.height}`)
  if (!new RegExp(`(data-)?poster="/demos/${id}\\.webp"`).test(video))
    errors.push(`slot "${id}" <video> has the wrong poster`)
}
for (const c of clips) if (!placed.has(c.id)) errors.push(`clip "${c.id}" is not placed on the page`)

// Comments are cut by index, not regex, so a stray "<!--" cannot survive into the scan.
const stripComments = (s) => {
  let out = ''
  let i = 0
  for (let a = s.indexOf('<!--'); a !== -1; a = s.indexOf('<!--', i)) {
    out += s.slice(i, a)
    const b = s.indexOf('-->', a + 4)
    if (b === -1) return out
    i = b + 3
  }
  return out + s.slice(i)
}
const html = stripComments(page)
for (const [, path] of html.matchAll(/(?:src|href|poster)="(\/[^"#?]+)"/g)) {
  if (!path.includes('*') && path !== '/' && !existsSync(join(pub, path))) errors.push(`${path} is named but missing`)
}

if (errors.length) {
  console.error(errors.join('\n'))
  process.exit(1)
}
console.log(`check-demos: ${clips.length} clips placed and encoded`)
