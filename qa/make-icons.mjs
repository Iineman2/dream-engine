// Renders icons/icon.svg to the PNG sizes the manifest needs.
import { chromium } from 'playwright-core';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = await readFile(root + 'icons/icon.svg', 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<style>html,body{margin:0;background:#0d0b0a}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`);
  await page.screenshot({ path: `${root}icons/icon-${size}.png` });
  await page.close();
}
await browser.close();
console.log('icons written');
