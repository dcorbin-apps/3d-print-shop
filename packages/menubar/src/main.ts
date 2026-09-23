import { BrowserWindow, Menu, Tray, app, ipcMain, nativeImage, systemPreferences } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SHOP_URL, SHOP_URL_ENV } from '@3d-print-shop/client';
import { doubleClicks } from './doubleClicks.js';
import { GET_SHOP_URL, SAVE_SHOP_URL } from './settingsBridge.js';
import type { SaveResult } from './settingsBridge.js';
import { readShopUrl, saveShopUrl } from './shopSetting.js';

const fromHere = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// A macOS template image: black on transparent, and the menu bar recolours it for light and dark.
const trayIconPath = fromHere('../assets/trayTemplate.png');
const settingsPagePath = fromHere('../assets/settings.html');
const settingsPreloadPath = fromHere('./settingsPreload.cjs');
const settingsFile = join(app.getPath('userData'), 'settings.json');

// AIDEV-TODO: remove once each OctoPrint has an https address - see PLAN.md, "The icon in the menu bar".
// A camera is an http MJPEG stream shown in an https page, and Chromium rewrites such an image to
// https, where OctoPrint does not answer. Measured: `allowRunningInsecureContent` does not stop the
// rewrite and turning this feature off does; it covers images and media only, so http script stays
// blocked.
app.commandLine.appendSwitch('disable-features', 'AutoupgradeMixedContent');

// AIDEV-NOTE: the window loads the shop's OWN url, never a bundled copy of ui/dist over file:// -
// that would be cross-origin against an API with no CORS handling. A window pointed at the shop is a
// browser pointed at the shop, so the session cookie behaves. See PLAN.md, "The icon in the menu bar".
// A shop chosen in Settings wins over PRINT_SHOP_URL, which is only the default until one is chosen.
const chosenShopUrl = readShopUrl(settingsFile) ?? process.env[SHOP_URL_ENV];
let shopUrl = chosenShopUrl ?? DEFAULT_SHOP_URL;

let shopWindow: BrowserWindow | undefined;
let settingsWindow: BrowserWindow | undefined;
let tray: Tray | undefined;

function bringForward(window: BrowserWindow): void {
  window.show();
  // With no dock icon the app is an accessory, and showing its window does not bring it forward.
  app.focus({ steal: true });
}

// AIDEV-NOTE: hidden until the page has painted, on the page's own ground (--ground in the ui's
// styles.css, which is dark-only), so opening it is not a white flash. Change both together.
const SHOP_PAGE_GROUND = '#14181d';

function openShopWindow(): void {
  if (shopWindow !== undefined) {
    bringForward(shopWindow);
    return;
  }
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    title: '3D Print Shop',
    show: false,
    backgroundColor: SHOP_PAGE_GROUND,
    webPreferences: { sandbox: true },
  });
  shopWindow = window;
  window.once('ready-to-show', () => bringForward(window));
  window.on('closed', () => {
    shopWindow = undefined;
  });
  void window.loadURL(shopUrl);
}

function openSettingsWindow(): void {
  if (settingsWindow === undefined) {
    settingsWindow = new BrowserWindow({
      width: 460,
      height: 150,
      resizable: false,
      minimizable: false,
      maximizable: false,
      title: 'Settings',
      webPreferences: { preload: settingsPreloadPath, sandbox: true },
    });
    settingsWindow.on('closed', () => {
      settingsWindow = undefined;
    });
    void settingsWindow.loadFile(settingsPagePath);
  }
  bringForward(settingsWindow);
}

function useShop(typed: string): SaveResult {
  try {
    shopUrl = saveShopUrl(settingsFile, typed);
  } catch (failure) {
    return { saved: false, reason: (failure as Error).message };
  }
  tray?.setToolTip(`3D Print Shop - ${shopUrl}`);
  void shopWindow?.loadURL(shopUrl);
  settingsWindow?.close();
  return { saved: true };
}

function installTray(): void {
  tray = new Tray(nativeImage.createFromPath(trayIconPath));
  tray.setToolTip(`3D Print Shop - ${shopUrl}`);
  // AIDEV-NOTE: the menu is popped up on right-click rather than set with setContextMenu, because a
  // context menu set on a macOS tray takes the left click too, and a double-click is made of those.
  // Quit quits this app and nothing else - the shop is a daemon of its own and keeps running.
  const menu = Menu.buildFromTemplate([
    { label: 'Open the Shop', click: openShopWindow },
    { label: 'Settings…', click: openSettingsWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  // AIDEV-NOTE: Electron's own 'double-click' never fires here - measured: every click on the status
  // item arrives with a click count of 1 - so a pair of 'click's is what makes one.
  const click = doubleClicks(doubleClickIntervalMs(), openShopWindow);
  tray.on('click', () => click(Date.now()));
  tray.on('right-click', () => tray?.popUpContextMenu(menu));
}

// The user's own setting from System Settings when they have changed it, and macOS's default otherwise.
function doubleClickIntervalMs(): number {
  const seconds = systemPreferences.getUserDefault('com.apple.mouse.doubleClickThreshold', 'double');
  return seconds > 0 ? seconds * 1000 : 500;
}

ipcMain.handle(GET_SHOP_URL, () => shopUrl);
ipcMain.handle(SAVE_SHOP_URL, (_event, typed: string) => useShop(typed));

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock?.hide();
    installTray();
    if (chosenShopUrl === undefined) openSettingsWindow();
  } else {
    openShopWindow();
  }
});
