// Runs the peer library's cipher path in whatever runtime executes this file. vitest runs under Node,
// whose OpenSSL has chacha20-poly1305; Electron's BoringSSL does not, and that once shipped a dead
// teamwork feature past a green suite. Run under Electron, under Node (the control), and from smoke.mjs.
// Assertions collect rather than throw, so one run names everything wrong.

import { readFileSync } from 'node:fs'
import { getCiphers } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { PEER_BUNDLE_FLAG, readNamedArg } from './smoke-args.mjs'

const CORPUS_URL = new URL('../src/shared/peer/noiseVectors.json', import.meta.url)

const bytes = (hex) => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (value) => Buffer.from(value).toString('hex')
const utf8 = (text) => new Uint8Array(Buffer.from(text, 'utf8'))
const EMPTY = new Uint8Array(0)

/**
 * AEAD known answers with the Noise nonce encoding, recomputed against native chacha20-poly1305 by
 * electronRuntime.test.ts. 4294967296 catches a big-endian slip; the last is Noise's largest nonce.
 */
export const AEAD_KNOWN_ANSWERS = {
  key: 'c4a34b21897e983c59dd5a2fd8f9be5550cef3385b5ecac49c118906f0840755',
  associatedData: 'a7979538eb6473b1d3f2b5fde542c385ca8f91504b5b94490573ea9700caab70',
  plaintext:
    '7465616d7265652070656572207472616e73706f7274206672616d652c2070696e6e656420736f206120646966666572656e74206369706865722063616e6e6f742070617373',
  ciphertexts: [
    {
      nonce: '0',
      hex: '1281b43abd4cef4e5938bead8f45e27f32585deaebe5e2afdd0f4b4a7707539cc8b0b293af2169796854ee0b5d42910ae71f8fbbb492f0b87f5856c4b1a4abfd56b5778a3cb17ca03a31e3b804ea647e14d75a1693c6'
    },
    {
      nonce: '1',
      hex: '4522dbf423be001ff38ee553ded5321f4c3b656198f538f9c491adff5b485eea6653e63032f4a346f8f192822de2a2b0fa7852efb4645360e92cb3a91538aa8524c7568a69edca0af2d31a40a5b5cd978f9414b4c901'
    },
    {
      nonce: '4294967296',
      hex: '0d9220a716b662461a2bcd1de04c8a1475eb036e2cb72de0bc622f888f0387c7b886d3e4b187785c026cded7e9b35f03479228d36a067ff930303ccb129cd3482d30671af07acf612223dc978c2f05e0ca5618cc1264'
    },
    {
      nonce: '18446744073709551615',
      hex: 'dd1aa227cc67d7b57177fe3906d51d7215914457b27dc5dd63b14ccc3c6949a9eec2f9ee6aefba35bf6ef7ce1d407b27e0fcce067b154e1ab1e191e6dc28ec1bb63f31bae6552d43b87d56530e2a50fcf5c5a62fb469'
    }
  ]
}

/** The one pattern this library exports. Restated here so a wrong one fails the vector. */
const IK_PATTERN = {
  name: 'IK',
  initiatorPreMessage: [],
  responderPreMessage: ['s'],
  messages: [
    ['e', 'es', 's', 'ss'],
    ['e', 'ee', 'se']
  ]
}

const EXPECTED_PROTOCOL_NAME = 'Noise_IK_25519_ChaChaPoly_SHA256'

function loadIkVector() {
  const corpus = JSON.parse(readFileSync(CORPUS_URL, 'utf8'))
  const vector = corpus.vectors.find((entry) => entry.protocol_name === EXPECTED_PROTOCOL_NAME)
  if (!vector) throw new Error(`${EXPECTED_PROTOCOL_NAME} is not in ${corpus.source}`)
  return vector
}

/** Hands out the vector's fixed ephemeral, so the bytes are reproducible. */
function pinnedRandom(ephemeral) {
  let issued = 0
  return () => {
    issued += 1
    if (issued > 1) throw new Error('IK asks each side for exactly one ephemeral')
    return bytes(ephemeral)
  }
}

// --------------------------------------------------------------- the checks --

