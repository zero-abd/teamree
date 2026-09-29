// Answers byte-range requests for the clips: static assets return the whole file with a 200, and Safari will not
// play or seek a video served that way. Everything else is the asset response untouched.
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request)
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range')?.trim() ?? '')
    if (!range || res.status !== 200 || request.method !== 'GET') return withRanges(res)
    const body = await res.arrayBuffer()
    const size = body.byteLength
    const suffix = range[1] === ''
    const start = suffix ? Math.max(0, size - Number(range[2])) : Number(range[1])
    const end = suffix || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)
    const headers = new Headers(res.headers)
    headers.set('accept-ranges', 'bytes')
    if (start > end || start >= size) {
      headers.set('content-range', `bytes */${size}`)
      headers.delete('content-length')
      return new Response(null, { status: 416, headers })
    }
    headers.set('content-range', `bytes ${start}-${end}/${size}`)
    headers.set('content-length', String(end - start + 1))
    return new Response(body.slice(start, end + 1), { status: 206, headers })
  }
}

function withRanges(res) {
  if (res.status !== 200) return res
  const out = new Response(res.body, res)
  out.headers.set('accept-ranges', 'bytes')
  return out
}
