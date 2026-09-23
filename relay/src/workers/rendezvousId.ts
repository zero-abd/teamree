// A URL-safe name for a rendezvous: its SHA-256, since the token itself claims pairings and URLs reach
// logs. The Worker host requires the hello's token to hash to the object it landed in, so a squatter
// cannot park in another pair's object; the container host pairs on the token alone.

export async function rendezvousId(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
