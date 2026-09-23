import type { ShopSettingsBridge } from './settingsBridge.js';

declare global {
  interface Window {
    shopSettings: ShopSettingsBridge;
  }
}

const form = document.querySelector('form') as HTMLFormElement;
const input = document.querySelector('input') as HTMLInputElement;
const problem = document.querySelector('.problem') as HTMLElement;

void window.shopSettings.shopUrl().then((shopUrl) => {
  input.value = shopUrl;
  input.select();
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void window.shopSettings.saveShopUrl(input.value).then((result) => {
    problem.textContent = result.saved ? '' : result.reason;
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.close();
});

document.querySelector('.cancel')?.addEventListener('click', () => window.close());
