// Public face of the git and worktree service. The runtime imports from here.

export { GitCommandError, GitServiceError, describeError } from './errors'
export { createGitHandlers, registerGitHandlers, GIT_METHODS, type GitHandlers, type GitMethodName } from './handlers'
export {
  GitService,
  GitEventEmitter,
  type GitEvent,
  type GitEventListener,
  type GitServiceOptions,
  type GitSnapshot
} from './gitService'
export { createGitRunner, DEFAULT_TIMEOUT_MS, type GitOutput, type GitRun, type GitRunner } from './gitProcess'
export { MINIMUM_GIT_VERSION, parseGitVersion, isAtLeast, type GitVersion } from './gitVersion'
export { canonicalPath, isInside, pathKey, samePath } from './pathIdentity'
export { createMemoryRecordStore, type GitRecordStore } from './recordStore'
export { parseWorktreeList, readWorktreeInventory, type InventoryEntry } from './worktreeInventory'
export { allocateBranchName, allocateCheckoutPath, branchCollides, slugify } from './worktreeNaming'
export {
  cutToBytes,
  DEFAULT_CHANGE_LIMIT,
  DEFAULT_DIFF_CONTEXT_LINES,
  DEFAULT_DIFF_MAX_BYTES,
  parseChangeRecords,
  readWorktreeChanges,
  readWorktreeDiff,
  sortChanges
} from './worktreeChanges'
export { lacksWriteTree, parseMergeTree, readMergePreview } from './mergePreview'
export { commitWorktree } from './worktreeCommit'
export { parsePorcelainV2, readWorktreeStatus, type ParsedStatus } from './worktreeStatus'
export {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_SETTLE_MS,
  ignoresCheckoutChange,
  ignoresGitDirChange,
  resolveGitDir,
  WorktreeWatcher,
  type WatchFn,
  type WatchHandle,
  type WorktreeWatcherOptions
} from './worktreeWatcher'
export {
  DEFAULT_START_POINT_LIMIT,
  listStartPoints,
  resolveStartPoint,
  type ResolvedStartPoint,
  type StartPointAlternative,
  type StartPointKind,
  type StartPointList,
  type StartPointOption
} from './startPoint'
