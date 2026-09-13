// Checks that the generated icon set is the thing the three packaging targets
// and the landing page actually need, rather than a set of files with the right
// names.
//
// `npm run icons` hand-writes PNG, ICO and ICNS containers with no image
// library involved, and the artwork inside them is being replaced. The failure
// that matters is not a missing file — electron-builder says so loudly — it is a
// container whose directory *claims* one size and whose payload is another. An
// ICNS assembled from a single render, with the same 512px image filed under
// every OSType, is a valid file that macOS accepts and then draws soft in the
// Dock at 1024, and nothing in a build log ever mentions it.
//
// So every check here opens the payload and reads its real IHDR width and
// height, and compares that against what the enclosing directory promised.
//
// That was not enough, and the way it was not enough is the reason for the
// second half of this file. An earlier .icns filed its 16px and 32px renders
// under the OSTypes `icp4` and `icp5`. Every chunk in it was a clean,
// correctly-sized PNG — this script read them and passed — and macOS drew red
// and green noise in the Dock, because both codes are ambiguous and it read
// them as raw ARGB, running off the end of the payload into the next chunk.
// Reading the chunks directly is *precisely* what missed it: the chunks were
// fine and the type was wrong.
//
// So there are now two independent checks that a header cannot express:
//
//   1. `icp4` and `icp5` are a hard failure wherever they appear. Apple's own
//      `iconutil` writes neither; it writes `ic04`/`ic05` as RLE ARGB instead.
//   2. Every icon is decoded and its saturated pixels counted. The mark is
//      black, white and one dark grey, so a correct icon has essentially none;
//      the corrupt 16x16 had 218 of 256. For the .icns this runs against the
//      file *extracted* with `iconutil`, which is the only reader whose opinion
//      matters.
//
// Check 2 on the .icns therefore needs macOS. Everything else — the PNGs, the
// ICO, the chunk table, the saturation of every standalone file — is pure Node
// and still runs on a Linux CI runner; the icns extraction is skipped there
// with a note rather than failing.
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
 * The PNG-backed OSTypes `iconutil` emits, each paired with the pixel size that
 * code promises. The retina codes are the ones worth naming: ic11 is 16@2x,
 * ic12 is 32@2x, ic13 is 128@2x, ic14 is 256@2x and ic10 is 512@2x — so their
 * pixel sizes are 32, 64, 256, 512 and 1024.
 *
 * Deliberately a second, independent statement of the table in
 * scripts/make-icons.mjs rather than an import of it. A check that reads its
 * expectations out of the code it is checking agrees with that code by
 * construction, including when that code is wrong.
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

/**
 * 16 and 32, which `iconutil` writes as RLE-compressed ARGB rather than PNG.
 * There is no IHDR to read, so all that can be checked here is that they are
 * present and not empty; the artwork in them is checked by extracting the file
 * further down.
 */
const ICNS_ARGB_TYPES = [
  ['ic04', 16],
  ['ic05', 32]
]

/**
 * Never acceptable. `icp4` and `icp5` nominally mean 16x16 and 32x32, and a PNG
 * filed under either is read by macOS as raw ARGB and drawn as noise. Their
 * presence is the signature of a hand-assembled .icns and is a hard failure,
 * not a warning — this exact file shipped once.
 */
const ICNS_FORBIDDEN_TYPES = ['icp4', 'icp5']

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]

