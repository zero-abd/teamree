// A name for a rendezvous that can safely be put in a URL.
//
// The rendezvous token is a shared secret: anyone holding it can claim a pairing
// and knock the real pair off it. URLs are the least private thing in an HTTP
// stack — they reach proxy logs, request analytics and error reports — so the
// token never goes in one. What goes in the URL is its SHA-256, which names the
// same pairing without conferring the ability to claim it.
//
// The Worker host does check that the two agree, and the check is not about the
// peer that got it wrong. A Durable Object is chosen by the name in the URL
// before any frame arrives, so a hello carrying some other token would otherwise
// park a socket in an object it has no business being in, for the whole pairing
// budget, holding a slot against the pair the rendezvous belongs to. Requiring
// the hello to name the object it landed in costs a legitimate peer nothing — it
// derived the one from the other — and costs a squatter the only thing it had.
// The container host pairs on the token alone and has no name to check against.

export async function rendezvousId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
