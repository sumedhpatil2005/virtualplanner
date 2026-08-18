window.addEventListener('error', (event) => {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `
      <div style="padding: 20px; color: #ef4444; background: #111827; border: 2px solid #ef4444; border-radius: 8px; font-family: monospace; text-align: left; max-width: 90%; margin: 20px auto; overflow: auto; z-index: 99999; position: relative;">
        <h2 style="margin-top: 0; color: #f87171;">Runtime Error</h2>
        <p><strong>Message:</strong> ${event.message}</p>
        <p><strong>File:</strong> ${event.filename}:${event.lineno}:${event.colno}</p>
        <pre style="background: #1f2937; padding: 10px; border-radius: 4px; color: #f3f4f6; overflow-x: auto;">${event.error?.stack || 'No stack trace'}</pre>
      </div>
    `;
  }
});

window.addEventListener('unhandledrejection', (event) => {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = `
      <div style="padding: 20px; color: #ef4444; background: #111827; border: 2px solid #ef4444; border-radius: 8px; font-family: monospace; text-align: left; max-width: 90%; margin: 20px auto; overflow: auto; z-index: 99999; position: relative;">
        <h2 style="margin-top: 0; color: #f87171;">Unhandled Promise Rejection</h2>
        <p><strong>Reason:</strong> ${event.reason?.message || event.reason}</p>
        <pre style="background: #1f2937; padding: 10px; border-radius: 4px; color: #f3f4f6; overflow-x: auto;">${event.reason?.stack || 'No stack trace'}</pre>
      </div>
    `;
  }
});

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
