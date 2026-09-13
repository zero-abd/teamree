// Public face of identity and membership. The runtime imports from here.

export { badHandle, rosterConflict, TeamworkError } from './errors'
export {
  createTeamworkHandlers,
  registerTeamworkHandlers,
  TEAMWORK_METHODS,
  type TeamworkHandlers,
  type TeamworkMethodName
} from './handlers'
export { MAX_HANDLE_LENGTH, resolveHandle, sanitiseHandle, type HandleSource } from './handle'
export { IDENTITY_FILE_NAME, loadIdentity, PRIVATE_KEY_MODE, publicKeyFromPrivatePem, type Identity } from './identity'
export {
  formatMemberFile,
  isPublicKey,
  KEY_ALGORITHM,
  MEMBER_FILE_SUFFIX,
  MEMBERS_DIR_SEGMENTS,
  parseMemberFile,
  type MemberFileContent,
  type MemberFileParse
} from './memberFile'
export { memberFileName, memberFilePath, membersDirectory, readRoster, type Roster, type RosterEntry } from './roster'
export { TeamworkService, type ProjectSource, type TeamworkServiceOptions } from './teamworkService'
