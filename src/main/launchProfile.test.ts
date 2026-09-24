import { describe, expect, it } from 'vitest'
import {
  frontsExistingWindow,
  isBackgroundLaunch,
  launchData,
  leaveKeychainAlone,
  userDataOverride
} from './launchProfile'

describe('userDataOverride', () => {
  it('keeps the default profile when the variable is unset or empty', () => {
    expect(userDataOverride({}, '/work')).toBeUndefined()
    expect(userDataOverride({ TEAMREE_USER_DATA_DIR: '' }, '/work')).toBeUndefined()
  })

  it('returns the named profile as an absolute path', () => {
    expect(userDataOverride({ TEAMREE_USER_DATA_DIR: '/tmp/profile' }, '/work')).toBe('/tmp/profile')
    expect(userDataOverride({ TEAMREE_USER_DATA_DIR: 'scratch/profile' }, '/work')).toBe('/work/scratch/profile')
  })
})

describe('leaveKeychainAlone', () => {
  it('mocks the keychain and drops NODE_USE_SYSTEM_CA for a throwaway profile', () => {
    const env: NodeJS.ProcessEnv = { TEAMREE_USER_DATA_DIR: '/tmp/profile', NODE_USE_SYSTEM_CA: '1' }
    expect(leaveKeychainAlone(env)).toEqual(['use-mock-keychain'])
    expect(env).not.toHaveProperty('NODE_USE_SYSTEM_CA')
  })

  it("changes nothing for the owner's own launch", () => {
    for (const dir of [undefined, '']) {
      const env: NodeJS.ProcessEnv = { TEAMREE_USER_DATA_DIR: dir, NODE_USE_SYSTEM_CA: '1' }
      expect(leaveKeychainAlone(env)).toEqual([])
      expect(env['NODE_USE_SYSTEM_CA']).toBe('1')
    }
  })
})

describe('isBackgroundLaunch', () => {
  it('is set only by TEAMREE_BACKGROUND_LAUNCH=1', () => {
    expect(isBackgroundLaunch({ TEAMREE_BACKGROUND_LAUNCH: '1' })).toBe(true)
    expect(isBackgroundLaunch({ TEAMREE_BACKGROUND_LAUNCH: '0' })).toBe(false)
    expect(isBackgroundLaunch({})).toBe(false)
  })
})

describe('frontsExistingWindow', () => {
  it('fronts the window for an ordinary second launch', () => {
    expect(frontsExistingWindow({}, launchData({}))).toBe(true)
    expect(frontsExistingWindow({}, undefined)).toBe(true)
  })

  it('never fronts it when the second launch was a background one', () => {
    expect(frontsExistingWindow({}, launchData({ TEAMREE_BACKGROUND_LAUNCH: '1' }))).toBe(false)
  })

  it('never fronts it when this instance is itself a background one', () => {
    expect(frontsExistingWindow({ TEAMREE_BACKGROUND_LAUNCH: '1' }, launchData({}))).toBe(false)
  })
})
