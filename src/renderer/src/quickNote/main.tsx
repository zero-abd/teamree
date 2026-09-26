// The Quick Note panel's page, apart from the window's: no store, no panes, the window's colours.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { resolvePalette, type Appearance } from '@shared/theme'
import { applyPalette } from '../theme/applyPalette'
import { readSystemTone } from '../theme/systemTone'
import { QuickNote } from './QuickNote'
import '../styles/tokens.css'
import '../styles/base.css'
import '../styles/quickNote.css'

const container = document.getElementById('root')
if (!container) throw new Error('Quick Note root element is missing from quick-note.html')

void window.teamree.runtime.call('appearance.get', {}).then((response) => {
  if (response.ok)
    applyPalette(document.documentElement, resolvePalette(response.result as Appearance, readSystemTone()))
})

createRoot(container).render(
  <StrictMode>
    <QuickNote bridge={window.teamree.quickNote} />
  </StrictMode>
)
