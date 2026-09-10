import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const mount = document.getElementById('root');
if (mount === null) throw new Error('index.html has no #root to mount on');

createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>
);
