// Verify the actual HTTPS deployment and exercise it in a fresh browser context.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results');
fs.mkdirSync(output, { recursive: true });
const target = new URL(process.argv[2]);
assert.equal(target.protocol, 'https:', 'A real HTTPS URL is required');
assert(target.pathname.endsWith('/'), 'Include the final slash in the site URL');
const report = { checkedAt: new Date().toISOString(), url: target.href, files: [], browsers: [] };
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

(async () => {
  for (const name of ['index.html', 'docs/index.html', 'COPYRIGHT.txt', 'THIRD_PARTY_NOTICES.txt']) {
    const response = await fetch(new URL(name, target), { signal: AbortSignal.timeout(30000) });
    assert.equal(response.status, 200, `${name}: HTTP ${response.status}`);
    assert.equal(new URL(response.url).protocol, 'https:');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha(bytes), sha(fs.readFileSync(path.join(root, name))), `${name}: deployed bytes differ`);
    report.files.push({ name, status: response.status, sha256: sha(bytes), bytes: bytes.length });
  }
  const options = { headless: true };
  if (process.env.BROWSER_CHANNEL) options.channel = process.env.BROWSER_CHANNEL;
  const browser = process.env.BROWSER_PROFILE
    ? (await chromium.launchPersistentContext(process.env.BROWSER_PROFILE, options)).browser()
    : await chromium.launch(options);
  try {
    for (const width of [1366, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: width === 390 });
      await context.addInitScript(() => {
        const NativeAudio = window.Audio;
        window.__played = 0;
        window.Audio = function(...args) { const audio = new NativeAudio(...args); audio.addEventListener('playing', () => window.__played++); return audio; };
        window.Audio.prototype = NativeAudio.prototype;
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [], failures = [], insecure = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('requestfailed', r => failures.push(r.url()));
      page.on('request', r => { if (r.url().startsWith('http:')) insecure.push(r.url()); });
      const response = await page.goto(target.href, { waitUntil: 'load' });
      assert.equal(response.status(), 200);
      await page.locator('.start').waitFor();
      assert.equal(await page.locator('#author-credit').textContent(), '© 2026. Автор — Чернеева Т. А. Все права защищены.');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.waitForFunction(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
      await page.screenshot({ path: path.join(output, `live-${width}.png`), fullPage: true });
      await page.locator('.start')[width === 390 ? 'tap' : 'click']();
      await page.getByRole('heading', { name: 'Карта открытий', exact: true }).waitFor();
      await page.waitForFunction(() => window.__played > 0);
      await page.locator('.map-node').first().click();
      for (const name of ['Наблюдать', 'Задавать вопросы', 'Исследовать']) await page.locator('.task-area').getByRole('button', { name, exact: true }).click();
      await page.locator('.feedback.success').waitFor();
      await page.reload();
      await page.waitForFunction(() => JSON.parse(localStorage.getItem('lomonosov-session-v1'))?.evidence.actions.done);
      await page.goto(new URL('docs/', target).href);
      await page.getByRole('link', { name: '← Вернуться к игре' }).click();
      await page.locator('.start').waitFor();
      assert.deepEqual(errors, []); assert.deepEqual(failures, []); assert.deepEqual(insecure, []);
      report.browsers.push({ width, version: browser.version(), https: true, audioPlayed: true, task: true, reload: true, memo: true, errors, failures });
      await context.close();
    }
  } finally { await browser.close(); }
  console.log('PASS: HTTPS, exact deployed files, desktop and touch UI, audio, task, saved progress and memo.');
})().catch(error => { report.error = error.stack; console.error(error); process.exitCode = 1; })
  .finally(() => fs.writeFileSync(path.join(output, 'live-results.json'), JSON.stringify(report, null, 2)));
