import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { RegionBoundary } from './errors/RegionBoundary'
import { watchWindowErrors } from './errors/windowErrors'
import './styles/index.css'

watchWindowErrors(window, (details) => window.teamree?.errors?.report(details))

const container = document.getElementById('root')
if (!container) throw new Error('Renderer root element is missing from index.html')

createRoot(container).render(
  <StrictMode>
    <RegionBoundary region="window">
      <App />
    </RegionBoundary>
  </StrictMode>
)
