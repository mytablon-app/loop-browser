// Render assets/loop-icon.svg into a 1024px transparent PNG for the app icon.
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "fs";

mkdirSync(new URL("./build/", import.meta.url), { recursive: true });
const svg = readFileSync(new URL("../assets/loop-icon.svg", import.meta.url), "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
await page.setContent(
  `<style>*{margin:0;padding:0}svg{width:1024px;height:1024px;display:block}</style>${svg}`
);
await page.waitForTimeout(200);
await page.screenshot({
  path: new URL("./build/icon_1024.png", import.meta.url).pathname,
  omitBackground: true,
  clip: { x: 0, y: 0, width: 1024, height: 1024 },
});
await browser.close();
console.log("wrote build/icon_1024.png");
