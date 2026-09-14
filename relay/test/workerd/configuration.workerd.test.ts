// A limit the Worker cannot parse, under the runtime that will be running it.
//
// `test/operability.test.ts` proves that `configFromEnv` throws rather than
// guessing, which is the rule. What it cannot say is what a deployed Worker does
// with a throw, and that is the part an operator meets: they edit a number in
// `wrangler.jsonc`, type `wrangler deploy`, and find out whether the mistake is
// loud. A Worker is not a process that fails to start — the deploy succeeds and
// the bundle is fine — so the only honest answer is what happens to a request,
// and this is where that gets answered instead of assumed.
//
// Its own `wrangler dev`, because a var belongs to a whole server and the rest of
// the suite needs one that works.
//
// The upgrade is what is asserted, and only the upgrade. A plain `GET /healthz`
// against a Worker in this state never answers at all under `wrangler dev` — its
// local proxy holds the request open rather than passing the failure back — and
// that is the development server's behaviour rather than the relay's, so
// asserting it here would be writing down a fact about wrangler in a file about
// the relay.

import { describe, expect, it } from 'vitest'
import { rendezvousToken } from '../support/harness.js'
import { announceSkip, offerWorkerdPeer, startWorkerdRelay, workerdUnavailable } from './support/workerd.js'

const unavailable = workerdUnavailable()
if (unavailable !== null) announceSkip(unavailable)

describe.skipIf(unavailable !== null)('a worker given a limit it cannot parse', () => {
  it('refuses every request rather than quietly falling back to the default', async () => {
    const relay = await startWorkerdRelay({ RELAY_MAX_FRAMES_PER_SECOND: 'plenty' })
    try {
      const offered = await offerWorkerdPeer(relay, rendezvousToken())

      // Nothing is upgraded and nothing is relayed. A relay that fell back to
      // 200 frames a second here would be one whose operator believes it is
      // enforcing a number they typed and it is not, which is the failure this
      // whole configuration module is shaped around avoiding.
      expect(offered.accepted).toBe(false)
      if (!offered.accepted) expect(offered.status).toBe(500)
    } finally {
      await relay.stop()
    }
  }, 180_000)
})
