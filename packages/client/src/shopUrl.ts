// AIDEV-NOTE: the shop on this machine, which is the overwhelmingly likely one. Named like the
// data root, and for the same reason: `3D_` is not a legal start for an environment variable.
export const SHOP_URL_ENV = 'PRINT_SHOP_URL';

export const DEFAULT_PORT = 7373;

/** The shop on this machine. What a client falls back to when nobody says where to look. */
export const DEFAULT_SHOP_URL = `http://localhost:${DEFAULT_PORT}`;

export function defaultShopUrl(): string {
  return process.env[SHOP_URL_ENV] ?? DEFAULT_SHOP_URL;
}
