import { describe, expect, it } from 'vitest'
import { pullRequestSteps, runPullRequestSteps, type PullRequestStep } from './pullRequestSteps'

describe('the steps a pull request needs', () => {
  it('commits, pushes and creates from a dirty tree', () => {
    expect(pullRequestSteps({ uncommitted: 2, published: true, ahead: 0 })).toEqual(['commit', 'push', 'create'])
    expect(pullRequestSteps({ uncommitted: 1, published: false, ahead: 0 })).toEqual(['commit', 'push', 'create'])
  })

  it('publishes a clean branch the host has not seen, and pushes one it has seen less of', () => {
    expect(pullRequestSteps({ uncommitted: 0, published: false, ahead: 1 })).toEqual(['push', 'create'])
    expect(pullRequestSteps({ uncommitted: 0, published: true, ahead: 2 })).toEqual(['push', 'create'])
  })

  it('only creates once the host has every commit', () => {
    expect(pullRequestSteps({ uncommitted: 0, published: true, ahead: 0 })).toEqual(['create'])
  })
})

describe('running the steps', () => {
  const recorder = (failAt: PullRequestStep[] = []) => {
    const ran: PullRequestStep[] = []
    const started: PullRequestStep[] = []
    return {
      ran,
      started,
      run: async (step: PullRequestStep): Promise<void> => {
        ran.push(step)
        const index = failAt.indexOf(step)
        if (index !== -1) {
          failAt.splice(index, 1)
          throw new Error(`${step} refused`)
        }
      },
      onStart: (step: PullRequestStep): void => {
        started.push(step)
      }
    }
  }

  it('runs each step in order and reports each as it starts', async () => {
    const steps = recorder()
    expect(await runPullRequestSteps(['commit', 'push', 'create'], steps.run, steps.onStart)).toBeNull()
    expect(steps.ran).toEqual(['commit', 'push', 'create'])
    expect(steps.started).toEqual(['commit', 'push', 'create'])
  })

  it('stops at the step that fails, with its reason, and resumes from that step', async () => {
    const steps = recorder(['push'])
    const plan: PullRequestStep[] = ['commit', 'push', 'create']
    const failure = await runPullRequestSteps(plan, steps.run, steps.onStart)
    expect(failure).toEqual({ step: 'push', reason: 'push refused' })
    expect(steps.ran).toEqual(['commit', 'push'])

    expect(await runPullRequestSteps(plan, steps.run, steps.onStart, failure?.step)).toBeNull()
    expect(steps.ran).toEqual(['commit', 'push', 'push', 'create'])
  })

  it('keeps the first line of a failure as its reason', async () => {
    const failure = await runPullRequestSteps(['create'], async () => {
      throw new Error('gh: no permission\n\nsee the docs')
    })
    expect(failure).toEqual({ step: 'create', reason: 'gh: no permission' })
  })
})
