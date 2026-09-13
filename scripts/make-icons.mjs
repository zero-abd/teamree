// Renders the application icon from the brand vectors and writes every size and
// container the three packaging targets and the landing page ask for:
// build/icon.png (Linux, and the master), build/icon.icns (macOS),
// build/icon.ico (Windows), build/icons/<n>x<n>.png for desktop entries, and
// the site's own PNGs under site/public.
//
// This script used to draw the mark itself, out of signed distance fields, so
// that it needed nothing but Node. That bought reproducibility at the price of
// the artwork: the icon could only ever be whatever could be expressed as a few
// circles and quadratics in this file, and it drifted from the mark used
// everywhere else. The artwork now lives in brand/mark.svg and
// brand/mark-small.svg, which are the source of truth for the whole brand, and
// this script's job is to get those vectors onto a pixel grid at exactly the
// sizes the containers promise.
//
// There is no rasteriser in the dependency tree — no ImageMagick, no sharp, no
// resvg — so headless Chrome is the rasteriser. Chrome is *required to
// regenerate the icons* and nothing else: the generated files are committed, so
// a normal build, test or package run never touches this script. Only
// `npm run icons` needs a browser, and it says so plainly if one is missing.
//
// Two rules are load-bearing and were settled by rendering and looking, not by
// argument:
//
//   1. Sizes of 32px and below use brand/mark-small.svg, the reduced form with
//      the window contents dropped and the strokes thickened. Sizes of 48px and
//      up use the full brand/mark.svg. Below 32px the three chrome dots and the
//      `>_` prompt antialias into flat grey and the three windows close into one
//      blob, which is exactly what the reduced form exists to prevent.
//   2. Every size is its own render at that pixel size. Nothing here is one
//      large render scaled down. A 1024 render resampled to 16 is soft in a way
//      that no amount of sharpening recovers, and — worse — an icns assembled
//      that way is a *valid file* that macOS accepts and then draws blurry, with
//      nothing in any build log to say so. scripts/verify-icons.mjs opens every
//      payload and checks its real IHDR against the size its directory entry
//      promised, and `npm run icons` runs it at the end for that reason.
//
// The PNG writer and the ICO directory writer below are unchanged and still
// depend on nothing. Chrome hands back a PNG; we decode it to raw pixels and
// re-encode it through our own writer, so the bytes that land in the repo are
// produced by code in this file at a deflate level we choose, rather than by
// whatever Chrome's PNG encoder happens to do this month.
//
// The ICNS is the exception, and it is the exception for a reason worth
// recording. This script used to hand-write the icns too, filing the 16px and
// 32px images under the OSTypes `icp4` and `icp5`. Those two codes are
// ambiguous: they are documented as 16x16 and 32x32, but macOS reads them as
// raw ARGB rather than as PNG, so a PNG filed under them is decoded as pixel
// data and comes out as coloured noise. Extracting the old file with
// `iconutil -c iconset` produced a green smear for icon_16x16.png and a red one
// for icon_32x32.png while every other entry was clean — and nothing else
// noticed, because the chunks themselves were perfectly good PNGs. The bug was
// the *type*, not the payload, which is precisely the kind of thing a checker
// that reads payloads cannot see.
//
// Apple's own `iconutil` does not emit `icp4` or `icp5` at all. Given the ten
// standard filenames it writes `ic04` and `ic05` — RLE-compressed ARGB, not PNG
// — for 16 and 32, `ic11 ic12 ic07 ic13 ic08 ic14 ic09 ic10` as PNG for the
// rest, and an `info` chunk. Rather than implement Apple's RLE, the icns is now
// assembled by `iconutil`, which means *this one output needs macOS*. That is
// the same bargain the Chrome dependency already is: the generated files are
// committed, so only `npm run icons` is affected.
import { deflateSync, inflateSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const brandDir = join(root, 'brand')
const buildDir = join(root, 'build')
const iconsDir = join(buildDir, 'icons')
const siteDir = join(root, 'site', 'public')

// ------------------------------------------------------------- the palette --

// Final, and used exactly. The mark is one colour; the tile is one colour. No
// gradient, no inner stroke, no sheen: the old icon had all three and they are
// the first things to turn to mud at 32px and below.
const TILE_INK = '#0A0C10'
const MARK_ON_TILE = '#FFFFFF'

// The macOS app-icon squircle ratio. A rounded rect at 22.5% of its own side is
// what Big Sur's grid specifies, and the site header independently landed on the
// same number, so it is the one radius used everywhere here and in
// site/public/favicon.svg.
const CORNER_RATIO = 0.225

// Apple's Big Sur icon grid: the rounded-square body is 80.5% of the canvas,
// centred, and everything outside it is transparent. The surround is not wasted
// space — macOS draws the icon's shadow into it, and an icon that fills its own
// canvas sits visibly larger than its neighbours in the Dock. On the 1024 master
// this is an 824px body with a 185px radius.
//
// It is not applied to the icns's 16 and 32 chunks. Inset the body *and* the
// mark at 16px and there are under 13 real pixels of artwork left inside a 16px
// square, which macOS then draws in a Finder list view as a grey smudge. Below
// 48px the shadow the surround exists for is not drawn at a visible size
// anyway, so those two sizes get the same full-bleed tile as the web and Windows
// icons and spend every pixel on the mark.
const APPLE_BODY_RATIO = 0.805

// The size at or below which the icon is treated as small: the reduced mark, a
// full-bleed tile even on macOS, and almost no inset. See below, and rule 1.
const SMALL_MARK_MAX = 32

// How much of the tile the mark spans, as a fraction of the tile's side. There
// are two numbers because there have to be, and the reason is one measurement.
//
// The reduced mark's tightest feature is the 4-unit gap between the bottom of
// the top window (y=19.5) and the top of the lower two (y=23.5). On a 16px tile
// that gap is `4 * ratio * 16/64` device pixels — at 0.72 it is 0.72px, and a
// feature under one pixel wide does not antialias grey, it antialiases *shut*.
// Rendered at 0.72 / 0.86 / 0.94 / 1.00 on 16, 20 and 32px tiles and looked at:
// at 0.72 the three windows and the trunk fuse into one grey plus sign at 16 and
// are marginal at 20. At 0.94 the gap is ~1px and the windows separate cleanly.
//
// So small sizes are drawn essentially full bleed. They can afford to be: the
// mark carries its own margin, spanning 60 of its 64 viewBox units, so even at
// ratio 1 there is a 3% surround. 0.94 rather than a flat 1 keeps a pixel of
// tile visible at the sizes where the grid allows one, so the outer windows and
// the root do not sit flush against the corner radius.
//
// Large sizes get a real inset, because there the constraint is not legibility
// but proportion — at 0.94 a 256px icon looks like a decal that overran its
// plate. 0.86 was picked over 0.72 / 0.80 / 0.92 by rendering all four at 48 and
// 256: 0.72 leaves the mark swimming, 0.92 pushes the outer windows into the
// corner arc, and 0.86 also keeps the step across the 32/48 boundary small
// enough that the family still reads as one family.
const MARK_RATIO_SMALL = 0.94
const MARK_RATIO_LARGE = 0.86

// ------------------------------------------------------------- the browser --

// Checked in order; the first that exists wins. $TEAMREE_CHROME overrides the
// lot, which is how a CI runner with Chrome somewhere unusual gets to run this.
const CHROME_CANDIDATES = [
  process.env.TEAMREE_CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean)

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(
    'make-icons needs headless Chrome to rasterise brand/mark.svg, and none was found.\n' +
      'Looked in:\n' +
      CHROME_CANDIDATES.map((candidate) => `  ${candidate}`).join('\n') +
      '\nInstall Google Chrome or Chromium, or set $TEAMREE_CHROME to the binary.\n' +
      'Only `npm run icons` needs this — the generated icons are committed, so building,\n' +
      'testing and packaging the app do not.'
  )
}