function checkAead(primitives, fail) {
  const key = bytes(AEAD_KNOWN_ANSWERS.key)
  const ad = bytes(AEAD_KNOWN_ANSWERS.associatedData)
  const plaintext = bytes(AEAD_KNOWN_ANSWERS.plaintext)

  for (const expected of AEAD_KNOWN_ANSWERS.ciphertexts) {
    const nonce = BigInt(expected.nonce)
    let ciphertext
    try {
      ciphertext = primitives.aeadEncrypt(key, nonce, ad, plaintext)
    } catch (error) {
      fail(`aeadEncrypt at nonce ${expected.nonce} threw: ${error.message}`)
      continue
    }
    if (hex(ciphertext) !== expected.hex) {
      fail(`aeadEncrypt at nonce ${expected.nonce} produced ${hex(ciphertext)}, not the published answer`)
      continue
    }
    try {
      const back = primitives.aeadDecrypt(key, nonce, ad, bytes(expected.hex))
      if (hex(back) !== AEAD_KNOWN_ANSWERS.plaintext) {
        fail(`aeadDecrypt at nonce ${expected.nonce} did not return the plaintext`)
      }
    } catch (error) {
      fail(`aeadDecrypt at nonce ${expected.nonce} threw: ${error.message}`)
    }
  }

  // A stub that returned its input would pass everything above.
  const forged = bytes(AEAD_KNOWN_ANSWERS.ciphertexts[0].hex)
  forged[forged.length - 1] ^= 0x01
  try {
    primitives.aeadDecrypt(key, 0n, ad, forged)
    fail('aeadDecrypt accepted a ciphertext with a flipped bit in its tag')
  } catch {
    // Correct: every decryption failure is meant to look the same from outside.
  }
}

function checkPublishedVector(noise, primitives, fail) {
  const vector = loadIkVector()

  const stateFor = (initiator) => {
    const privateKey = bytes(initiator ? vector.init_static : vector.resp_static)
    const remote = initiator ? vector.init_remote_static : vector.resp_remote_static
    return noise.initializeHandshake({
      pattern: IK_PATTERN,
      initiator,
      prologue: bytes(initiator ? vector.init_prologue : vector.resp_prologue),
      staticKeyPair: { privateKey, publicKey: primitives.derivePublicKey(privateKey) },
      remoteStaticPublicKey: remote ? bytes(remote) : null,
      random: pinnedRandom(initiator ? vector.init_ephemeral : vector.resp_ephemeral)
    })
  }

  let initiator
  let responder
  try {
    initiator = stateFor(true)
    responder = stateFor(false)
  } catch (error) {
    fail(`could not start the published IK handshake: ${error.message}`)
    return
  }

  let transport = null

  for (const [index, message] of vector.messages.entries()) {
    const payload = bytes(message.payload)
    const fromInitiator = index % 2 === 0

    try {
      if (!transport) {
        const sender = fromInitiator ? initiator : responder
        const receiver = fromInitiator ? responder : initiator
        const written = noise.writeMessage(sender, payload)
        if (hex(written.bytes) !== message.ciphertext) {
          fail(`handshake message ${index} was ${hex(written.bytes)}, not the published ciphertext`)
          return
        }
        const read = noise.readMessage(receiver, bytes(message.ciphertext))
        if (hex(read.bytes) !== message.payload) {
          fail(`handshake message ${index} did not decrypt back to the published payload`)
          return
        }
        if (written.transport && read.transport) {
          transport = fromInitiator
            ? { initiator: written.transport, responder: read.transport }
            : { initiator: read.transport, responder: written.transport }
          for (const [side, state] of [
            ['initiator', initiator],
            ['responder', responder]
          ]) {
            if (hex(noise.handshakeHash(state)) !== vector.handshake_hash) {
              fail(`the ${side}'s transcript hash does not match the published one`)
            }
          }
        }
        continue
      }

      const send = fromInitiator ? transport.initiator.initiatorToResponder : transport.responder.responderToInitiator
      const receive = fromInitiator
        ? transport.responder.initiatorToResponder
        : transport.initiator.responderToInitiator

      const ciphertext = noise.encryptWithAd(send, EMPTY, payload)
      if (hex(ciphertext) !== message.ciphertext) {
        fail(`transport message ${index} was ${hex(ciphertext)}, not the published ciphertext`)
        return
      }
      if (hex(noise.decryptWithAd(receive, EMPTY, bytes(message.ciphertext))) !== message.payload) {
        fail(`transport message ${index} did not decrypt back to the published payload`)
        return
      }
    } catch (error) {
      fail(`${EXPECTED_PROTOCOL_NAME} message ${index} threw: ${error.message}`)
      return
    }
  }

  if (!transport) fail('the published IK handshake never reached transport keys')
}

