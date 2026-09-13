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

import { mkdir, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { MemberIdentity, MemberList, Project } from '../../shared/entities'
import type { ParamsOf } from '../../shared/methods'
import { createGitRunner, type GitRunner } from '../git/gitProcess'
import { notFound } from '../runtime/runtimeError'
import { badHandle, rosterConflict } from './errors'
import { resolveHandle } from './handle'
import { loadIdentity } from './identity'
import { readHumanPolicy } from './humanMembership'
import { formatMemberFile } from './memberFile'
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
   * Called once the roster on disk has changed, so the workspace stream can say
   * so. Attached to the service rather than to a transport, which is what lets
   * a window notice a join made from anywhere else.
   */
  onRosterChange?: () => void
}

export class TeamworkService {
  readonly #store: ProjectSource
  readonly #dataDir: string
  readonly #runner: GitRunner
  readonly #now: () => number
  readonly #onRosterChange: (() => void) | undefined

  constructor(options: TeamworkServiceOptions) {
    this.#store = options.store
    this.#dataDir = options.dataDir
    this.#runner = options.runner ?? createGitRunner()
    this.#now = options.now ?? Date.now
    this.#onRosterChange = options.onRosterChange
  }

  async listMembers(params: ParamsOf<'members.list'>): Promise<MemberList> {
    const project = this.#project(params.projectId)
    return this.#describe(project, await readRoster(project.path))
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

    if (await readHumanPolicy(project.path)) {
      throw new Error(
        'This team requires human verification. Ask the owner for an invitation, complete the crew game and Persona check, then save the signed member file in .teamree/members/. Your device public key is available in Members.'
      )
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
    this.#onRosterChange?.()

    // Re-read rather than splicing the new entry in: what the caller gets back
    // is then what the next reader of the directory will see, including a
    // problem if the file did not land the way it was written.
    return this.#describe(project, await readRoster(project.path), identity)
  }

  #project(projectId: string): Project {
    const project = this.#store.getProject(projectId)
    if (!project) throw notFound(`no project with id ${projectId}`)
    return project
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

/** UTC, so two members added on the same day agree about which day that was. */
function isoDate(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}
