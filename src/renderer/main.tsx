import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/app.css'
import './styles/skills.css'

const container = document.getElementById('root')
if (!container) throw new Error('Root container missing')

window.addEventListener('unhandledrejection', (event) => {
  console.error('Unhandled rejection in renderer:', event.reason)
})

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
