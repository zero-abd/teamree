# Human-backed workers

An optional enrollment website for Teamree. A worker follows a team invitation,
completes Persona Relay's `live_human_presence` verification, and downloads a
signed `.pub` member file. The desktop app validates the signature when reading
the project roster. Existing Noise authentication proves possession of the
corresponding device key when peers connect.

Only a successful server-retrieved Persona claim grants the certificate. The
browser callback or a locally edited member file cannot grant it.

## Run locally

Use Node 22.12+ and run these commands from `membership/`:

```powershell
npm ci --ignore-scripts
npm run build
node scripts/invite.mjs my-team alice "THE_DEVICE_PUBLIC_KEY_FROM_TEAMREE_MEMBERS"
$env:MEMBERSHIP_TEAM_ID = 'my-team'
$env:MEMBERSHIP_ORIGIN = 'http://localhost:4319'
$env:MEMBERSHIP_SIGNING_KEY_FILE = '.local/issuer.pem'
$env:MEMBERSHIP_INVITATIONS_FILE = '.local/invitations.json'
$env:PERSONA_SANDBOX = 'true'
# Set PERSONA_API_KEY in this server's environment using your secret manager.
npm start
```

`--ignore-scripts` avoids a Unix-only Git hook install command in the current
Persona SDK package on Windows. Vite's platform binary is supplied by its npm
optional dependency. The lockfile pins the installed versions.

Open http://localhost:4319 and enter the generated invitation. Invitations bind
the approved handle and device public key before verification; neither is
accepted from the completion request. Generate another invitation by running
the command with another handle/key, then restart the server. Keep `.local/`
private and backed up. Never put the Persona API key or issuer private key in
the desktop app, public frontend, Git history, or project configuration.

For a remotely reachable website, set `MEMBERSHIP_ORIGIN` to its HTTPS origin,
set `HOST` as needed, and run behind an HTTPS reverse proxy with rate limiting.
The widget needs camera access and the Persona configuration must allow the
website origin. Confirm your Persona account supports Relay and use its test
environment for the first pass; this app has no client-selectable mock/pass mode.
`PERSONA_SANDBOX=true` selects Relay's server-side sandbox option. Use a test API
key with it; remove this flag and use your production API key for real checks.
Keep test and production issuer keys, policies and team IDs separate: sandbox
results must never grant production membership.

## Require verification on a project

1. Generate invitations for existing members, including the team owner, and
   collect their signed member files before enabling the policy.
2. Copy `.local/human-policy.json` into the project's `.teamree/human-policy.json`.
   This file contains only the team ID, public signing key, and revoked IDs.
3. Save each download as `.teamree/members/<handle>.pub`. Commit and review the
   policy and member files together. Protect both paths with repository review
   rules. Everyone with authority to replace/remove the policy can change the
   trust requirement, just as they can currently edit membership.
4. All peers must run this feature branch's build. Old clients do not enforce
   the new policy. Restart clients after policy changes to ensure active links
   are reconciled; restart after pulling revocations as well.

With no policy file, existing teams keep the original membership behavior. With
a policy, missing/forged/wrong-team/wrong-key/revoked proofs are excluded from
the roster. A malformed policy disables the roster. `Add my key` and the CLI
join method refuse to create unsigned files for protected projects. The Members
dialog exposes the device public key for invitation creation.

## Revocation and scope

Remove a member file to revoke that device. To prevent an issued proof from
being re-added, decode its first base64url segment and add the `id` to the
policy's `revoked` array. The ID is stable for that invitation, even across
repeated verification. Remove the invitation from the private server file and
restart the server. Commit/push the updated roster and policy, then have peers
pull and restart. Revocation is repository-distributed, not instantaneous.

Certificates attest to human presence at `verifiedAt`; they intentionally do
not expire automatically. Invitations expire after 24 hours and enrollment
sessions after at most 30 minutes. Reverification uses a new invitation. The
invitation is reusable until it expires, but is restricted to its predetermined
device key and handle. Sessions and completion responses live in server memory;
restart requires a new enrollment attempt. Do not run multiple server instances
without adding a shared session/rate-limit store. Per-process limits permit at
most three active sessions per invitation.

This adds human verification to device membership. It does not establish legal
identity, uniqueness, agent ownership records, or additional role permissions.
Existing project/terminal permissions remain the authorization layer. Persona
credentials stay on the membership server; peers receive only signed claims.
Persona Relay and Teamree's encrypted traffic relay are separate services.

## Verification

```powershell
npm run typecheck
npm test
npm run build
```

From the repository root, run the roster and peer regression tests:

```powershell
npm test -- src/main/teamwork/humanMembership.test.ts src/main/teamwork/roster.test.ts src/main/teamwork/teamworkService.test.ts src/main/teamwork/peer/peerLink.test.ts
```

The automated enrollment tests inject a fake Persona gateway to exercise pass,
fail, wrong claim, expiry and replay cases without collecting biometrics or
spending API credits. A real widget/API round trip requires your Persona account.

Integration references:
- https://docs.withpersona.com/relay-widget-usage
- https://docs.withpersona.com/relay-sdk-quickstart
