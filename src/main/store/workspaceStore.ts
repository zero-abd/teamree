// Durable workspace state: the projects a user tracks, the worktrees under them,
// and the pane layout per worktree. State is held in memory and mirrored to one
// JSON file; reads are synchronous because handlers answer from memory, and
// writes are coalesced so a burst of mutations costs one rename.

import type { Layout, Project, Worktree } from '../../shared/entities'
import { readJsonFile, writeJsonFileAtomically } from './atomicJsonFile'
import { emptyWorkspaceDocument, parseWorkspaceDocument, type WorkspaceDocument } from './workspaceDocument'

export type WorkspaceSnapshot = {
  projects: Project[]
  worktrees: Worktree[]
  layouts: Layout[]
}

export class WorkspaceStore {
  private readonly projects = new Map<string, Project>()
  private readonly worktrees = new Map<string, Worktree>()
  private readonly layouts = new Map<string, Layout>()

  private queue: Promise<void> = Promise.resolve()
  private queued = false
  private writeError: unknown

  private constructor(readonly filePath: string, document: WorkspaceDocument) {
    for (const project of document.projects) this.projects.set(project.id, project)
    for (const worktree of document.worktrees) this.worktrees.set(worktree.id, worktree)
    for (const layout of document.layouts) this.layouts.set(layout.worktreeId, layout)
  }

  /** Opens the file if it is readable, and starts empty if it is not. */
  static async open(filePath: string): Promise<WorkspaceStore> {
    const raw = await readJsonFile(filePath)
    const document = raw === undefined ? emptyWorkspaceDocument() : parseWorkspaceDocument(raw)
    return new WorkspaceStore(filePath, document)
  }

  listProjects(): Project[] {
    return [...this.projects.values()]
  }

  getProject(projectId: string): Project | undefined {
    return this.projects.get(projectId)
  }

  findProjectByPath(path: string): Project | undefined {
    for (const project of this.projects.values()) if (project.path === path) return project
    return undefined
  }

  putProject(project: Project): Project {
    this.projects.set(project.id, project)
    this.persist()
    return project
  }

  /** Removing a project takes its worktrees and their layouts with it. */
  removeProject(projectId: string): boolean {
    if (!this.projects.delete(projectId)) return false
    // Copied first: the loop deletes from the map it is walking.
    for (const worktree of [...this.worktrees.values()]) {
      if (worktree.projectId === projectId) {
        this.worktrees.delete(worktree.id)
        this.layouts.delete(worktree.id)
      }
    }
    this.persist()
    return true
  }

  listWorktrees(projectId?: string): Worktree[] {
    const all = [...this.worktrees.values()]
    return projectId === undefined ? all : all.filter((worktree) => worktree.projectId === projectId)
  }

  getWorktree(worktreeId: string): Worktree | undefined {
    return this.worktrees.get(worktreeId)
  }

  putWorktree(worktree: Worktree): Worktree {
    this.worktrees.set(worktree.id, worktree)
    this.persist()
    return worktree
  }

  removeWorktree(worktreeId: string): boolean {
    if (!this.worktrees.delete(worktreeId)) return false
    this.layouts.delete(worktreeId)
    this.persist()
    return true
  }

  getLayout(worktreeId: string): Layout | undefined {
    return this.layouts.get(worktreeId)
  }

  putLayout(layout: Layout): Layout {
    this.layouts.set(layout.worktreeId, layout)
    this.persist()
    return layout
  }

  snapshot(): WorkspaceSnapshot {
    return { projects: this.listProjects(), worktrees: this.listWorktrees(), layouts: [...this.layouts.values()] }
  }

  /** Waits for every scheduled write and surfaces the last write failure once. */
  async flush(): Promise<void> {
    let awaited: Promise<void>
    do {
      awaited = this.queue
      await awaited
    } while (awaited !== this.queue)

    const error = this.writeError
    if (error !== undefined) {
      this.writeError = undefined
      throw error
    }
  }

  private persist(): void {
    // One queued write already covers whatever mutations land before it runs.
    if (this.queued) return
    this.queued = true
    this.queue = this.queue.then(async () => {
      this.queued = false
      try {
        await writeJsonFileAtomically(this.filePath, this.document())
      } catch (error) {
        this.writeError = error
      }
    })
  }

  private document(): WorkspaceDocument {
    return { ...emptyWorkspaceDocument(), ...this.snapshot() }
  }
}
