import { describe, expect, it } from 'vitest'
import {
  carriesSelector,
  detectAgent,
  executableIndex,
  isUsableSessionId,
  newSessionId,
  pinSessionCommand,
  pinsOwnSessionId,
  quoteArgument,
  resumeSessionCommand,
  tokenizeCommand
} from './agent-command'

describe('tokenizeCommand', () => {
  it('splits on whitespace and records where each word sat', () => {
    const result = tokenizeCommand('claude --resume abc')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens).toEqual(['claude', '--resume', 'abc'])
    expect(result.spans[0]).toEqual({ start: 0, end: 6 })
    expect(result.spans[2]).toEqual({ start: 16, end: 19 })
  })

  it('reads quotes and escapes as one word', () => {
    const result = tokenizeCommand(`claude -p 'two words' "and more" one\\ more`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens).toEqual(['claude', '-p', 'two words', 'and more', 'one more'])
  })

  // Everything below is a command whose meaning depends on more than the words
  // in it. Cutting a token out of one could change what it runs, so it is not
  // modelled at all.
  it('refuses anything that is more than a list of words', () => {
    for (const command of [
      'claude | tee log.txt',
      'claude && echo done',
      'claude; echo done',
      'claude > out.txt',
      'claude $(cat prompt.txt)',
      'claude "$PROMPT"',
      'claude `cat x`',
      'claude $HOME',
      "claude 'unterminated",
      'claude trailing\\'
    ]) {
      expect(tokenizeCommand(command).ok, command).toBe(false)
    }
  })

  it('keeps a single-quoted dollar sign, which expands to nothing', () => {
    const result = tokenizeCommand(`claude -p 'costs $5'`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tokens[2]).toBe('costs $5')
  })
})

describe('executableIndex', () => {
  it('finds the program at the front', () => {
    expect(executableIndex(['claude', '--resume'], ['claude'])).toBe(0)
  })

  it('looks past environment assignments', () => {
    expect(executableIndex(['FOO=bar', 'BAZ=1', 'claude'], ['claude'])).toBe(2)
  })

  it('sees a path and a Windows extension as the same program', () => {
    expect(executableIndex(['/usr/local/bin/claude'], ['claude'])).toBe(0)
    expect(executableIndex(['C:\\tools\\claude.cmd'], ['claude'])).toBe(0)
  })

  // The trap: an argument can end in the program's name without being it.
  it('does not mistake an argument that merely ends in the name', () => {
    expect(executableIndex(['ssh', '-i', '~/.ssh/claude'], ['claude'])).toBe(-1)
    expect(executableIndex(['cd', '/work/claude'], ['claude'])).toBe(-1)
  })

  it('treats a word after a wrapper terminator as command position again', () => {
    expect(executableIndex(['npx', '--', 'claude'], ['claude'])).toBe(2)
  })
})

describe('detectAgent', () => {
  it('recognises the agents it knows', () => {
    expect(detectAgent('claude')).toBe('claude')
    expect(detectAgent('codex --model o3')).toBe('codex')
    expect(detectAgent('gemini')).toBe('gemini')
    expect(detectAgent('opencode')).toBe('opencode')
    expect(detectAgent('droid')).toBe('droid')
  })

  it('says nothing for an ordinary command', () => {
    expect(detectAgent('npm run dev')).toBeNull()
    expect(detectAgent('vim src/app.ts')).toBeNull()
  })

  it('says nothing for a command it cannot model', () => {
    expect(detectAgent('claude | tee log.txt')).toBeNull()
  })
})

describe('pinSessionCommand', () => {
  it('pins the id for an agent that lets the caller choose one', () => {
    expect(pinsOwnSessionId('claude')).toBe(true)
    expect(pinSessionCommand('claude', 'claude', 'abc-123')).toBe('claude --session-id abc-123')
  })

  it('leaves an agent that mints its own id alone', () => {
    expect(pinsOwnSessionId('codex')).toBe(false)
    expect(pinSessionCommand('codex', 'codex', 'abc-123')).toBe('codex')
  })

  it('keeps out of the way when the caller already named a session', () => {
    expect(pinSessionCommand('claude --resume mine', 'claude', 'abc-123')).toBe('claude --resume mine')
    expect(pinSessionCommand('claude --session-id mine', 'claude', 'abc-123')).toBe('claude --session-id mine')
  })

  it('refuses a session id that has no business on a command line', () => {
    expect(pinSessionCommand('claude', 'claude', '--not-an-id')).toBe('claude')
    expect(pinSessionCommand('claude', 'claude', 'has\nnewline')).toBe('claude')
    expect(pinSessionCommand('claude', 'claude', '')).toBe('claude')
  })

  it('keeps the rest of the command byte for byte', () => {
    const command = `claude --model  opus -p 'do the thing'`
    expect(pinSessionCommand(command, 'claude', 'abc')).toBe(`${command} --session-id abc`)
  })
})

