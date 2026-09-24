// Checks the generated icons are what packaging and the site need: each payload's real IHDR size
// against what its container claims, `icp4`/`icp5` as a hard failure (macOS reads them as raw ARGB
// and draws noise), and saturation of the decoded pixels. The .icns extraction needs macOS.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const failures = []
const notes = []

function fail(file, message) {
  failures.push(`${file}: ${message}`)
}

/**
 * PNG-backed OSTypes `iconutil` emits and their pixel sizes. Stated again rather than imported from
 * make-icons.mjs, so the check cannot agree with a wrong table by construction.
 */
const ICNS_PNG_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
]

/** 16 and 32: RLE ARGB with no IHDR, so only presence is checked here; extraction checks the art. */
const ICNS_ARGB_TYPES = [
  ['ic04', 16],
  ['ic05', 32]
]

/** Never acceptable: a PNG under `icp4`/`icp5` is read as raw ARGB and drawn as noise. It shipped once. */
const ICNS_FORBIDDEN_TYPES = ['icp4', 'icp5']

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]

// Sizes declared by site/public/index.html, plus the rest of the set `npm run icons` writes.
const SITE_PNGS = [
  { path: 'site/public/icon-32.png', width: 32, height: 32, required: true },
  { path: 'site/public/icon-256.png', width: 256, height: 256, required: true },
  { path: 'site/public/og.png', width: 1200, height: 630, required: true },
  // The one 2x asset: the page reserves a 1440x900 slot for it.
  { path: 'site/public/screenshot.png', width: 2880, height: 1800, required: true },
  { path: 'site/public/apple-touch-icon.png', width: 180, height: 180, required: true },
  { path: 'site/public/icon-192.png', width: 192, height: 192, required: true },
  { path: 'site/public/icon-512.png', width: 512, height: 512, required: true }
]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Real dimensions of a PNG, from its IHDR, which the format fixes at byte 8. */
function pngSize(bytes) {
  if (bytes.length < 24) return null
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function describe(size) {
  return size ? `${size.width}x${size.height}` : 'not a PNG'
}

// ------------------------------------------------------------- the pixels --

/**
 * The mark is three greys, so a correct icon has no saturated pixels; a payload read as the wrong
 * format comes out as coloured noise (the corrupt 16x16 was 85%). The limit is generous on purpose.
 */
const CHANNEL_SPREAD = 40
const SATURATION_LIMIT = 0.02

/** Enough of a PNG decoder to get at the pixels. 8-bit, non-interlaced, which is all this repo writes. */
function decodePng(bytes) {
  const header = pngSize(bytes)
  if (!header) return null
  const bitDepth = bytes[24]
  const colourType = bytes[25]
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colourType]
  // Palette images would need PLTE resolved; nothing here writes one.
  if (bitDepth !== 8 || !channels || colourType === 3 || bytes[28] !== 0) return null

  const parts = []
  let offset = 8
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') parts.push(bytes.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += length + 12
  }

  let raw
  try {
    raw = inflateSync(Buffer.concat(parts))
  } catch {
    return null
  }

  const { width, height } = header
  const stride = width * channels
  if (raw.length < height * (stride + 1)) return null
  const out = Buffer.alloc(width * height * channels)
  let previous = Buffer.alloc(stride)
  for (let y = 0; y < height; y += 1) {
    const at = y * (stride + 1)
    const filter = raw[at]
    const line = Buffer.from(raw.subarray(at + 1, at + 1 + stride))
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = previous[i]
      const c = i >= channels ? previous[i - channels] : 0
      if (filter === 1) line[i] = (line[i] + a) & 0xff
      else if (filter === 2) line[i] = (line[i] + b) & 0xff
      else if (filter === 3) line[i] = (line[i] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff
      } else if (filter !== 0) return null
    }
    line.copy(out, y * stride)
    previous = line
  }
  return { width, height, channels, pixels: out }
}

/** The fraction of pixels whose channels disagree by more than a rounding error. */
function saturatedFraction(image) {
  if (image.channels < 3) return 0
  let saturated = 0
  const count = image.width * image.height
  for (let i = 0; i < count; i += 1) {
    const at = i * image.channels
    const r = image.pixels[at]
    const g = image.pixels[at + 1]
    const b = image.pixels[at + 2]
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHANNEL_SPREAD) saturated += 1
  }
  return saturated / count
}

