// Reconcile the demo clips in public/index.html with public/demos/manifest.json.
//
// The page hard-codes each clip's width, height and caption, because a <video>
// without them shifts the layout while it loads and a caption fetched at runtime
// would not survive the page's own content-security-policy. Hard-coded numbers
// rot, so this is the thing that un-rots them: run it after the clips change and
// it rewrites the four <video> tags, the four captions, and the aspect ratio the
// frames reserve, from the manifest. It refuses rather than guesses.
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

// The <video> elements ship parked inside an HTML comment, so that a page built
// before the clips exist does not fire twelve 404s at every visitor. The manifest
// existing is the signal that they are real; un-park them.
const parked = /<!-- demo:video:parked\n([\s\S]*?)\ndemo:video:parked -->/g
if (parked.test(page)) {
  parked.lastIndex = 0
  page = page.replace(parked, (_, video) => video)
}

for (const clip of clips) {
  const { id, width, height } = clip
  const caption = clip.caption ?? clip.title
  if (!id) fail('a clip in the manifest has no id.')
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail(`clip "${id}" has no usable width/height in the manifest.`)
  }
  ratios.push({ id, ratio: height / width })

  const frame = new RegExp(`(<div class="demo-frame" data-demo="${id}">[\\s\\S]*?<video )width="\\d+" height="\\d+"`)
  if (!frame.test(page)) fail(`the page has no <video> inside the "${id}" frame. Ids must match the manifest.`)
  page = page.replace(frame, `$1width="${width}" height="${height}"`)

  if (caption) {
    const cap = new RegExp(
      `(<div class="demo-frame" data-demo="${id}">[\\s\\S]*?<figcaption class="demo-cap">)[\\s\\S]*?(</figcaption>)`
    )
    page = page.replace(cap, `$1${escape(caption)}$2`)
  }
}

// One aspect ratio for every frame, so the four sit on a grid rather than
// stepping. If the clips disagree, the tallest wins and nothing is cropped away.
const tallest = ratios.reduce((worst, item) => (item.ratio > worst.ratio ? item : worst), ratios[0])
const padding = (tallest.ratio * 100).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
page = page.replace(/(\.demo-frame::before\{ content:""; display:block; padding-top:)[\d.]+%/, `$1${padding}%`)

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
