// Draws the application icon and writes every size and container the three
// packaging targets ask for: build/icon.png (Linux), build/icon.icns (macOS),
// build/icon.ico (Windows), and build/icons/<n>x<n>.png for desktop entries.
//
// Everything is rendered here rather than pulled from an image editor so the
// icon stays reproducible: `npm run icons` regenerates byte-identical files.
// Shapes are drawn from signed distance fields, which gives clean antialiasing
// at 16px as well as at 1024px without a rasteriser dependency.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const iconsDir = join(buildDir, 'icons')

// ---------------------------------------------------------------- geometry --

/** Distance from `p` to a rounded rectangle centred on the canvas. */
function roundedRectDistance(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius)
  const dy = Math.abs(y - cy) - (halfH - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/** Distance to a line segment, i.e. a stroke with round caps once offset. */
function segmentDistance(x, y, ax, ay, bx, by) {
  const vx = bx - ax
  const vy = by - ay
  const wx = x - ax
  const wy = y - ay
  const lengthSquared = vx * vx + vy * vy
  const t = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / lengthSquared))
  return Math.hypot(wx - vx * t, wy - vy * t)
}

/** A quadratic curve, flattened into segments; exactness is not worth the algebra. */
function curvePoints(ax, ay, cx, cy, bx, by, steps = 48) {
  const points = []
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps
    const u = 1 - t
    points.push([u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by])
  }
  return points
}

function polylineDistance(x, y, points, bounds) {
  // Cheap rejection: most pixels are nowhere near a branch, and the curve is
  // flattened into ~50 segments that would otherwise be measured against each.
  // The box is padded by a full stroke width, so anything outside it is farther
  // away than the stroke can reach and the exact number never matters.
  if (bounds && (x < bounds[0] || x > bounds[2] || y < bounds[1] || y > bounds[3])) return 1e6
  let best = Infinity
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1]
    const [bx, by] = points[i]
    const d = segmentDistance(x, y, ax, ay, bx, by)
    if (d < best) best = d
  }
  return best
}

// ------------------------------------------------------------------ colour --