/** Records a failure if `bytes` decode to an image that is mostly colour noise. */
function checkNotNoise(label, bytes) {
  const image = decodePng(bytes)
  if (!image) {
    notes.push(`${label} could not be decoded for the saturation check (unsupported PNG variant)`)
    return
  }
  const fraction = saturatedFraction(image)
  if (fraction > SATURATION_LIMIT) {
    fail(
      label,
      `is ${(fraction * 100).toFixed(0)}% saturated colour. The mark is an off-white on two near-blacks, so this is ` +
        'a corrupt payload — most likely the right pixels filed under an OSType macOS reads as raw ARGB.'
    )
  }
}

/** Reads a file, or records why it could not be read and returns null. */
function read(relativePath) {
  const absolute = join(root, relativePath)
  if (!existsSync(absolute)) {
    fail(relativePath, 'does not exist. Run `npm run icons`.')
    return null
  }
  if (!statSync(absolute).isFile()) {
    fail(relativePath, 'is not a file.')
    return null
  }
  return readFileSync(absolute)
}

/** A standalone PNG that must be exactly `width` by `height`. */
function checkPng(relativePath, width, height) {
  const bytes = read(relativePath)
  if (!bytes) return
  const size = pngSize(bytes)
  if (!size) {
    fail(relativePath, 'is not a PNG (no signature or no IHDR).')
    return
  }
  if (size.width !== width || size.height !== height) {
    fail(relativePath, `is ${describe(size)}, expected ${width}x${height}.`)
  }
  if (!relativePath.endsWith('og.png') && !relativePath.endsWith('screenshot.png')) checkNotNoise(relativePath, bytes)
}

// ---------------------------------------------------------------- the icns --

function checkIcns(relativePath) {
  const bytes = read(relativePath)
  if (!bytes) return

  if (bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns') {
    fail(relativePath, 'does not start with the `icns` magic.')
    return
  }
  const declared = bytes.readUInt32BE(4)
  if (declared !== bytes.length) {
    fail(relativePath, `declares a length of ${declared} bytes but is ${bytes.length} bytes.`)
    return
  }

  const found = new Map()
  let offset = 8
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) {
      fail(relativePath, `has a truncated chunk header at byte ${offset}.`)
      return
    }
    const type = bytes.toString('ascii', offset, offset + 4)
    const length = bytes.readUInt32BE(offset + 4)
    if (length < 8 || offset + length > bytes.length) {
      fail(relativePath, `chunk \`${type}\` at byte ${offset} declares ${length} bytes, which runs past the end.`)
      return
    }
    found.set(type, bytes.subarray(offset + 8, offset + length))
    offset += length
  }

  // A PNG under either is drawn as noise and passes every size check.
  for (const type of ICNS_FORBIDDEN_TYPES) {
    if (found.has(type)) {
      fail(
        relativePath,
        `carries the \`${type}\` chunk. macOS may read it as raw ARGB rather than PNG and draw noise, and ` +
          'once did. `iconutil` writes ic04/ic05 for 16 and 32 instead — build the icns with it.'
      )
    }
  }

  for (const [type, expected] of ICNS_PNG_TYPES) {
    const payload = found.get(type)
    if (!payload) {
      fail(relativePath, `is missing the \`${type}\` chunk, which macOS wants at ${expected}x${expected}.`)
      continue
    }
    const size = pngSize(payload)
    if (!size) {
      fail(relativePath, `chunk \`${type}\` does not contain a PNG.`)
      continue
    }
    // The point of the script: an icns filed from one render under every code passes everything else.
    if (size.width !== expected || size.height !== expected) {
      fail(
        relativePath,
        `chunk \`${type}\` promises ${expected}x${expected} but contains a ${describe(size)} image. ` +
          'The icns was built at the wrong size, or from one render scaled.'
      )
    }
    checkNotNoise(`${relativePath} chunk \`${type}\``, payload)
  }

  // RLE ARGB, no header: presence and a plausible length only.
  for (const [type, expected] of ICNS_ARGB_TYPES) {
    const payload = found.get(type)
    if (!payload) {
      fail(relativePath, `is missing the \`${type}\` chunk, which macOS wants at ${expected}x${expected}.`)
    } else if (payload.length < 64) {
      fail(relativePath, `chunk \`${type}\` is only ${payload.length} bytes, which cannot be a ${expected}px icon.`)
    } else if (pngSize(payload)) {
      // A PNG here is the icp4/icp5 mistake under another name.
      fail(relativePath, `chunk \`${type}\` contains a PNG. ic04 and ic05 are RLE ARGB — let iconutil write them.`)
    }
  }

  const known = new Set([...ICNS_PNG_TYPES, ...ICNS_ARGB_TYPES].map(([type]) => type))
  const extra = [...found.keys()].filter((type) => !known.has(type) && !ICNS_FORBIDDEN_TYPES.includes(type))
  if (extra.length > 0) notes.push(`${relativePath} also carries ${extra.join(', ')}, which nothing here checks`)

  extractAndCheckIcns(relativePath)
}

