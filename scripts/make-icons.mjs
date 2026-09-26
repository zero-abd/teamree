// Renders the app icon from brand/ (mark.svg, mark-small.svg, app-icon.svg) into build/icon.{png,icns,ico},
// build/icons/<n>x<n>.png, site/public PNGs and the menu bar's template images in resources/menu-bar. Headless Chrome is the rasteriser and iconutil assembles
// the icns; only `npm run icons` needs either, the outputs are committed. Rules, settled by looking:
//   1. <=32px uses mark-small.svg: the full mark's window slant flattens and its frame bars drop under a pixel.
//   2. Every size is its own render. A resampled icns is a *valid file* macOS draws blurry, silently;
//      scripts/verify-icons.mjs checks each payload's IHDR against its directory entry for that reason.
// Chrome's PNG is decoded and re-encoded by this file's own writer so the committed bytes are ours.
// The icns is not hand-written: `icp4`/`icp5` are read by macOS as raw ARGB, not PNG, so PNGs filed
// under them decode as coloured noise while every payload checker passes. iconutil writes `ic04`/`ic05`
// (RLE ARGB) for 16 and 32 instead, so that one output needs macOS.
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
const menuBarDir = join(root, 'resources', 'menu-bar')

// ------------------------------------------------------------- the palette --

// The values brand/app-icon.svg and brand/README.md carry. No inner stroke, no sheen:
// those turn to mud at 32px and below.
const TILE_INK_TOP = '#101114'
const TILE_INK_BOTTOM = '#0B0C0E'
const MARK_ON_TILE = '#F3F2EE'

// Big Sur's squircle ratio; the one radius used here and in site/public/favicon.svg.
const CORNER_RATIO = 0.225

// Big Sur's grid: the body is 80.5% of the canvas and macOS draws the shadow into the surround.
// Not applied at 16 and 32: inset body and mark there leave under 13 real pixels, a grey smudge
// in Finder, and the shadow is not drawn visibly below 48px anyway.
const APPLE_BODY_RATIO = 0.805

// At or below this: the reduced mark, a full-bleed tile even on macOS, almost no inset (rule 1).
const SMALL_MARK_MAX = 32

// Fraction of the tile the mark's 256-unit box spans. Small: the 22-unit frame bar on a 16px tile
// is 1.3px at 0.94 and under a pixel at 0.72, where it antialiases *shut* and slab and window fuse.
// Large: 0.66 is what brand/app-icon.svg uses (62% / (240/256)), so every icon places the mark alike.
const MARK_RATIO_SMALL = 0.94
const MARK_RATIO_LARGE = 0.66

// ------------------------------------------------------------- the browser --

// First that exists wins; $TEAMREE_CHROME overrides the lot.
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
const appIcon = readFileSync(join(brandDir, 'app-icon.svg'), 'utf8')

/**
 * A box of `fraction` of `outer`, rounded to the parity of `outer` so it centres on whole pixels;
 * a mark starting on a half pixel smears across two columns at every edge.
 */
function centredSide(outer, fraction) {
  const ideal = outer * fraction
  const half = Math.round((ideal - (outer % 2)) / 2)
  return half * 2 + (outer % 2)
}

/**
 * Screenshots the mark at exactly `size` device pixels. `--force-device-scale-factor=1` is what makes
 * that true: without it Chrome inherits the Mac's 2x scale and hands back 32px for a 16px window.
 * `apple` renders brand/app-icon.svg itself (honoured from 48px up; see APPLE_BODY_RATIO).
 */
function rasterise(size, { apple = false } = {}) {
  const small = size <= SMALL_MARK_MAX
  const svg = small ? markSmall : markFull
  const tile = centredSide(size, apple && !small ? APPLE_BODY_RATIO : 1)
  const radius = Math.round(tile * CORNER_RATIO)
  const mark = centredSide(tile, small ? MARK_RATIO_SMALL : MARK_RATIO_LARGE)

  const body =
    apple && !small
      ? `<div class="canvas icon">${appIcon}</div>`
      : `<div class="canvas"><div class="tile"><div class="mark">${svg}</div></div></div>`
  const html = `<!doctype html><meta charset="utf-8"><style>
*{margin:0;padding:0}
html,body{width:${size}px;height:${size}px;overflow:hidden;background:transparent}
.canvas{width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center}
.icon svg{width:100%;height:100%;display:block}
.tile{width:${tile}px;height:${tile}px;border-radius:${radius}px;background:linear-gradient(${TILE_INK_TOP},${TILE_INK_BOTTOM});display:flex;align-items:center;justify-content:center}
.mark{width:${mark}px;height:${mark}px;color:${MARK_ON_TILE};display:block}
.mark svg{width:100%;height:100%;display:block}
</style>${body}`
  return screenshot(html, size, `${size}-${tile}-${mark}`)
}

