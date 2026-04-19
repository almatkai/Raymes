import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import 'highlight.js/styles/atom-one-dark.css'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