const chrome = findChrome()
const scratch = mkdtempSync(join(tmpdir(), 'teamree-icons-'))

const markFull = readFileSync(join(brandDir, 'mark.svg'), 'utf8')
const markSmall = readFileSync(join(brandDir, 'mark-small.svg'), 'utf8')

/**
 * A box of `fraction` of `outer`, rounded so that it still lands on whole
 * pixels when it is centred. `(outer - side)` has to be even or the box starts
 * on a half pixel, and a mark that starts on a half pixel is smeared across two
 * columns at every edge — at 16px that is the difference between three windows
 * and one grey lump. So the side is rounded to the nearest integer of the same
 * parity as `outer` rather than to the nearest integer.
 */
function centredSide(outer, fraction) {
  const ideal = outer * fraction
  const half = Math.round((ideal - (outer % 2)) / 2)
  return half * 2 + (outer % 2)
}

/**
 * Screenshots the mark at exactly `size` by `size` device pixels and returns
 * Chrome's PNG.
 *
 * `--force-device-scale-factor=1` is what makes the "exactly" true: without it
 * Chrome inherits the Mac's 2x display scale and silently hands back a 32px
 * image for a 16px window, which is the one failure this whole file is arranged
 * to avoid. `--default-background-color=00000000` keeps the area outside the
 * tile genuinely transparent instead of white.
 *
 * `apple` asks for Apple's inset body rather than the full-bleed tile that
 * Windows, Linux and the web expect. It is honoured only at 48px and up; see
 * APPLE_BODY_RATIO for why.
 *
 * This is the one place the small/large split is decided, so all three things
 * that change with it — which vector, how big a tile, how much inset — are
 * visible together.
 */