/** The exported session API end to end, two peers, real randomness, in this runtime. */
function checkLiveSession(peer, fail) {
  let initiator
  let responder
  try {
    const alice = peer.generateStaticKeyPair()
    const bob = peer.generateStaticKeyPair()
    const prologue = utf8('teamree/electron-peer-check')

    initiator = peer.createInitiatorSession({
      staticPrivateKey: alice.privateKey,
      remoteStaticPublicKey: bob.publicKey,
      prologue
    })
    responder = peer.createResponderSession({
      staticPrivateKey: bob.privateKey,
      isAuthorisedPeer: (key) => Buffer.from(key).equals(Buffer.from(alice.publicKey)),
      prologue
    })

    responder.readHandshakeMessage(initiator.writeHandshakeMessage())
    initiator.readHandshakeMessage(responder.writeHandshakeMessage(utf8('hello back')))

    if (initiator.stage !== 'established' || responder.stage !== 'established') {
      fail(`the handshake did not establish (initiator ${initiator.stage}, responder ${responder.stage})`)
      return
    }
    if (hex(initiator.handshakeHash()) !== hex(responder.handshakeHash())) {
      fail('the two sides disagree about the transcript hash')
    }

    const outbound = utf8('a frame that has to survive the round trip')
    if (hex(responder.decrypt(initiator.encrypt(outbound))) !== hex(outbound)) {
      fail('a frame from the initiator did not arrive intact')
    }
    const inbound = utf8('and one coming back the other way')
    if (hex(initiator.decrypt(responder.encrypt(inbound))) !== hex(inbound)) {
      fail('a frame from the responder did not arrive intact')
    }
    if (!responder.confirmed) fail('the responder never confirmed the peer it decrypted a frame from')
    if (hex(responder.remoteStaticPublicKey()) !== hex(alice.publicKey)) {
      fail('the responder authenticated the wrong static key')
    }

    // A frame with a bit flipped must be refused, and must close the session.
    const tampered = initiator.encrypt(utf8('tamper'))
    tampered[tampered.length - 1] ^= 0x01
    try {
      responder.decrypt(tampered)
      fail('the responder accepted a frame with a flipped bit')
    } catch {
      // Correct.
    }
  } catch (error) {
    fail(`the live session threw: ${error.stack ?? error.message}`)
  } finally {
    initiator?.close()
    responder?.close()
  }
}

// ------------------------------------------------------------------ the run --

/** @param bundleDir output of `buildPeerBundle()`, compiled to ESM. */
export async function runPeerCheck(bundleDir) {
  const failures = []
  const fail = (message) => failures.push(message)

  const load = (name) => import(pathToFileURL(`${bundleDir}/${name}.js`).href)

  const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.versions.node}`
  // If a run claims Electron and this says the native cipher was there, it was not under Electron.
  const nativeChaCha = getCiphers().includes('chacha20-poly1305')

  let peer
  let noise
  let primitives
  try {
    ;[peer, noise, primitives] = await Promise.all([load('index'), load('noise'), load('primitives')])
  } catch (error) {
    return { runtime, nativeChaCha, failures: [`could not import the peer bundle: ${error.message}`] }
  }

  if (peer.PROTOCOL_NAME !== EXPECTED_PROTOCOL_NAME) {
    fail(`the library calls itself ${peer.PROTOCOL_NAME}, and this check pins ${EXPECTED_PROTOCOL_NAME}`)
  }

  checkAead(primitives, fail)
  checkPublishedVector(noise, primitives, fail)
  checkLiveSession(peer, fail)

  return { runtime, nativeChaCha, failures }
}

// Run directly: `node scripts/electron-peer-check.mjs <bundleDir>` or under Electron; one JSON line
// on stdout. `--peer-bundle=<dir>` is what run-smoke.mjs passes (see smoke-args.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bundleDir = readNamedArg(PEER_BUNDLE_FLAG) ?? process.argv[2]
  if (!bundleDir) {
    console.error('electron-peer-check: pass the directory that buildPeerBundle() wrote')
    process.exit(2)
  }
  const result = await runPeerCheck(bundleDir)
  console.log(JSON.stringify(result))
  for (const failure of result.failures) console.error(`electron-peer-check: ${failure}`)
  process.exit(result.failures.length === 0 ? 0 : 1)
}