function hex(value) {
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Straight-alpha source over an opaque-or-not destination. */
function over(dst, src, alpha) {
  const outAlpha = alpha + dst[3] * (1 - alpha)
  if (outAlpha <= 0) return [0, 0, 0, 0]
  for (let i = 0; i < 3; i += 1) {
    dst[i] = (src[i] * alpha + dst[i] * dst[3] * (1 - alpha)) / outAlpha
  }
  dst[3] = outAlpha
  return dst
}

// --------------------------------------------------------------- the image --

// The mark: a trunk with two worktrees branching off it, which is the one idea
// the product is built around. Drawn on a 1024 grid and scaled per size.
const GRID = 1024
const TILE_INSET = 56
const TILE_RADIUS = 208

const INK_TOP = hex(0x222c3a)
const INK_BOTTOM = hex(0x0d1014)
const TRUNK = hex(0xe8edf4)
const BRANCH_A = hex(0x5ee0c0)
const BRANCH_B = hex(0x7aa2ff)

const STROKE = 30
const NODE = 58

const TRUNK_X = 352
const TRUNK_TOP = 286
const TRUNK_BOTTOM = 742
const FORK_Y = 514

const branchUp = curvePoints(TRUNK_X, FORK_Y, 560, 500, 668, 348)
const branchDown = curvePoints(TRUNK_X, FORK_Y, 560, 528, 668, 680)

/** Padded bounding box of a flattened curve, used to skip far-away pixels. */
function boundsOf(points, pad) {
  const xs = points.map((point) => point[0])
  const ys = points.map((point) => point[1])
  return [Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad]
}

const branchUpBounds = boundsOf(branchUp, STROKE)
const branchDownBounds = boundsOf(branchDown, STROKE)

/**
 * Coverage-weighted colour at one point of the 1024 grid. `pixel` is the size of
 * a destination pixel in grid units, which is what keeps edges crisp when the
 * icon is rendered at 16px and soft-free when it is rendered at 1024px.
 */
function shade(x, y, pixel) {
  const aa = Math.max(pixel, 0.75)
  const coverage = (distance) => Math.min(1, Math.max(0, 0.5 - distance / aa))

  const out = [0, 0, 0, 0]

  const tile = roundedRectDistance(x, y, GRID / 2, GRID / 2, GRID / 2 - TILE_INSET, GRID / 2 - TILE_INSET, TILE_RADIUS)
  const tileAlpha = coverage(tile)
  if (tileAlpha <= 0) return out

  // A gentle top-to-bottom gradient, plus a soft highlight along the top edge so
  // the tile does not read as a flat rectangle at large sizes.
  const t = Math.min(1, Math.max(0, (y - TILE_INSET) / (GRID - 2 * TILE_INSET)))
  const base = mix(INK_TOP, INK_BOTTOM, Math.pow(t, 0.85))
  const sheen = Math.max(0, 1 - t * 4.2) * 0.10
  over(out, mix(base, [255, 255, 255], sheen), tileAlpha)

  const trunk = Math.min(
    segmentDistance(x, y, TRUNK_X, TRUNK_TOP, TRUNK_X, TRUNK_BOTTOM) - STROKE / 2,
    Math.hypot(x - TRUNK_X, y - TRUNK_TOP) - NODE / 2,
    Math.hypot(x - TRUNK_X, y - TRUNK_BOTTOM) - NODE / 2
  )
  const up = Math.min(
    polylineDistance(x, y, branchUp, branchUpBounds) - STROKE / 2,
    Math.hypot(x - 668, y - 348) - NODE / 2
  )
  const down = Math.min(
    polylineDistance(x, y, branchDown, branchDownBounds) - STROKE / 2,
    Math.hypot(x - 668, y - 680) - NODE / 2
  )

  // Branches first, trunk last: the trunk is the lightest colour and should sit
  // on top where the three meet.
  over(out, BRANCH_A, coverage(up) * tileAlpha)
  over(out, BRANCH_B, coverage(down) * tileAlpha)
  over(out, TRUNK, coverage(trunk) * tileAlpha)

  return out
}

function renderRgba(size) {
  const pixel = GRID / size
  const data = Buffer.alloc(size * size * 4)
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const [r, g, b, a] = shade((px + 0.5) * pixel, (py + 0.5) * pixel, pixel)
      const offset = (py * size + px) * 4
      data[offset] = Math.round(r)
      data[offset + 1] = Math.round(g)
      data[offset + 2] = Math.round(b)
      data[offset + 3] = Math.round(a * 255)
    }
  }
  return data
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

/** ICNS, PNG-backed. Type codes pair an OSType with the size it must contain. */
const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024]
]

function encodeIcns(pngBySize) {
  const chunks = []
  for (const [type, size] of ICNS_TYPES) {
    const png = pngBySize.get(size)
    const length = Buffer.alloc(4)
    length.writeUInt32BE(png.length + 8)
    chunks.push(Buffer.from(type, 'ascii'), length, png)
  }
  const body = Buffer.concat(chunks)
  const total = Buffer.alloc(8)
  total.write('icns', 0, 'ascii')
  total.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([total, body])
}

// ------------------------------------------------------------------- write --

const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const LINUX_SIZES = [16, 32, 48, 64, 128, 256, 512]
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

mkdirSync(iconsDir, { recursive: true })

const pngBySize = new Map()
for (const size of PNG_SIZES) pngBySize.set(size, encodePng(size, renderRgba(size)))

for (const size of LINUX_SIZES) {
  writeFileSync(join(iconsDir, `${size}x${size}.png`), pngBySize.get(size))
}
writeFileSync(join(buildDir, 'icon.png'), pngBySize.get(1024))
writeFileSync(join(buildDir, 'icon.ico'), encodeIco(ICO_SIZES.map((size) => ({ size, png: pngBySize.get(size) }))))
writeFileSync(join(buildDir, 'icon.icns'), encodeIcns(pngBySize))

console.log(`make-icons: wrote build/icon.png, build/icon.icns, build/icon.ico and ${LINUX_SIZES.length} files in build/icons`)
