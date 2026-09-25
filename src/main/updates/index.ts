// Public face of the update check. The runtime imports from here.

export {
  GITHUB_API_ORIGIN,
  MAX_NOTES_CHARS,
  MAX_RESPONSE_BYTES,
  RELEASE_HOST,
  REQUEST_TIMEOUT_MS,
  UPDATE_REPOSITORY,
  isReleaseDownload,
  plainText,
  readLatestRelease,
  type DiskImage,
  type LatestRelease,
  type ReleaseChannel
} from './latestRelease'
export {
  UPDATE_METHODS,
  createUpdateHandlers,
  registerUpdateHandlers,
  type UpdateHandlers,
  type UpdateMethodName
} from './handlers'
export { ChecksumMismatch, downloadDiskImage, releaseHostPolicy, type HostPolicy } from './downloadInstaller'
export { bundleOf } from './bundleCheck'
export { SelfInstaller, type SelfInstall } from './selfInstaller'
export { compareVersions, isNewerRelease, isPrereleaseVersion, parseVersion, type Version } from './semver'
export {
  AUTOMATIC_CHECK_INTERVAL_MS,
  AUTOMATIC_CHECK_THROTTLE_MS,
  FOCUS_RECHECK_AFTER_MS,
  STARTUP_CHECK_DELAY_MS,
  UpdateService,
  type StoredUpdateSettings,
  type UpdateServiceOptions,
  type UpdateSettingsRecord
} from './updateService'
export { watchForWake, type WakeWatch } from './wakeWatch'
