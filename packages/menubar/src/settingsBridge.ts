export const GET_SHOP_URL = 'settings:getShopUrl';
export const SAVE_SHOP_URL = 'settings:saveShopUrl';

export type SaveResult = { saved: true } | { saved: false; reason: string };

/** What the settings page may ask of the app, and nothing else. */
export interface ShopSettingsBridge {
  shopUrl(): Promise<string>;
  saveShopUrl(typed: string): Promise<SaveResult>;
}
