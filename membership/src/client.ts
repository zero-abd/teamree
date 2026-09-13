import Relay from '@persona/relay'
import './style.css'

const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
let session = ''
let moves: number[] = []
let widget: Relay | undefined
let result: { memberFile: string; handle: string } | undefined
let busy = false
async function api(path: string, body: unknown) {
  const response = await fetch(`/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}
async function action(run: () => Promise<void>) {
  if (busy) return
  busy = true
  element('status').textContent = 'Working…'
  try {
    await run()
    element('status').textContent = ''
  } catch (error) {
    element('status').textContent = error instanceof Error ? error.message : 'Please try again.'
    element('restart').hidden = false
  } finally {
    busy = false
  }
}
function panel(name: string) {
  for (const id of ['invite', 'game', 'persona', 'done']) element(`${id}-panel`).hidden = id !== name
  const heading = element(`${name}-panel`).querySelector('h2')!
  heading.tabIndex = -1
  heading.focus()
}
const fromLink = new URLSearchParams(location.hash.slice(1)).get('invite')
if (fromLink) {
  element<HTMLInputElement>('invite').value = fromLink
  history.replaceState(null, '', location.pathname)
}
element('invite-form').addEventListener('submit', (event) => {
  event.preventDefault()
  void action(async () => {
    const data = await api('start', { invite: element<HTMLInputElement>('invite').value.trim() })
    session = data.id
    moves = []
    element('route').textContent = data.sequence.map((index: number) => data.crew[index]).join(' → ')
    const crew = element('crew')
    crew.replaceChildren()
    data.crew.forEach((name: string, index: number) => {
      const button = document.createElement('button')
      button.className = 'crew-card'
      button.textContent = `${['✦', '▧', '❋', '◎'][index]} ${name}`
      button.addEventListener('click', () => {
        if (moves.length >= 4 || busy) return
        moves.push(index)
        element('progress').textContent =
          `${moves.length}/4 selected: ${moves.map((move) => data.crew[move]).join(' → ')}`
        element<HTMLButtonElement>('game-submit').disabled = moves.length !== 4
      })
      crew.append(button)
    })
    element('step1').classList.add('complete')
    element('progress').textContent = '0/4 selected'
    element<HTMLButtonElement>('game-submit').disabled = true
    panel('game')
  })
})
element('reset').onclick = () => {
  moves = []
  element('progress').textContent = '0/4 selected'
  element<HTMLButtonElement>('game-submit').disabled = true
}
element('game-submit').onclick = () =>
  void action(async () => {
    await api('game', { id: session, moves })
    const data = await api('persona', { id: session })
    element('step2').classList.add('complete')
    panel('persona')
    widget?.destroy()
    widget = new Relay('#relay-container', {
      accessToken: data.accessToken,
      theme: 'dark',
      onComplete: () => {
        void finish()
      },
      onExpire: () => {
        element('status').textContent = 'Verification expired. Start a new attempt.'
        element('restart').hidden = false
        widget?.destroy()
      },
      onError: () => {
        element('status').textContent = 'Persona could not finish. Retry or contact your team owner.'
        element('restart').hidden = false
      }
    })
  })
function finish() {
  return action(async () => {
    result = await api('finish', { id: session })
    widget?.destroy()
    element('step3').classList.add('complete')
    element('instructions').textContent =
      `Save the download as .teamree/members/${result!.handle}.pub in your repository, then commit it and submit it for approval.`
    element('restart').hidden = true
    panel('done')
  })
}
element('check').onclick = () => void finish()
element('restart').onclick = () => location.reload()
element('download').onclick = () => {
  if (!result) return
  const url = URL.createObjectURL(new Blob([result.memberFile], { type: 'text/plain' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${result.handle}.pub`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
window.addEventListener('pagehide', () => widget?.destroy())
