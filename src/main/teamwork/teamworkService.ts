// Identity and membership for a project.
//
// The entire trust model is here and it is deliberately small: a keypair per
// installation, the public half committed to the repository, and no second list
// anywhere. Push access is membership. There are no invitations, no accounts,
// and nothing to administer, because every one of those would be a thing that
// can disagree with the repository.
//
// Joining writes a file and stops. It does not stage it, commit it or push it —
// not because that would be hard, but because doing it for someone would hide
// the only step that means anything. A key nobody could push is not membership,
// and a key this app pushed on your behalf is a claim you never made.
//
// The relay is here for the same reason and on the same terms. It is the other
// fact a team has to agree on, it lives in the same directory, and setting it
// writes `.teamree/relay` and stops — so the two of them are one commit rather
// than one button and one heredoc.

import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemberIdentity, MemberList, Project, RelaySetting } from '../../shared/entities'
import type { ParamsOf } from '../../shared/methods'
import { createGitRunner, type GitRunner } from '../git/gitProcess'
import { notFound } from '../runtime/runtimeError'
import { badHandle, badRelayUrl, rosterConflict } from './errors'
import { resolveHandle } from './handle'
import { loadIdentity } from './identity'
import { formatMemberFile } from './memberFile'
import {
  parseRelayUrl,
  readRelayFile,
  RELAY_FILE_NAME,
  RELAY_URL_ENV,
  relayOverride,
  writeRelayFile
} from './peer/relayUrl'
import { memberFileName, memberFilePath, readRoster, type Roster } from './roster'

/** Only the sliver of the workspace store this needs, so a test can hand it one project. */
export type ProjectSource = { getProject: (projectId: string) => Project | undefined }

export type TeamworkServiceOptions = {
  store: ProjectSource
  /**
   * The app's own data directory — where the private key goes. It is passed in
   * rather than worked out here so nothing in this module can be tempted to put
   * a secret somewhere relative to a repository.
   */
  dataDir: string
  runner?: GitRunner
  now?: () => number
  /**
   * The environment the relay override is read from. Passed in rather than
   * reached for so a test can say what this process can see.
   */
  env?: NodeJS.ProcessEnv
  /**
   * Whether this project's `.teamree` is being watched, so a roster read can
   * say whether it will stay true by itself. Absent means nothing is watching,
   * which is what a service built without a watcher should claim.
   */
  watching?: (projectId: string) => boolean
  /**
   * Called once what is in `.teamree` has changed, so the workspace stream can
   * say so. Attached to the service rather than to a transport, which is what
   * lets a window notice a join made from anywhere else.
   */
  onRosterChange?: () => void
}

export class TeamworkService {
  readonly #store: ProjectSource
  readonly #dataDir: string
  readonly #runner: GitRunner
  readonly #now: () => number
  readonly #env: NodeJS.ProcessEnv
  readonly #watching: (projectId: string) => boolean
  readonly #onRosterChange: (() => void) | undefined
  /**
   * What the roster looked like the last time this service read one, per
   * project.
   *
   * Kept so that *any* read can be the thing that notices a change — opening
   * the Start teamwork panel after a pull, as much as a watch firing. It is only ever
   * compared, never served: a reader gets what is on disk now.
   */
  readonly #lastRoster = new Map<string, string>()

  constructor(options: TeamworkServiceOptions) {
    this.#store = options.store
    this.#dataDir = options.dataDir
    this.#runner = options.runner ?? createGitRunner()
    this.#now = options.now ?? Date.now
    this.#env = options.env ?? process.env
    this.#watching = options.watching ?? ((): boolean => false)
    this.#onRosterChange = options.onRosterChange
  }

  async listMembers(params: ParamsOf<'members.list'>): Promise<MemberList> {
    const project = this.#project(params.projectId)
    const roster = await readRoster(project.path)
    // Belt and braces beside the watch on `.teamree`: a dialog opening is
    // itself a read, and a read that finds the directory has moved is worth
    // announcing however it came to happen. Only a *change* is announced, so
    // the re-read this causes elsewhere finds the same roster and stops.
    this.#noteRoster(project.id, roster)
    return this.#describe(project, roster)
  }

