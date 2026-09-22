import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

// AIDEV-NOTE: stamped by the build (`define` in vite.config.ts) from the ui package's own manifest,
// and read only here - so App is handed a version like any other value, and a test hands it one.
declare const PAGE_VERSION: string;

const mount = document.getElementById('root');
if (mount === null) throw new Error('index.html has no #root to mount on');

createRoot(mount).render(
  <StrictMode>
    <App pageVersion={PAGE_VERSION} />
  </StrictMode>,
);
