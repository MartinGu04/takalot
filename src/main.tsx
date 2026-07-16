import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Theme: system preference by default, manual override persisted.
function applyTheme() {
  const stored = localStorage.getItem('takalot-theme'); // 'light' | 'dark' | null (auto)
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const dark = stored ? stored === 'dark' : systemDark;
  document.documentElement.classList.toggle('dark', dark);
}
applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
export { applyTheme };

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
