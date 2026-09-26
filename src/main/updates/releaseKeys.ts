// The owner's ed25519 keys that sign each release's teamree-mac.json (docs/releasing.md).
// scripts/release.mjs reads the PEM blocks straight out of this file, so they stay literal.

/** Any one verifying is enough: a rotation ships the new key beside the old, in a release the old one signs. */
export const TRUSTED_RELEASE_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9gaSqnL7jDwCMPjxfSkQKGAmJGP02Nzu+7TXKn+0fCY=
-----END PUBLIC KEY-----`
]