/** Expands the file with `iconutil`, macOS's own decoder, so misfiled payloads land as noise. Mac only. */
function extractAndCheckIcns(relativePath) {
  if (process.platform !== 'darwin') {
    notes.push(`${relativePath} was not expanded with iconutil (not macOS), so its entries were checked as chunks only`)
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'verify-icons-'))
  try {
    execFileSync('iconutil', ['-c', 'iconset', join(root, relativePath), '-o', join(dir, 'out.iconset')], {
      stdio: 'pipe'
    })
    const out = join(dir, 'out.iconset')
    const entries = readdirSync(out).sort()
    if (entries.length === 0) {
      fail(relativePath, 'expanded to an empty iconset.')
      return
    }
    for (const entry of entries) checkNotNoise(`${relativePath} → ${entry}`, readFileSync(join(out, entry)))
    notes.push(`${relativePath} expanded to ${entries.length} entries with iconutil, all of them greyscale`)
  } catch (error) {
    fail(relativePath, `could not be expanded with iconutil: ${error.stderr?.toString().trim() || error.message}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ----------------------------------------------------------------- the ico --

function checkIco(relativePath) {
  const bytes = read(relativePath)
  if (!bytes) return

  if (bytes.length < 6 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) {
    fail(relativePath, 'is not an icon-type ICO (bad reserved field or image type).')
    return
  }
  const count = bytes.readUInt16LE(4)
  if (count !== ICO_SIZES.length) {
    fail(relativePath, `declares ${count} images, expected ${ICO_SIZES.length}: ${ICO_SIZES.join(', ')}.`)
    return
  }
  if (6 + count * 16 > bytes.length) {
    fail(relativePath, 'has a directory that runs past the end of the file.')
    return
  }

  for (const [index, expected] of ICO_SIZES.entries()) {
    const at = 6 + index * 16
    // Zero means 256: the field is one byte.
    const width = bytes[at] === 0 ? 256 : bytes[at]
    const height = bytes[at + 1] === 0 ? 256 : bytes[at + 1]
    const length = bytes.readUInt32LE(at + 8)
    const offset = bytes.readUInt32LE(at + 12)

    if (width !== expected || height !== expected) {
      fail(relativePath, `directory entry ${index} is ${width}x${height}, expected ${expected}x${expected}.`)
      continue
    }
    if (offset + length > bytes.length) {
      fail(relativePath, `the ${expected}x${expected} entry points past the end of the file.`)
      continue
    }

    const payload = bytes.subarray(offset, offset + length)
    const size = pngSize(payload)
    if (!size) {
      fail(relativePath, `the ${expected}x${expected} entry is not a PNG payload. NSIS needs PNG-backed entries here.`)
      continue
    }
    if (size.width !== expected || size.height !== expected) {
      fail(relativePath, `the ${expected}x${expected} entry contains a ${describe(size)} image.`)
    }
    checkNotNoise(`${relativePath} entry ${expected}x${expected}`, payload)
  }
}

// ----------------------------------------------------- the inlined copies --

/**
 * The site, OG card and lockup inline the brand vectors, and have drifted twice (once shipping with no
 * mark). Extract the geometry from both sides and insist on the same string under the same viewBox.
 */
const INLINED = [
  { source: 'brand/mark.svg', host: 'site/public/index.html', open: '<symbol id="mark"', close: '</symbol>' },
  { source: 'brand/mark-small.svg', host: 'site/public/index.html', open: '<symbol id="mark-sm"', close: '</symbol>' },
  { source: 'brand/wordmark.svg', host: 'site/public/index.html', open: '<symbol id="wordmark"', close: '</symbol>' },
  { source: 'brand/mark.svg', host: 'site/og/card.html', open: '<symbol id="mark"', close: '</symbol>' },
  { source: 'brand/wordmark.svg', host: 'site/og/card.html', open: '<symbol id="wordmark"', close: '</symbol>' }
]

/** An SVG's drawable content between the root tags; comments go with `squash`. */
function vectorBody(text) {
  const root = text.indexOf('<svg')
  const start = root < 0 ? -1 : text.indexOf('>', root)
  const end = text.lastIndexOf('</svg>')
  if (start < 0 || end < 0 || end <= start) return null
  return text.slice(start + 1, end)
}

const viewBoxOf = (tag) => /viewBox="([^"]*)"/.exec(tag)?.[1] ?? null

const squash = (text) =>
  text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function checkInlined({ source, host, open, close }) {
  const vector = read(source)
  const page = read(host)
  if (!vector || !page) return

  const text = vector.toString('utf8')
  const body = vectorBody(text)
  if (!body) {
    fail(source, 'has no root <svg> tag or no closing </svg>, so its geometry cannot be extracted.')
    return
  }
  const wanted = squash(body)
  // A floor on the extraction: the mark is one ~180-character path, so anything shorter is a fragment.
  if (wanted.length < 120) {
    fail(source, `extracted to only ${wanted.length} characters of geometry, which cannot be the whole mark.`)
    return
  }

  const html = page.toString('utf8')
  const at = html.indexOf(open)
  if (at < 0) {
    fail(host, `does not contain \`${open}\`, so the inlined copy of ${source} could not be found.`)
    return
  }
  const tagEnd = html.indexOf('>', at)
  const to = tagEnd < 0 ? -1 : html.indexOf(close, tagEnd)
  if (to < 0) {
    fail(host, `has an unterminated block where ${source} is inlined.`)
    return
  }
  // Same paths under a different viewBox are a cropped copy, not the mark.
  const wantedBox = viewBoxOf(text.slice(text.indexOf('<svg'), text.indexOf('>', text.indexOf('<svg'))))
  const foundBox = viewBoxOf(html.slice(at, tagEnd))
  if (wantedBox !== foundBox) {
    fail(host, `inlines ${source} under viewBox "${foundBox}" where the vector says "${wantedBox}".`)
  }
  const found = squash(html.slice(tagEnd + 1, to))
  if (found !== wanted) {
    fail(
      host,
      `its inlined copy of ${source} has drifted — ` +
        (found.length === wanted.length
          ? `same length (${found.length} characters), different geometry.`
          : `${found.length} characters against the vector's ${wanted.length}.`) +
        " Re-paste everything between the vector's root <svg> tag and its closing tag."
    )
  }
}