// The page's own declarations, read off site/public/index.html: icon-256.png is
// linked with sizes="256x256", og.png is declared 1200x630 by og:image:width and
// og:image:height, and screenshot.png carries width/height attributes. The
// remaining entries are the rest of the set `npm run icons` now writes — the tab
// icon, the iOS home-screen icon and the two large web-manifest sizes — each
// named for the pixels it must contain, which is the only thing a browser or a
// home screen has to go on when it picks one.
const SITE_PNGS = [
  { path: 'site/public/icon-32.png', width: 32, height: 32, required: true },
  { path: 'site/public/icon-256.png', width: 256, height: 256, required: true },
  { path: 'site/public/og.png', width: 1200, height: 630, required: true },
  // The screenshot is the one entry here that is a 2x asset: the page reserves a
  // 1400x900 slot for it (`width`/`height` on the <img>), and the file is the
  // device-pixel version of that slot. Checking the 1x number would fail a
  // correct retina image, and checking nothing would let a mismatched aspect
  // through and shift the layout while it loads.
  { path: 'site/public/screenshot.png', width: 2800, height: 1800, required: true },
  { path: 'site/public/apple-touch-icon.png', width: 180, height: 180, required: true },
  { path: 'site/public/icon-192.png', width: 192, height: 192, required: true },
  { path: 'site/public/icon-512.png', width: 512, height: 512, required: true }
]

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Real dimensions of a PNG, from its IHDR. The IHDR is required by the format to
 * be the first chunk, so it always starts at byte 8: a four-byte length, the
 * four-byte type, then the width and the height.
 */
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
 * The mark is drawn in exactly three colours — #FFFFFF, #0A0C10 and #0B0D12 —
 * so every pixel in a correct icon is a grey, and the only spread between its
 * channels is whatever antialiasing introduces between two greys, which is
 * none. A corrupt payload read as the wrong format is the opposite: channel
 * values that no longer belong to the same pixel, which is why it comes out as
 * saturated colour. `SATURATION_LIMIT` is generous — the corrupt 16x16 that
 * prompted this was 85% saturated and a correct one is 0% — because the point
 * is to catch garbage, not to police a fringe pixel.
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
  // Palette images would need the PLTE table resolved; nothing here writes one,
  // and guessing is worse than saying so.
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
      `is ${(fraction * 100).toFixed(0)}% saturated colour. The mark is black, white and one grey, so this is ` +
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

  // The hard failure. A PNG under either of these is read by macOS as raw ARGB
  // and drawn as colour noise, and it passes every size check there is.
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
    // The check this whole script exists for: the OSType is a promise about
    // pixels, and an icns built from one render and filed under every code
    // passes every other check there is.
    if (size.width !== expected || size.height !== expected) {
      fail(
        relativePath,
        `chunk \`${type}\` promises ${expected}x${expected} but contains a ${describe(size)} image. ` +
          'The icns was built at the wrong size, or from one render scaled.'
      )
    }
    checkNotNoise(`${relativePath} chunk \`${type}\``, payload)
  }

  // ic04/ic05 are RLE ARGB with no header to read. Presence and a plausible
  // length is all this half of the script can say; the artwork in them is
  // checked by extracting the file below.
  for (const [type, expected] of ICNS_ARGB_TYPES) {
    const payload = found.get(type)
    if (!payload) {
      fail(relativePath, `is missing the \`${type}\` chunk, which macOS wants at ${expected}x${expected}.`)
    } else if (payload.length < 64) {
      fail(relativePath, `chunk \`${type}\` is only ${payload.length} bytes, which cannot be a ${expected}px icon.`)
    } else if (pngSize(payload)) {
      // A PNG here is the icp4/icp5 mistake wearing a different name: these two
      // codes are ARGB, and macOS will read a PNG under them as raw pixels.
      fail(relativePath, `chunk \`${type}\` contains a PNG. ic04 and ic05 are RLE ARGB — let iconutil write them.`)
    }
  }

  const known = new Set([...ICNS_PNG_TYPES, ...ICNS_ARGB_TYPES].map(([type]) => type))
  const extra = [...found.keys()].filter((type) => !known.has(type) && !ICNS_FORBIDDEN_TYPES.includes(type))
  if (extra.length > 0) notes.push(`${relativePath} also carries ${extra.join(', ')}, which nothing here checks`)

  extractAndCheckIcns(relativePath)
}

/**
 * The check the chunk walk above cannot make: hand the file to the reader that
 * actually draws it. `iconutil -c iconset` expands every entry, ic04 and ic05
 * included, through macOS's own decoder — so if a payload is filed under a type
 * that decoder misreads, what lands on disk is the noise, and the saturation
 * check sees it. Skipped where iconutil does not exist, which is everywhere
 * except a Mac.
 */
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
    // A zero byte in the directory means 256: the field is one byte wide and
    // 256 does not fit in it.
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

// ---------------------------------------------------------------- run them --

checkPng('build/icon.png', 1024, 1024)
checkIco('build/icon.ico')
checkIcns('build/icon.icns')

// electron-builder's `linux.icon` points at a directory and takes the size from
// each filename, so the name and the pixels have to agree or the .desktop entry
// installs an icon into the wrong theme directory.
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