function rasterise(size, { apple = false } = {}) {
  const small = size <= SMALL_MARK_MAX
  const svg = small ? markSmall : markFull
  const tile = centredSide(size, apple && !small ? APPLE_BODY_RATIO : 1)
  const radius = Math.round(tile * CORNER_RATIO)
  const mark = centredSide(tile, small ? MARK_RATIO_SMALL : MARK_RATIO_LARGE)

  const html = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0}
html,body{width:${size}px;height:${size}px;overflow:hidden;background:transparent}
.canvas{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center}
.tile{width:${tile}px;height:${tile}px;border-radius:${radius}px;background:${TILE_INK};display:flex;align-items:center;justify-content:center}
.mark{width:${mark}px;height:${mark}px;color:${MARK_ON_TILE};display:block}
.mark svg{width:100%;height:100%;display:block}
</style><div class="canvas"><div class="tile"><div class="mark">${svg}</div></div></div>`

  const page = join(scratch, `page-${size}-${tile}-${mark}.html`)
  const shot = join(scratch, `shot-${size}-${tile}-${mark}.png`)
  writeFileSync(page, html)
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${shot}`,
      `file://${page}`
    ],
    { stdio: 'ignore' }
  )
  if (!existsSync(shot)) throw new Error(`make-icons: Chrome produced no screenshot for the ${size}px render.`)
  return readFileSync(shot)
}

// --------------------------------------------------------------- png in/out --

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/**
 * Chrome's PNG back to straight RGBA, so the pixels can go through this file's
 * own PNG writer rather than being passed along as an opaque blob. Only what
 * Chrome actually emits is supported — 8 bits a channel, not interlaced — and
 * anything else throws rather than being guessed at.
 */
