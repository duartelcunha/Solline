import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_NAME } from '@solline/protocol/app';
import { App } from './app.tsx';
import './styles.css';

document.title = APP_NAME;

const root = document.getElementById('root');
if (!root) throw new Error('Falta o #root no index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