  async joinProject(params: ParamsOf<'members.join'>): Promise<MemberList> {
    const project = this.#project(params.projectId)
    const identity = await loadIdentity(this.#dataDir)
    const roster = await readRoster(project.path)

    // Already in, possibly under a handle chosen on another machine. Joining
    // twice is something a user will do — the button is there until the file is
    // committed — and writing a second file for one key would be the duplicate
    // the reader refuses.
    if (roster.entries.some((entry) => entry.publicKey === identity.publicKey)) {
      return this.#describe(project, roster, identity)
    }

    const handle = resolveHandle({ override: params.handle, gitEmail: await this.#gitEmail(project.path) })
    if (handle === undefined) {
      throw badHandle(
        params.handle === undefined
          ? `git has no user.email configured in ${project.path}, so there is no name to file your key under; choose a handle`
          : `"${params.handle}" has nothing usable as a file name in it; choose another handle`
      )
    }

    const taken = roster.entries.find((entry) => entry.handle === handle)
    if (taken) {
      throw rosterConflict(`${taken.file} is already somebody else's key; choose another handle`)
    }

    await this.#writeMemberFile(project.path, {
      handle,
      publicKey: identity.publicKey,
      addedAt: isoDate(this.#now())
    })

    // Re-read rather than splicing the new entry in: what the caller gets back
    // is then what the next reader of the directory will see, including a
    // problem if the file did not land the way it was written.
    const written = await readRoster(project.path)
    // Recorded and then announced, rather than announced *because* it changed:
    // a join is this app writing the file, and it says so whether or not
    // anything had read the directory before.
    this.#lastRoster.set(project.id, fingerprint(written))
    this.#onRosterChange?.()
    return this.#describe(project, written, identity)
  }

  /**
   * Where this project's relay is recorded, and what each of the two places
   * said — including the environment when it said nothing at all.
   */
  async readRelay(params: ParamsOf<'teamwork.relay'>): Promise<RelaySetting> {
    return this.#describeRelay(this.#project(params.projectId))
  }

  /**
   * Writes the relay into the repository, beside the member keys.
   *
   * The one team-wide fact with no button until now: the URL is a file whose
   * format somebody had to infer from a README, so the app's own template was
   * exported and called by nothing. Writing it here is the same bargain as
   * joining — the app writes the file and stops, because pushing it is what
   * makes it the team's.
   */
  async setRelay(params: ParamsOf<'teamwork.setRelay'>): Promise<RelaySetting> {
    const project = this.#project(params.projectId)
    const parsed = parseRelayUrl(params.url)
    if (!parsed.ok) throw badRelayUrl(`that is not a relay URL: ${parsed.reason}`)

    await writeRelayFile(project.path, parsed.url)
    // Said rather than left to the watch: the watch may be degraded, and the
    // links have to be rebuilt against a relay that moved either way.
    this.#onRosterChange?.()
    return this.#describeRelay(project)
  }

  #project(projectId: string): Project {
    const project = this.#store.getProject(projectId)
    if (!project) throw notFound(`no project with id ${projectId}`)
    return project
  }

  /** Announces a roster that is not the one this service last saw, and only that. */
  #noteRoster(projectId: string, roster: Roster): void {
    const seen = this.#lastRoster.get(projectId)
    const now = fingerprint(roster)
    this.#lastRoster.set(projectId, now)
    if (seen === undefined || seen === now) return
    this.#onRosterChange?.()
  }

  async #describeRelay(project: Project): Promise<RelaySetting> {
    const file = await readRelayFile(project.path)
    const override = relayOverride(this.#env)
    const onDisk = { url: file.ok ? file.url : null, problem: file.ok ? null : file.reason }

    const effective = ((): Pick<RelaySetting, 'url' | 'source' | 'problem'> => {
      if (override === null) {
        return file.ok
          ? { url: file.url, source: 'repository', problem: null }
          : { url: null, source: null, problem: file.reason }
      }
      const parsed = parseRelayUrl(override)
      return parsed.ok
        ? { url: parsed.url, source: 'environment', problem: null }
        : { url: null, source: null, problem: `${RELAY_URL_ENV} is not a relay URL: ${parsed.reason}` }
    })()

    return {
      projectId: project.id,
      file: RELAY_FILE_NAME,
      ...effective,
      onDisk,
      override: { name: RELAY_URL_ENV, value: override },
      readAt: this.#now()
    }
  }

  async #describe(project: Project, roster: Roster, known?: { publicKey: string }): Promise<MemberList> {
    const identity = known ?? (await loadIdentity(this.#dataDir))
    const mine = roster.entries.find((entry) => entry.publicKey === identity.publicKey)
    // The handle the roster already files this key under wins over anything
    // that could be derived: a member who renamed their file did so on purpose,
    // and the app calling them something else would be arguing with the commit.
    const handle = mine?.handle ?? resolveHandle({ gitEmail: await this.#gitEmail(project.path) }) ?? null

    const self: MemberIdentity = { handle, publicKey: identity.publicKey }
    return {
      projectId: project.id,
      members: roster.entries.map((entry) => ({
        handle: entry.handle,
        publicKey: entry.publicKey,
        addedAt: entry.addedAt,
        file: entry.file,
        isSelf: entry.publicKey === identity.publicKey
      })),
      problems: roster.problems,
      self,
      selfFile: handle === null ? null : memberFileName(handle),
      enrolled: mine !== undefined,
      watched: this.#watching(project.id),
      readAt: this.#now()
    }
  }

  /** Exclusive, so a join can never overwrite a key already in the repository. */
  async #writeMemberFile(projectPath: string, content: Parameters<typeof formatMemberFile>[0]): Promise<void> {
    const target = memberFilePath(projectPath, content.handle)
    await mkdir(dirname(target), { recursive: true })
    try {
      const file = await open(target, 'wx')
      try {
        await file.writeFile(formatMemberFile(content), 'utf8')
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // The roster read said this key is not in the list, and yet the file is
      // there — so it is a file teamree cannot read, and rewriting it would
      // throw away whatever it actually is.
      throw rosterConflict(
        `${memberFileName(content.handle)} already exists but teamree could not read it as a member; look at it before replacing it`
      )
    }
  }

  /** Undefined when git has no answer, which is ordinary on a fresh machine. */
  async #gitEmail(cwd: string): Promise<string | undefined> {
    try {
      const { exitCode, stdout } = await this.#runner.tryRun({
        args: ['config', '--get', 'user.email'],
        cwd,
        readOnly: true
      })
      if (exitCode !== 0) return undefined
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }
}

/**
 * Enough of a roster to tell two reads of it apart.
 *
 * The problems are in it as well as the members: a file that stopped being
 * readable is a member who has left the list, and that has to reach the rest of
 * the app the same way an added one does.
 */
function fingerprint(roster: Roster): string {
  return JSON.stringify([
    roster.entries.map((entry) => [entry.file, entry.publicKey, entry.addedAt]),
    roster.problems.map((problem) => [problem.file, problem.reason])
  ])
}

/** UTC, so two members added on the same day agree about which day that was. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
