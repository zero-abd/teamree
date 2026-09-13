// Web Crypto rather than node:crypto, so nothing in core has to be told which
// runtime it is in. Every environment this could plausibly run on — Node 19 and
// up, and every edge runtime — exposes getRandomValues on the global.

export function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  let hex = ''
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0')
  return hex
}