function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('make-icons: Chrome did not return a PNG.')

  let width = 0
  let height = 0
  let bitDepth = 0
  let colourType = 0
  const parts = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const bodyAt = offset + 8
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(bodyAt)
      height = bytes.readUInt32BE(bodyAt + 4)
      bitDepth = bytes[bodyAt + 8]
      colourType = bytes[bodyAt + 9]
      if (bytes[bodyAt + 12] !== 0) throw new Error('make-icons: interlaced PNG from Chrome, which is not handled.')
    } else if (type === 'IDAT') {
      parts.push(bytes.subarray(bodyAt, bodyAt + length))
    } else if (type === 'IEND') {
      break
    }
    offset = bodyAt + length + 4
  }

  const channelsFor = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = channelsFor[colourType]
  if (bitDepth !== 8 || !channels) {
    throw new Error(`make-icons: unsupported PNG from Chrome (bit depth ${bitDepth}, colour type ${colourType}).`)
  }

  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * channels
  const rgba = Buffer.alloc(width * height * 4)
  let previous = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1)
    const filter = raw[at]
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride))
    // Undo the per-scanline filter in place. Every byte refers to the byte one
    // pixel to its left (`a`), the same byte on the row above (`b`) and the byte
    // above-left (`c`); out-of-range neighbours are zero, by the spec.
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[i] = (line[i] + paeth(a, b, c)) & 0xff
      else if (filter !== 0) throw new Error(`make-icons: unknown PNG filter ${filter} on row ${y}.`)
    }
    for (let x = 0; x < width; x += 1) {
      const from = x * channels
      const to = (y * width + x) * 4
      if (colourType === 6) {
        rgba[to] = line[from]
        rgba[to + 1] = line[from + 1]
        rgba[to + 2] = line[from + 2]
        rgba[to + 3] = line[from + 3]
      } else if (colourType === 2) {
        rgba[to] = line[from]
        rgba[to + 1] = line[from + 1]
        rgba[to + 2] = line[from + 2]
        rgba[to + 3] = 0xff
      } else {
        rgba[to] = line[from]
        rgba[to + 1] = line[from]
        rgba[to + 2] = line[from]
        rgba[to + 3] = colourType === 4 ? line[from + 1] : 0xff
      }
    }
    previous = line
  }

  return { width, height, rgba }
}

// -------------------------------------------------------------- containers --

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, body) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}

function encodePng(size, rgba) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bit depth
  header[9] = 6 // truecolour with alpha
  // Filter 0 on every row: the images are small and this keeps the writer honest.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** ICO with PNG payloads, which Windows has accepted since Vista. */
function encodeIco(entries) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)

  const directory = Buffer.alloc(16 * entries.length)
  let offset = header.length + directory.length
  for (const [index, entry] of entries.entries()) {
    const at = index * 16
    directory[at] = entry.size >= 256 ? 0 : entry.size
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size
    directory[at + 2] = 0 // palette
    directory[at + 3] = 0 // reserved
    directory.writeUInt16LE(1, at + 4) // colour planes
    directory.writeUInt16LE(32, at + 6) // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += entry.png.length
  }

  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

/**
 * The ten images a modern macOS app icon carries, under the filenames
 * `iconutil` requires. The list is the contract: two names are two *renders*
 * only where the pixel sizes differ, and four of the ten share a size with
 * another — icon_16x16@2x and icon_32x32 are both 32px, icon_128x128@2x and
 * icon_256x256 are both 256px, icon_256x256@2x and icon_512x512 are both 512px.
 * Those pairs are the same bytes under two names, which is correct: the OSType
 * is a promise about pixels, and both members of a pair promise the same
 * pixels.
 */
const ICONSET_FILES = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024]
]

