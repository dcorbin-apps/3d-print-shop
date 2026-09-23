import { contextBridge, ipcRenderer } from 'electron';
import type { GET_SHOP_URL, SAVE_SHOP_URL, SaveResult, ShopSettingsBridge } from './settingsBridge.js';

// AIDEV-NOTE: CommonJS, and importing nothing of ours at runtime, because a SANDBOXED preload can only
// require electron itself. The channels are spelled out here and typed against the shared constants,
// so renaming one there without here fails to compile.
const getShopUrl: typeof GET_SHOP_URL = 'settings:getShopUrl';
const saveShopUrl: typeof SAVE_SHOP_URL = 'settings:saveShopUrl';

const bridge: ShopSettingsBridge = {
  shopUrl: () => ipcRenderer.invoke(getShopUrl) as Promise<string>,
  saveShopUrl: (typed) => ipcRenderer.invoke(saveShopUrl, typed) as Promise<SaveResult>,
};

contextBridge.exposeInMainWorld('shopSettings', bridge);
