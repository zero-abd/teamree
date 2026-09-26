import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  claudeTempRoot,
  createPastedImageFinder,
  descendants,
  imageFileFor,
  sessionOfPidFile,
  type PastedImageDeps
} from './pasted-images'

const ROOT = '/tmp/claude-501'
const HOME = '/Users/me'
const SESSIONS = `${HOME}/.claude/sessions`
const OLD = '11111111-1111-1111-1111-111111111111'
const NEW = '22222222-2222-2222-2222-222222222222'

/** A disk of directories and files, by absolute path. */
function disk(files: Record<string, string>): Pick<PastedImageDeps, 'readText' | 'list' | 'mtime'> {
  const has = (file: string): boolean => Object.hasOwn(files, file)
  return {
    readText: async (file) => {
      if (!has(file)) throw new Error('ENOENT')
      return files[file] as string
    },
    list: async (directory) => {
      const names = new Set<string>()
      for (const file of Object.keys(files)) {
        if (file.startsWith(`${directory}/`)) names.add(file.slice(directory.length + 1).split('/')[0] as string)
      }
      if (names.size === 0) throw new Error('ENOENT')
      return [...names]
    },
    mtime: async (file) => (has(file) ? 1000 : null)
  }
}

const PS = [
  '  PID  PPID  %CPU    RSS COMM',
  '  500     1   0.0   1000 /bin/zsh',
  '  501   500   1.0   9000 claude',
  '  900     1   0.0   1000 claude'
].join('\n')

function finder(files: Record<string, string>, pane: ReturnType<PastedImageDeps['pane']>, ps = PS) {
  return createPastedImageFinder({
    pane: () => pane,
    ps: async () => ps,
    grant: (file, version) =>
      `teamree-file://grant/${path.basename(file.absolute)}?root=${file.root}&v=${version}&m=${file.mime}`,
    ...disk(files),
    env: {},
    home: HOME,
    uid: 501
  })
}

describe('claudeTempRoot', () => {
  it('is /tmp/claude-<uid>, or under CLAUDE_CODE_TMPDIR', () => {
    expect(claudeTempRoot({}, 501)).toBe('/tmp/claude-501')
    expect(claudeTempRoot({ CLAUDE_CODE_TMPDIR: '/var/x' }, 501)).toBe('/var/x/claude-501')
    expect(claudeTempRoot({}, null)).toBeNull()
  })
})

describe('descendants', () => {
  it('walks the tree under a pid, nearest first, and nothing beside it', () => {
    const table = [
      { pid: 2, ppid: 1 },
      { pid: 3, ppid: 2 },
      { pid: 4, ppid: 3 },
      { pid: 9, ppid: 1 }
    ]
    expect(descendants(2, table)).toEqual([2, 3, 4])
  })
})

describe('sessionOfPidFile', () => {
  it('reads the session id when the file is that pid’s', () => {
    expect(sessionOfPidFile(JSON.stringify({ pid: 7, sessionId: NEW }), 7)).toBe(NEW)
  })

  it('refuses another pid, a path-shaped id and a torn file', () => {
    expect(sessionOfPidFile(JSON.stringify({ pid: 8, sessionId: NEW }), 7)).toBeNull()
    expect(sessionOfPidFile(JSON.stringify({ pid: 7, sessionId: '../x' }), 7)).toBeNull()
    expect(sessionOfPidFile('{"pid":7,', 7)).toBeNull()
  })
})

describe('imageFileFor', () => {
  it('matches the number exactly, with any image extension', () => {
    expect(imageFileFor(2, ['1.png', '12.png', '2.webp'])).toEqual({ name: '2.webp', mime: 'image/webp' })
    expect(imageFileFor(3, ['3.jpeg'])).toEqual({ name: '3.jpeg', mime: 'image/jpeg' })
  })

  it('ignores what is not an image or not that number', () => {
    expect(imageFileFor(2, ['2.png.tmp.1', '2.txt', '02x.png', '20.png'])).toBeNull()
  })
})

describe('createPastedImageFinder', () => {
  const image = (session: string, name: string): string => `${ROOT}/-Users-me-app/${session}/images/${name}`

  it('finds the image under the session the pane’s Claude Code is on now', async () => {
    const find = finder(
      {
        [`${SESSIONS}/501.json`]: JSON.stringify({ pid: 501, sessionId: NEW }),
        [image(OLD, '2.png')]: 'old',
        [image(NEW, '2.png')]: 'new'
      },
      { pid: 500, pinnedSessionId: OLD }
    )
    const found = await find('t1', 2)
    expect(found?.path).toBe(image(NEW, '2.png'))
    expect(found?.url).toContain(`root=${ROOT}/-Users-me-app/${NEW}/images`)
    expect(found?.url).toContain('m=image/png')
  })

  it('reads no session file of a process outside the pane', async () => {
    const find = finder(
      { [`${SESSIONS}/900.json`]: JSON.stringify({ pid: 900, sessionId: NEW }), [image(NEW, '1.png')]: 'x' },
      { pid: 500 }
    )
    expect(await find('t1', 1)).toBeNull()
  })

  it('falls back to the pinned session once Claude Code has exited', async () => {
    const find = finder({ [image(OLD, '1.png')]: 'x' }, { pinnedSessionId: OLD })
    expect((await find('t1', 1))?.path).toBe(image(OLD, '1.png'))
  })

  it('remembers the last live session over the pinned one', async () => {
    const files: Record<string, string> = {
      [`${SESSIONS}/501.json`]: JSON.stringify({ pid: 501, sessionId: NEW }),
      [image(OLD, '1.png')]: 'old',
      [image(NEW, '1.png')]: 'new'
    }
    let pane: { pid?: number; pinnedSessionId?: string } = { pid: 500, pinnedSessionId: OLD }
    const find = createPastedImageFinder({
      pane: () => pane,
      ps: async () => PS,
      grant: () => 'url',
      ...disk(files),
      env: {},
      home: HOME,
      uid: 501
    })
    expect((await find('t1', 1))?.path).toBe(image(NEW, '1.png'))
    pane = { pinnedSessionId: OLD }
    expect((await find('t1', 1))?.path).toBe(image(NEW, '1.png'))
  })

  it('answers null for a missing file, directory, pane or session', async () => {
    const files = { [image(OLD, '1.png')]: 'x' }
    expect(await finder(files, { pinnedSessionId: OLD })('t1', 2)).toBeNull()
    expect(await finder(files, { pinnedSessionId: NEW })('t1', 1)).toBeNull()
    expect(await finder(files, undefined)('t1', 1)).toBeNull()
    expect(await finder(files, {})('t1', 1)).toBeNull()
    expect(await finder({}, { pinnedSessionId: OLD })('t1', 1)).toBeNull()
  })

  it('answers null where there is no ps', async () => {
    const find = createPastedImageFinder({
      pane: () => ({ pid: 500 }),
      ps: async () => {
        throw new Error('no ps')
      },
      grant: () => 'url',
      ...disk({ [image(NEW, '1.png')]: 'x' }),
      env: {},
      home: HOME,
      uid: 501
    })
    expect(await find('t1', 1)).toBeNull()
  })
})
