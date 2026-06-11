import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/bricolage-grotesque/600.css';
import '@fontsource/bricolage-grotesque/700.css';
import '@fontsource/instrument-sans/400.css';
import '@fontsource/instrument-sans/500.css';
import '@fontsource/instrument-sans/600.css';
import '@fontsource/spline-sans-mono/400.css';
import '@fontsource/spline-sans-mono/600.css';
import './styles/global.css';
import { App } from './App';
import { setToken } from './api/client';

// o setup/VS Code abre o portal com ?token=...; guardamos e limpamos a URL
const params = new URLSearchParams(window.location.search);
const token = params.get('token');
if (token) {
  setToken(token);
  params.delete('token');
  const query = params.toString();
  window.history.replaceState(
    null,
    '',
    window.location.pathname + (query ? `?${query}` : ''),
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
