// A name for a rendezvous that can safely be put in a URL.
//
// The rendezvous token is a shared secret: anyone holding it can claim a pairing
// and knock the real pair off it. URLs are the least private thing in an HTTP
// stack — they reach proxy logs, request analytics and error reports — so the
// token never goes in one. What goes in the URL is its SHA-256, which names the
// same pairing without conferring the ability to claim it.
//
// The relay never checks that the two agree. It has no reason to: a peer that
// sends a hint for one pairing and a token for another simply lands somewhere
// its partner is not, which costs only that peer.

export async function rendezvousId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
