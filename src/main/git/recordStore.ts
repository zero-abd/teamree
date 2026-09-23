// Where project and worktree records live: the subset of WorkspaceStore that
// deals in projects and worktrees, so the runtime hands its own store in.
// Without one, an in-memory store is used, which is what the tests run against.

import type { Project, Worktree } from '../../shared/entities'

export type GitRecordStore = {
  listProjects(): Project[]
  getProject(projectId: string): Project | undefined
  putProject(project: Project): unknown
  removeProject(projectId: string): unknown
  listWorktrees(projectId?: string): Worktree[]
  getWorktree(worktreeId: string): Worktree | undefined
  putWorktree(worktree: Worktree): unknown
  removeWorktree(worktreeId: string): unknown
}

export function createMemoryRecordStore(): GitRecordStore {
  const projects = new Map<string, Project>()
  const worktrees = new Map<string, Worktree>()

  return {
    listProjects: () => [...projects.values()],
    getProject: (projectId) => projects.get(projectId),
    putProject: (project) => projects.set(project.id, project),
    removeProject: (projectId) => {
      projects.delete(projectId)
      const doomed: string[] = []
      for (const worktree of worktrees.values()) {
        if (worktree.projectId === projectId) doomed.push(worktree.id)
      }
      for (const worktreeId of doomed) worktrees.delete(worktreeId)
    },
    listWorktrees: (projectId) => {
      const all = [...worktrees.values()]
      return projectId === undefined ? all : all.filter((worktree) => worktree.projectId === projectId)
    },
    getWorktree: (worktreeId) => worktrees.get(worktreeId),
    putWorktree: (worktree) => worktrees.set(worktree.id, worktree),
    removeWorktree: (worktreeId) => worktrees.delete(worktreeId)
  }
}