/** Assembles the icns with Apple's own tool. See the note at the top of the file. */
function writeIcns(pngBySize, outPath) {
  const iconset = join(scratch, 'icon.iconset')
  mkdirSync(iconset, { recursive: true })
  for (const [name, size] of ICONSET_FILES) writeFileSync(join(iconset, name), pngBySize.get(size))
  try {
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', outPath], { stdio: 'pipe' })
  } catch (error) {
    throw new Error(
      'make-icons could not run /usr/bin/iconutil, which assembles build/icon.icns.\n' +
        'That tool ships with macOS and there is no portable substitute here: the 16 and 32\n' +
        'pixel entries of an icns are RLE-compressed ARGB, not PNG, and filing PNGs under the\n' +
        '`icp4`/`icp5` codes instead is what produced a corrupt icon before this.\n' +
        'Regenerate the icons on a Mac; build/icon.icns is committed, so nothing else needs it.\n' +
        `iconutil said: ${error.stderr?.toString().trim() || error.message}`
    )
  }
}

// ------------------------------------------------------------------- write --

/** Render at `size`, then re-encode through the writer above. */
function pngAt(size, options) {
  const { width, height, rgba } = decodePng(rasterise(size, options))
  if (width !== size || height !== size) {
    // Almost always a device-scale-factor problem: Chrome handed back a 2x
    // image. Fail here rather than let a 32px payload be filed as 16px.
    throw new Error(`make-icons: asked Chrome for ${size}x${size} and got ${width}x${height}.`)
  }
  return encodePng(size, rgba)
}

// macOS: the inset Apple body from 48px up, transparent surround, shadow drawn
// by the OS; a full-bleed tile at 16 and 32, where the body inset costs more
// than the shadow is worth. build/icon.png is the 1024 member of this set and
// not a separate render.
const APPLE_SIZES = [...new Set(ICONSET_FILES.map(([, size]) => size))].sort((a, b) => a - b)

// Windows, Linux and the web: the tile is the whole canvas. Windows in
// particular expects full bleed — an ICO with Apple's inset body reads as a
// small icon with a wide dead margin in the taskbar and in Explorer.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]

// The site's PNGs. apple-touch-icon and the two large maskable-ish sizes carry
// the full mark: nothing here is displayed below 180px, so the reduced form
// would be throwing away detail that the viewer can see. icon-32.png is the one
// that is genuinely small, so it takes the reduced mark like every other 32.
const SITE_PNGS = [
  ['icon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-256.png', 256],
  ['icon-512.png', 512]
]

mkdirSync(iconsDir, { recursive: true })
mkdirSync(siteDir, { recursive: true })

try {
  const applePngs = new Map()
  for (const size of APPLE_SIZES) applePngs.set(size, pngAt(size, { apple: true }))

  const fullBleedPngs = new Map()
  for (const size of new Set([...ICO_SIZES, ...LINUX_SIZES, ...SITE_PNGS.map(([, size]) => size)])) {
    fullBleedPngs.set(size, pngAt(size))
  }

  writeFileSync(join(buildDir, 'icon.png'), applePngs.get(1024))
  writeIcns(applePngs, join(buildDir, 'icon.icns'))
  writeFileSync(
    join(buildDir, 'icon.ico'),
    encodeIco(ICO_SIZES.map((size) => ({ size, png: fullBleedPngs.get(size) })))
  )
  for (const size of LINUX_SIZES) writeFileSync(join(iconsDir, `${size}x${size}.png`), fullBleedPngs.get(size))
  for (const [name, size] of SITE_PNGS) writeFileSync(join(siteDir, name), fullBleedPngs.get(size))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// site/public/favicon.svg is deliberately not written here. It is the same tile
// and the same reduced mark, but hand-authored and under a kilobyte, because it
// is served to every visitor and a browser draws it at 16-20px in a tab where a
// generated file full of redundant precision buys nothing.
console.log(
  `make-icons: ${chrome.split('/').pop()} rendered build/icon.png, ${ICONSET_FILES.length} images in build/icon.icns, ` +
    `${ICO_SIZES.length} sizes in build/icon.ico, ${LINUX_SIZES.length} files in build/icons ` +
    `and ${SITE_PNGS.length} site PNGs — each its own render at its own size.`
)
