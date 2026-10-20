import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_NAME } from '@solline/protocol/app';
import { trackInputModality } from '@solline/ui/motion';
import { App } from './app.tsx';
import './styles.css';

document.title = APP_NAME;
// Ações de teclado não animam: o motion system precisa de saber de onde veio a última.
trackInputModality();

const root = document.getElementById('root');
if (!root) throw new Error('Falta o #root no index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
