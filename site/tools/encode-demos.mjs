// Encode every clip in public/demos/manifest.json from its master: <id>-<size>.webm (AV1), <id>-<size>.mp4 (H.264)
// and a 1280px <id>.webp poster. Usage: node site/tools/encode-demos.mjs --from <studio dir> [id...]
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const demos = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'demos')
const manifestPath = join(demos, 'manifest.json')
const args = process.argv.slice(2)
const at = args.indexOf('--from')
const from = at < 0 ? '' : resolve(args[at + 1] ?? '')
const only = args.filter((a, i) => !a.startsWith('--') && i !== at + 1)
const ffmpeg = process.env.FFMPEG || 'ffmpeg'
if (!from || !existsSync(from)) throw new Error('pass --from <dir> holding the clip masters')

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const run = (...a) => execFileSync(ffmpeg, ['-v', 'error', '-y', ...a], { stdio: 'inherit' })
const even = (n) => Math.round(n / 2) * 2

for (const clip of manifest.clips) {
  if (only.length && !only.includes(clip.id)) continue
  const src = join(from, clip.source)
  for (const size of clip.sizes) {
    const w = even((clip.width * size) / clip.height)
    const vf = `fps=30,scale=${w}:${size}:flags=lanczos,format=yuv420p`
    const base = join(demos, `${clip.id}-${size}`)
    const audio = (codec, rate) => (clip.audio ? ['-c:a', codec, '-b:a', rate] : ['-an'])
    const [crf264, crfAv1] = (clip.crf ?? [21, 32]).map(String)
    run(
      '-i',
      src,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      crf264,
      '-tune',
      'animation',
      '-profile:v',
      'high',
      '-level',
      '4.0',
      ...audio('aac', '96k'),
      '-movflags',
      '+faststart',
      `${base}.mp4`
    )
    run(
      '-i',
      src,
      '-vf',
      vf,
      '-c:v',
      'libsvtav1',
      '-preset',
      '5',
      '-crf',
      crfAv1,
      '-g',
      '300',
      '-svtav1-params',
      'tune=0',
      ...audio('libopus', '80k'),
      `${base}.webm`
    )
    console.log(`${clip.id}-${size}: mp4 ${statSync(`${base}.mp4`).size} B, webm ${statSync(`${base}.webm`).size} B`)
  }
  run(
    '-i',
    join(from, clip.poster),
    '-vf',
    'scale=1280:-2:flags=lanczos',
    '-c:v',
    'libwebp',
    '-quality',
    '72',
    '-compression_level',
    '6',
    join(demos, `${clip.id}.webp`)
  )
  if (clip.smallPoster)
    run(
      '-i',
      join(from, clip.poster),
      '-vf',
      `scale=${clip.smallPoster}:-2:flags=lanczos`,
      '-c:v',
      'libwebp',
      '-quality',
      '70',
      '-compression_level',
      '6',
      join(demos, `${clip.id}-${clip.smallPoster}.webp`)
    )
  const probe = spawnSync(ffmpeg, ['-hide_banner', '-i', join(demos, `${clip.id}-${clip.sizes.at(-1)}.mp4`)], {
    encoding: 'utf8'
  }).stderr
  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(probe)
  if (d) clip.seconds = Math.round((+d[1] * 3600 + +d[2] * 60 + +d[3]) * 100) / 100
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