/** Chrome's screenshot of `html` in a `size` pixel square window. */
function screenshot(html, size, name) {
  const page = join(scratch, `page-${name}.html`)
  const shot = join(scratch, `shot-${name}.png`)
  writeFileSync(page, html)
  execFileSync(
    chrome,
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--use-mock-keychain',
      '--default-background-color=00000000',
      `--window-size=${size},${size}`,
      `--screenshot=${shot}`,
      `file://${page}`
    ],
    { stdio: 'ignore' }
  )
  if (!existsSync(shot)) throw new Error(`make-icons: Chrome produced no screenshot for the ${name} render.`)
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

/** Chrome's PNG back to straight RGBA. Only 8-bit, non-interlaced is handled; anything else throws. */
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
    // Undo the scanline filter: left (`a`), above (`b`), above-left (`c`); out-of-range is zero, by the spec.
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
 * The ten filenames `iconutil` requires. Pairs sharing a pixel size (16@2x/32, 128@2x/256, 256@2x/512)
 * are the same bytes under two names: the OSType is a promise about pixels.
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

/** Assembles the icns with iconutil; see the header for why not by hand. */
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

// ---------------------------------------------------------------- menu bar --

// An 18pt canvas holding the reduced mark 18pt wide (15 tall, on whole pixels at 2x). Black on clear:
// macOS tints a template image to the menu bar. Asking adds a dot with a clear ring cut around it.
const MENU_BAR_PT = 18
const MENU_BAR_DOT = { cx: 15.5, cy: 2.75, r: 2.25, ring: 1.25 }
// `Template` at the end is what macOS reads as a template image.
const MENU_BAR_IMAGES = [
  ['teamreeTemplate', false],
  ['teamreeAskingTemplate', true]
]

function menuBarSvg(asking) {
  const path = /\sd="([^"]+)"/.exec(markSmall)?.[1]
  if (!path) throw new Error('make-icons: brand/mark-small.svg has no path.')
  const { cx, cy, r, ring } = MENU_BAR_DOT
  const cut = asking
    ? `<mask id="cut"><rect width="18" height="18" fill="#fff"/><circle cx="${cx}" cy="${cy}" r="${r + ring}" fill="#000"/></mask>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MENU_BAR_PT} ${MENU_BAR_PT}" width="100%" height="100%">
<defs>${cut}</defs>
<g${
    asking ? ' mask="url(#cut)"' : ''
  }><path fill-rule="evenodd" fill="#000" transform="translate(0 1.5) scale(0.075) translate(-8 -28)" d="${path}"/></g>
${asking ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/>` : ''}
</svg>`
}

/** The template at `size` device pixels, through the same browser and writer as the icons. */
function menuBarPngAt(size, asking) {
  const html = `<!doctype html><meta charset="utf-8"><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px;overflow:hidden;background:transparent}svg{display:block}</style>${menuBarSvg(asking)}`
  const { width, height, rgba } = decodePng(screenshot(html, size, `menu-bar-${asking ? 'asking' : 'idle'}-${size}`))
  if (width !== size || height !== size)
    throw new Error(`make-icons: asked Chrome for ${size}x${size} and got ${width}x${height}.`)
  return encodePng(size, rgba)
}

/** Render at `size`, then re-encode through the writer above. */
function pngAt(size, options) {
  const { width, height, rgba } = decodePng(rasterise(size, options))
  if (width !== size || height !== size) {
    // Almost always device scale: Chrome handed back 2x. Fail rather than file 32px as 16px.
    throw new Error(`make-icons: asked Chrome for ${size}x${size} and got ${width}x${height}.`)
  }
  return encodePng(size, rgba)
}

// macOS: inset Apple body from 48px up, full-bleed tile at 16 and 32. build/icon.png is the 1024 member.
const APPLE_SIZES = [...new Set(ICONSET_FILES.map(([, size]) => size))].sort((a, b) => a - b)

// Full bleed: an ICO with Apple's inset body reads as a small icon with a dead margin in the taskbar.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]

// The site's PNGs; only icon-32.png is genuinely small and takes the reduced mark.
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
  mkdirSync(menuBarDir, { recursive: true })
  for (const [name, asking] of MENU_BAR_IMAGES) {
    writeFileSync(join(menuBarDir, `${name}.png`), menuBarPngAt(MENU_BAR_PT, asking))
    writeFileSync(join(menuBarDir, `${name}@2x.png`), menuBarPngAt(MENU_BAR_PT * 2, asking))
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

// site/public/favicon.svg is hand-authored and under a kilobyte on purpose; not written here.
console.log(
  `make-icons: ${chrome.split('/').pop()} rendered build/icon.png, ${ICONSET_FILES.length} images in build/icon.icns, ` +
    `${ICO_SIZES.length} sizes in build/icon.ico, ${LINUX_SIZES.length} files in build/icons, ` +
    `${SITE_PNGS.length} site PNGs and ${MENU_BAR_IMAGES.length * 2} menu bar templates — each its own render at its own size.`
)
