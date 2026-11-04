/**
 * Offline browser smoke test for the generated conversation sample.
 * Requirements: Node.js, Playwright (npm package), and a Chromium executable.
 * Run build first: python3 demo/build.py
 * Run here: node tests/ui-smoke.cjs
 * Optional: MILLIE_CHROMIUM_PATH=/path/to/chromium node tests/ui-smoke.cjs
 *
 * No credentials, network requests, production LINE calls, or actual clipboard
 * writes are needed. Screenshots go to demo/preview-*.png; the PNG download is
 * stored in the operating system temporary directory. The HTML is loaded with
 * setContent, allowing test environments that prohibit file:// navigation.
 */
'use strict';

const {chromium} = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');

(async () => {
  const root = path.resolve(__dirname, '..');
  const browser = await chromium.launch({
    executablePath: process.env.MILLIE_CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const errors = [];
  let assertions = 0;
  try {
    const page = await browser.newPage({
      viewport: {width: 1365, height: 1000},
      deviceScaleFactor: 1,
      acceptDownloads: true
    });
    page.on('pageerror', error => errors.push(error.message));
    const idle = () => page.waitForFunction(() => !document.getElementById('message').disabled);
    const count = async () => Number(await page.locator('#count-value').innerText());
    async function say(text) {
      await idle();
      await page.locator('#message').fill(text);
      await page.locator('#send').click();
      await idle();
    }
    fs.mkdirSync(path.join(root, 'demo'), {recursive:true});
    const demoPath=fs.existsSync(path.join(root,'demo/index.html')) ? path.join(root,'demo/index.html') : path.join(root,'ミリーちゃん_作品準拠サンプル.html');
    await page.setContent(fs.readFileSync(demoPath, 'utf8'));
    await idle();

    // Initial follow event is not an ordinary counted conversation turn.
    assert.equal(await page.locator('.message.bot').count(), 2);
    assert.equal(await count(), 0);
    assert.equal(await page.locator('.starter:visible').count(), 3);
    assert.equal(await page.locator('#share-section').isVisible(), false);
    assertions += 4;
    await page.screenshot({path: path.join(root, 'demo/preview-desktop.png'), fullPage: true});

    // Input must be text, including strings that resemble executable markup.
    await say('<img src=x onerror=alert(1)>');
    assert.equal(await page.locator('.bubble img').count(), 0);
    assert.equal(await count(), 1);
    assertions += 2;

    // Stop interrupts in-flight typing and paused messages do not advance.
    await page.locator('#message').fill('友だちといると疲れる');
    await page.locator('#send').click();
    await page.locator('.typing').waitFor();
    await page.locator('#stop').click();
    await idle();
    assert.equal(await page.locator('.typing').count(), 0);
    assert.match(await page.locator('.message.bot').last().innerText(), /再開/);
    assertions += 2;
    const stoppedCount = await count();
    await say('つづきを聞かせて');
    assert.equal(await count(), stoppedCount);
    await say('再開');
    assert.equal(await count(), stoppedCount);
    assertions += 2;

    // Reset cancels outstanding asynchronous responses from the old session.
    await page.locator('#message').fill('こんにちは');
    await page.locator('#send').click();
    await page.locator('.typing').waitFor();
    await page.locator('#reset').click();
    await idle();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('.message.bot').count(), 2);
    assert.equal(await page.locator('.message.user').count(), 0);
    assert.equal(await count(), 0);
    assertions += 3;

    // Confirming Japanese IME conversion must not submit the message.
    await page.locator('#message').fill('変換中');
    await page.locator('#message').dispatchEvent('compositionstart');
    await page.locator('#message').press('Enter');
    await page.locator('#message').dispatchEvent('compositionend');
    assert.equal(await count(), 0);
    assertions++;
    await page.locator('#message').fill('変換が終わった');
    await page.locator('#message').press('Enter');
    await idle();
    assert.equal(await count(), 1);
    assertions++;

    // Preview stages use the core threshold, including the final closure.
    await page.locator('[data-phase="8"].phase-button').click();
    assert.equal(await page.locator('#phase-value').innerText(), '08');
    assert.equal(await count(), 37);
    assert.equal(await page.locator('#phone').evaluate(node => node.classList.contains('night')), true);
    assertions += 3;
    await page.locator('#time-preview').selectOption('02:17');
    await say('好きな人から返事がこない');
    assert.equal(await count(), 38);
    assert.equal(await page.locator('#phase-value').innerText(), '08');
    assert.match(await page.locator('#date-divider').innerText(), /2:17/);
    assertions += 3;
    await page.locator('[data-phase="10"].phase-button').click();
    await say('誰かに必要とされたい。あかね検証という名前です');
    assert.equal(await count(), 52);
    assert.equal(await page.locator('#phase-value').innerText(), '10');
    assertions += 2;

    // Record canvas text only in this test, to check that input is excluded.
    // Clipboard is deliberately unavailable to exercise the accessible fallback.
    await page.evaluate(() => {
      window.canvasTexts = [];
      const original = CanvasRenderingContext2D.prototype.fillText;
      CanvasRenderingContext2D.prototype.fillText = function (text, ...args) {
        window.canvasTexts.push(String(text));
        return original.call(this, text, ...args);
      };
      Object.defineProperty(navigator, 'clipboard', {value: undefined, configurable: true});
    });
    await page.locator('[data-command="共有"]').click();
    await idle();
    await page.locator('#share-section').waitFor({state: 'visible'});
    const publicTexts = await page.evaluate(() => window.canvasTexts.join('\n'));
    assert.doesNotMatch(publicTexts, /あかね検証|名前です|必要とされたい/);
    assert.ok((await page.locator('#share-canvas').evaluate(node => node.toDataURL('image/png'))).length > 10000);
    assert.equal(await count(), 52);
    assertions += 3;
    await page.locator('#copy-share').click();
    assert.equal(await page.locator('#copy-fallback').isVisible(), true);
    assert.match(await page.locator('#copy-text').inputValue(), /@575kepfk/);
    assert.doesNotMatch(await page.locator('#copy-text').inputValue(), /あかね検証/);
    assertions += 3;
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#download').click()
    ]);
    assert.equal(download.suggestedFilename(), 'millie-story.png');
    await download.saveAs(path.join(os.tmpdir(), 'millie-share-card.png'));
    assertions++;

    // Mobile chat occupies one viewport; the production panel is below it.
    await page.locator('#reset').click();
    await idle();
    await page.setViewportSize({width: 390, height: 844});
    await page.screenshot({path: path.join(root, 'demo/preview-mobile.png'), fullPage: true});
    assert.equal(await page.locator('body').evaluate(node => node.scrollWidth), 390);
    assert.equal(await page.locator('.phone').evaluate(node => node.getBoundingClientRect().height), 844);
    assertions += 2;
    await page.setViewportSize({width: 320, height: 568});
    assert.equal(await page.locator('body').evaluate(node => node.scrollWidth), 320);
    assertions++;
    assert.deepEqual(errors, []);
    assertions++;
    console.log('PASS', assertions, 'browser assertions; screenshots and anonymous PNG generated.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
