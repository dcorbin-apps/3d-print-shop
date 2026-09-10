import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// AIDEV-NOTE: the shop's routes are proxied rather than reached across origins, so the browser makes
// same-origin requests in development exactly as it will when the shop serves these files itself.
// The API has no CORS handling and should not grow any to suit a dev server.
const SHOP = process.env.PRINT_SHOP_URL ?? 'http://localhost:7373';
const ITS_ROUTES = ['/jobs', '/printers', '/filaments'];

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(ITS_ROUTES.map((route) => [route, { target: SHOP, changeOrigin: false }])),
  },
});
