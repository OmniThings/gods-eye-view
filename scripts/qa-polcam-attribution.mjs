/** Measure required attribution against real PolCam chrome, without fixed size assumptions.
 * Run against an existing development server:
 * node scripts/qa-polcam-attribution.mjs --url http://127.0.0.1:4300 --output /tmp/polcam-attribution.json
 */
import puppeteer from 'puppeteer';
import { writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
const option = (key) => {
  const index = args.indexOf(key);
  return index >= 0 ? args[index + 1] : undefined;
};
const inputUrl = option('--url');
if (!inputUrl) throw new Error('Pass --url for an already running application');
const url = new URL(inputUrl);
// No live layer is required for a chrome test; a share state skips onboarding.
url.hash =
  'v=2&lat=53.55&lon=10&alt=4500&style=normal&hud=tactical&hv=1&dm=OFF&sc=0&map=esri-imagery&l=';
const output = option('--output');
const browser = await puppeteer.launch({
  headless: true,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const results = [];
try {
  const page = await browser.newPage();
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager &&
      document.querySelector('#cesium-credits .cesium-credit-expand-link'),
    { timeout: 60000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(0, 0);
  for (const [width, height] of [
    [1440, 900],
    [1024, 768],
    [800, 600],
    [560, 760],
    [390, 844],
    [320, 568],
  ]) {
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    for (const scenario of [
      'compact',
      'minimal',
      'layers',
      'display',
      'cctv',
      'location',
      'presets',
      'pinned',
      'clean',
      'recording',
    ]) {
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.styleManager &&
          document.querySelector('#cesium-credits .cesium-credit-expand-link'),
        { timeout: 60000 },
      );
      await page.evaluate((name) => {
        const manager = window.__godsEyeView.styleManager;
        document.body.classList.remove('ui-clean-view', 'recording-mode');
        document
          .getElementById('first-run-launcher')
          ?.setAttribute('hidden', '');
        manager.hud.setMode('on');
        manager.hud.setVariant(
          name === 'minimal' || name === 'recording' ? 'minimal' : 'tactical',
        );
        for (const id of ['location-bar', 'control-panel']) {
          manager._panelChrome._setCommandDockPanelPinState(id, false, {
            restore: true,
            persist: false,
            syncShare: false,
          });
        }
        for (const id of [
          'data-panel',
          'scene-panel',
          'pp-toggles',
          'cctv-panel',
          'global-context-panel',
          'location-bar',
          'control-panel',
        ]) {
          manager.setPanelCollapsed(id, true, {
            restore: true,
            persist: false,
            syncShare: false,
          });
        }
        const panel = {
          layers: 'data-panel',
          display: 'pp-toggles',
          cctv: 'cctv-panel',
          location: 'location-bar',
          presets: 'control-panel',
        }[name];
        if (panel)
          manager.setPanelCollapsed(panel, false, {
            restore: true,
            persist: false,
            syncShare: false,
          });
        if (name === 'pinned')
          for (const id of ['location-bar', 'control-panel']) {
            manager._panelChrome._setCommandDockPanelPinState(id, true, {
              restore: true,
              persist: false,
              syncShare: false,
            });
          }
        if (name === 'clean') document.body.classList.add('ui-clean-view');
        if (name === 'recording') document.body.classList.add('recording-mode');
        window.__godsEyeView.viewer.resize();
        window.__godsEyeView.viewer.scene.requestRender();
      }, scenario);
      // Existing transitions and the panel ResizeObserver settle before measuring.
      await new Promise((resolve) => setTimeout(resolve, 450));
      const result = await page.evaluate(() => {
        const visible = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const style = getComputedStyle(node);
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              Number(style.opacity) === 0
            )
              return false;
          }
          return true;
        };
        const box = (element, clip = false) => {
          const rect = element.getBoundingClientRect();
          const result = {
            left: rect.left,
            right: rect.right,
            top: rect.top,
            bottom: rect.bottom,
          };
          if (clip)
            for (
              let parent = element.parentElement;
              parent;
              parent = parent.parentElement
            ) {
              const style = getComputedStyle(parent);
              const bounds = parent.getBoundingClientRect();
              if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
                result.left = Math.max(result.left, bounds.left);
                result.right = Math.min(result.right, bounds.right);
              }
              if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
                result.top = Math.max(result.top, bounds.top);
                result.bottom = Math.min(result.bottom, bounds.bottom);
              }
            }
          return result;
        };
        const intersects = (a, b) =>
          a.right > b.left + 1 &&
          a.left < b.right - 1 &&
          a.bottom > b.top + 1 &&
          a.top < b.bottom - 1;
        const credit = document.getElementById('cesium-credits');
        let bounds = box(credit);
        const elements = [
          ...credit.querySelectorAll(
            '.cesium-credit-logoContainer, .cesium-credit-textContainer, .cesium-credit-expand-link',
          ),
        ].filter(
          (element) =>
            visible(element) &&
            element.getBoundingClientRect().width > 0 &&
            element.getBoundingClientRect().height > 0,
        );
        const creditRects = elements.map((element) => box(element));
        if (creditRects.length)
          bounds = {
            left: Math.min(...creditRects.map((rect) => rect.left)),
            right: Math.max(...creditRects.map((rect) => rect.right)),
            top: Math.min(...creditRects.map((rect) => rect.top)),
            bottom: Math.max(...creditRects.map((rect) => rect.bottom)),
          };
        const obstacles = [
          ...document.querySelectorAll(
            '.polcam-statusbar, .polcam-appbar, #command-dock, .dock-popover-content, #left-panel-stack > [data-panel-id], #right-context-rail > [data-panel-id]',
          ),
        ]
          .filter(visible)
          .map((element) => ({
            name: element.id || element.className,
            rect: box(element, true),
          }))
          .filter(
            ({ rect }) => rect.right > rect.left && rect.bottom > rect.top,
          );
        const collisions = [];
        for (const element of elements) {
          const rect = box(element);
          for (const obstacle of obstacles)
            if (intersects(rect, obstacle.rect)) collisions.push(obstacle.name);
        }
        return {
          visible:
            visible(credit) &&
            bounds.right > bounds.left &&
            bounds.bottom > bounds.top,
          inViewport:
            bounds.left >= -1 &&
            bounds.right <= innerWidth + 1 &&
            bounds.top >= -1 &&
            bounds.bottom <= innerHeight + 1,
          hasAttributionLink: elements.some((element) =>
            element.classList.contains('cesium-credit-expand-link'),
          ),
          collisions: [...new Set(collisions)],
          bounds,
          creditRects,
          collisionRects: obstacles.filter((obstacle) =>
            collisions.includes(obstacle.name),
          ),
          font: getComputedStyle(credit).fontFamily,
        };
      });
      results.push({ width, height, scenario, ...result });
    }
  }
} finally {
  await browser.close();
}
const failures = results.filter(
  (result) =>
    !result.visible ||
    !result.inViewport ||
    !result.hasAttributionLink ||
    result.collisions.length,
);
if (output)
  await writeFile(
    output,
    `${JSON.stringify({ results, failures }, null, 2)}\n`,
  );
console.log(JSON.stringify({ checks: results.length, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