describe('resumeSessionCommand', () => {
  it('resumes the id it was given', () => {
    expect(resumeSessionCommand('claude', 'claude', 'abc-123')).toBe('claude --resume abc-123')
    expect(resumeSessionCommand('codex', 'codex', 'abc-123')).toBe('codex resume abc-123')
    expect(resumeSessionCommand('opencode', 'opencode', 'abc-123')).toBe('opencode --session abc-123')
  })

  it('falls back to the latest session here when no id was ever captured', () => {
    expect(resumeSessionCommand('claude', 'claude', null)).toBe('claude --continue')
    expect(resumeSessionCommand('codex', 'codex', null)).toBe('codex resume --last')
  })

  it('says so rather than guessing when the agent offers no way back', () => {
    expect(resumeSessionCommand('gemini', 'gemini', null)).toBeNull()
  })

  // The defect this guards: a stored command that already carried a selector
  // would end up with two, and which one won was the CLI's business, not ours.
  it('replaces a stale selector rather than competing with it', () => {
    expect(resumeSessionCommand('claude --resume old-id', 'claude', 'new-id')).toBe('claude --resume new-id')
    expect(resumeSessionCommand('claude --continue', 'claude', 'new-id')).toBe('claude --resume new-id')
    expect(resumeSessionCommand('claude --session-id old-id', 'claude', 'new-id')).toBe('claude --resume new-id')
  })

  it('takes the joined form of a selector with it', () => {
    expect(resumeSessionCommand('claude --resume=old-id', 'claude', 'new-id')).toBe('claude --resume new-id')
  })

  it('keeps every other flag, and the spacing around them', () => {
    expect(resumeSessionCommand('claude --model opus --resume old -p go', 'claude', 'new')).toBe(
      'claude --model opus -p go --resume new'
    )
  })

  it('leaves a selector-shaped value belonging to another flag alone', () => {
    // `--resume` here is the value of --model, not a selector of its own... but
    // a flag's dash-leading value is exactly what the joined short form would
    // be ambiguous with, so the conservative rule is what is tested: a bare
    // `-rSOMETHING` is never treated as a selector.
    expect(resumeSessionCommand('claude -rABC', 'claude', 'new')).toBe('claude -rABC --resume new')
  })

  it('puts the selector before the agent’s own argument terminator', () => {
    expect(resumeSessionCommand('claude --model opus -- some prompt', 'claude', 'new')).toBe(
      'claude --model opus --resume new -- some prompt'
    )
  })

  it('appends rather than splicing when the command cannot be modelled', () => {
    expect(resumeSessionCommand('claude | tee log.txt', 'claude', 'new')).toBe('claude | tee log.txt --resume new')
  })

  it('appends when the agent is not in command position at all', () => {
    // Nothing here is safe to edit, so the fallback is the old behaviour.
    expect(resumeSessionCommand('ssh host claude', 'claude', 'new')).toBe('ssh host claude --resume new')
  })

  it('quotes an id that would otherwise break the line', () => {
    expect(resumeSessionCommand('claude', 'claude', "we'ird id")).toBe(`claude --resume 'we'\\''ird id'`)
  })
})

describe('isUsableSessionId', () => {
  it('accepts what an agent actually hands out', () => {
    expect(isUsableSessionId(newSessionId())).toBe(true)
    expect(isUsableSessionId('7c5dcf5d')).toBe(true)
  })

  it('rejects anything that would read as a flag, a break, or a novel', () => {
    expect(isUsableSessionId('')).toBe(false)
    expect(isUsableSessionId('-r')).toBe(false)
    expect(isUsableSessionId('a\nb')).toBe(false)
    expect(isUsableSessionId('a\u0000b')).toBe(false)
    expect(isUsableSessionId('x'.repeat(513))).toBe(false)
  })
})

describe('carriesSelector', () => {
  it('knows whether a session is already named', () => {
    expect(carriesSelector('claude --resume abc', 'claude')).toBe(true)
    expect(carriesSelector('claude --model opus', 'claude')).toBe(false)
  })
})

describe('quoteArgument', () => {
  it('leaves a plain word alone', () => {
    expect(quoteArgument('abc-123')).toBe('abc-123')
  })

  it('quotes a space, and escapes a quote inside one', () => {
    expect(quoteArgument('two words')).toBe(`'two words'`)
    expect(quoteArgument("it's")).toBe(`'it'\\''s'`)
  })
})
