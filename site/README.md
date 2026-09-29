# site

The landing page at <https://teamree.us>. Static: `public/` is exactly what is served, plus `worker.js`, which only
answers byte-range requests for the clips.

```
public/
  index.html       the page; CSS and JS inline
  404.html         served with a real 404 for any unknown path
  demos/           clips: <id>-1080|720.webm (AV1) and .mp4 (H.264), <id>.webp posters,
                   manifest.json, showreel.vtt (captions for the reel's voice-over)
  sprig/           Sprig stills (transparent WebP), rendered in the studio (tools/site-sprig.mjs)
  og.png           1200x630 social card, generated from og/card.html
  robots.txt, sitemap.xml, _headers, _redirects, favicon and icons
og/
  card.html        source for og.png;  sh site/og/render.sh  rasterises it with headless Chrome
tools/
  encode-demos.mjs encodes the clips listed in the manifest from their masters
  check-demos.mjs  checks the page's clip slots against the manifest and that every named asset exists
worker.js          206 answers for Range requests on /demos/* and /sprig/*
```

## Clips

Each `<figure class="clip" data-clip="<id>" data-sizes="1080,720">` holds a `<video preload="none">` with its
width, height and poster. The page's script adds the `<source>`s (AV1 WebM first, then H.264 MP4, 1080 or 720 by
rendered width) when the clip nears the viewport, plays it only while it is on screen, and never autoplays under
`prefers-reduced-motion`.

The masters are the studio's clip library (v0.8.3, stand-in agents, Studio dark and light). To re-encode:

```sh
FFMPEG=/path/to/ffmpeg node site/tools/encode-demos.mjs --from <studio dir> [id...]
node site/tools/check-demos.mjs
```

`manifest.json` names each clip's master, poster frame, size and sizes; `crf` overrides the default quality
(`[h264, av1]`). The ffmpeg needs libx264, libsvtav1, libopus and libwebp.

### The showreel slot

The hero reel is the `showreel` clip, marked `SHOWREEL SLOT` in `index.html`. To swap in a new reel: point the
manifest's `showreel` entry at it, run the encoder for `showreel`, and replace `demos/showreel.vtt` with the new
voice-over's captions.

## Deploying

```sh
npm run site:deploy      # from the repository root
```

A Worker with static assets named `teamree-site` (account "Dev Abd"), configured by `site/wrangler.jsonc`, serving
teamree.us and www.teamree.us. There is no CI deploy. `npm run site:versions` lists versions and
`npm run site:rollback` restores the previous one.

After a deploy:

```sh
curl -sSI https://teamree.us/ | head -3                                        # 200
curl -sS -o /dev/null -w '%{http_code}\n' https://teamree.us/no-such-page       # 404
curl -sS -r 0-1023 -o /dev/null -D- https://teamree.us/demos/land-720.mp4       # 206 + content-range
curl -sSI https://teamree.us/download/mac | grep -E '^(HTTP|location|cache-control)'   # 302, no-store
```

Assets are not content-hashed, so `_headers` keeps them at `max-age=300` with `stale-while-revalidate`; the
download redirects are `no-store` so they always follow GitHub's latest release.

## Claims

Every fact on the page comes from the app, `docs/install.md` or the release notes. The install section and
`docs/install.md` must agree: the dialog is **"teamree" Not Opened** with **Move to Trash** and **Done**; press
Done, then **Open Anyway** in System Settings → Privacy & Security, or clear the quarantine flag with `xattr`.