// ---------------------------------------------------------------- run them --

for (const entry of INLINED) checkInlined(entry)

checkPng('build/icon.png', 1024, 1024)
checkIco('build/icon.ico')
checkIcns('build/icon.icns')

// `linux.icon` takes the size from each filename, so name and pixels must agree.
for (const size of LINUX_SIZES) checkPng(join('build/icons', `${size}x${size}.png`), size, size)

for (const entry of SITE_PNGS) {
  if (!existsSync(join(root, entry.path))) {
    if (entry.required) fail(entry.path, 'does not exist, and the page links to it.')
    else notes.push(`${entry.path} is not present (optional, ${entry.width}x${entry.height} if it lands)`)
    continue
  }
  checkPng(entry.path, entry.width, entry.height)
}

if (failures.length > 0) {
  console.error(`verify-icons: FAIL — ${failures.length} problem(s).`)
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

for (const note of notes) console.log(`verify-icons: note — ${note}`)
console.log(
  `verify-icons: PASS — icon.png, ${ICO_SIZES.length} sizes in icon.ico, ` +
    `${ICNS_PNG_TYPES.length + ICNS_ARGB_TYPES.length} OSTypes in icon.icns and no icp4/icp5, ` +
    `${LINUX_SIZES.length} files in build/icons and ${SITE_PNGS.filter((entry) => existsSync(join(root, entry.path))).length} site images all carry the pixels they claim.`
)
