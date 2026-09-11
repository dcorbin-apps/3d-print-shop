import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { SHOP_ROUTES } from '@3d-print-shop/client/browser';

// AIDEV-NOTE: the shop's routes are proxied rather than reached across origins, so the browser makes
// same-origin requests in development exactly as it will when the shop serves these files itself.
// The API has no CORS handling and should not grow any to suit a dev server.
//
// The list is the CLIENT's, not this file's. Kept here it went stale the moment a route was added,
// and what that looks like is Vite answering with index.html and the page saying "unexpected
// character at line 1 column 1" - which names neither the route nor the reason.
const SHOP = process.env.PRINT_SHOP_URL ?? 'http://localhost:7373';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(SHOP_ROUTES.map((route) => [route, { target: SHOP, changeOrigin: false }])),
  },
});
