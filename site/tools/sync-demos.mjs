// Reconcile the demo clips in public/index.html with public/demos/manifest.json.
//
// The page hard-codes each clip's width, height and caption, because a <video>
// without them shifts the layout while it loads and a caption fetched at runtime
// would not survive the page's own content-security-policy. Hard-coded numbers
// rot, so this is the thing that un-rots them: run it after the clips change and
// it rewrites every listed clip's <video> tag and caption, and the aspect ratio
// the feature frames reserve, from the manifest. It refuses rather than guesses.
//
// A clip is found by the data-demo id on its frame — a feature's .demo-frame or
// the hero's .shot-frame — and everything the tool touches for it lies between
// that frame and the end of its <figure>. A frame parked inside an HTML comment
// is un-parked only when its id is in the manifest; the rest stay parked, so a
// clip that has not been shot fires no 404s. The other way round — a clip in the
// manifest with no frame on the page — is reported and otherwise left alone.
//
//   node site/tools/sync-demos.mjs           # rewrite
//   node site/tools/sync-demos.mjs --check   # exit 1 if the page is out of date
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const pagePath = join(siteDir, 'public', 'index.html')
const manifestPath = join(siteDir, 'public', 'demos', 'manifest.json')
const check = process.argv.includes('--check')

function fail(message) {
  console.error(`sync-demos: ${message}`)
  process.exit(1)
}

let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  fail(`could not read ${manifestPath}: ${error.message}`)
}

const clips = Array.isArray(manifest) ? manifest : manifest.clips
if (!Array.isArray(clips) || clips.length === 0) fail('the manifest lists no clips.')

const escape = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

let page = readFileSync(pagePath, 'utf8')
const before = page
const ratios = []
const unplaced = []

const parked = /<!-- demo:video:parked\n([\s\S]*?)\ndemo:video:parked -->/
for (const clip of clips) {
  const { id, width, height } = clip
  const caption = clip.caption ?? clip.title
  if (!id) fail('a clip in the manifest has no id.')
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail(`clip "${id}" has no usable width/height in the manifest.`)
  }

  const open = page.search(new RegExp(`<div class="(?:demo|shot)-frame" data-demo="${id}">`))
  if (open < 0) {
    // Shot but not placed: the page has no frame for it yet. Nothing to rewrite.
    unplaced.push(id)
    continue
  }
  const close = page.indexOf('</figure>', open)
  if (close < 0) fail(`the "${id}" frame is not inside a <figure>.`)
  let figure = page.slice(open, close)

  if (parked.test(figure)) figure = figure.replace(parked, (_, video) => video)
  if (!/<video /.test(figure)) fail(`the page has no <video> inside the "${id}" frame.`)
  figure = figure.replace(/(<video )width="\d+" height="\d+"/, `$1width="${width}" height="${height}"`)
  if (caption && /<figcaption class="demo-cap">/.test(figure)) {
    figure = figure.replace(/(<figcaption class="demo-cap">)[\s\S]*?(<\/figcaption>)/, `$1${escape(caption)}$2`)
  }
  if (/class="demo-frame"/.test(figure.slice(0, 40))) ratios.push({ id, ratio: height / width })

  page = page.slice(0, open) + figure + page.slice(close)
}

// One aspect ratio for every feature frame, so they sit on a grid rather than
// stepping. If the clips disagree, the tallest wins and nothing is cropped away.
// The hero's frame keeps its own ratio in the stylesheet.
if (ratios.length === 0) fail('no listed clip sits in a feature frame.')
const tallest = ratios.reduce((worst, item) => (item.ratio > worst.ratio ? item : worst), ratios[0])
const padding = (tallest.ratio * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
page = page.replace(/(\.demo-frame::before\{ content:""; display:block; padding-top:)[\d.]+%/, `$1${padding}%`)

if (unplaced.length) console.log(`sync-demos: no frame on the page for ${unplaced.join(', ')}; left as listed.`)
if (page === before) {
  console.log('sync-demos: already in step with the manifest.')
  process.exit(0)
}
if (check) {
  console.error('sync-demos: public/index.html is out of date. Run `node site/tools/sync-demos.mjs`.')
  process.exit(1)
}
writeFileSync(pagePath, page)
console.log(
  `sync-demos: updated ${clips.length} clip${clips.length === 1 ? '' : 's'} ` +
    `(${clips.map((c) => c.id).join(', ')}); frames reserve ${padding}% (from "${tallest.id}").`
)
