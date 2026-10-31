// Real UI tests against both / and /lomonosov-game/; no production test hooks.
const { chromium, firefox, webkit } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const root = path.resolve(__dirname, '..');
const results = path.join(root, 'test-results');
fs.mkdirSync(results, { recursive: true });
const report = { started: new Date().toISOString(), browsers: [], checks: [] };
const types = { '.html': 'text/html; charset=utf-8', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer((req, res) => {
  let name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  name = name.replace(/^\/lomonosov-game\//, '/');
  if (name.endsWith('/')) name += 'index.html';
  const file = path.resolve(root, '.' + name);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

function check(name, detail) { report.checks.push({ name, detail, pass: true }); console.log('PASS', name, detail?.readyMs ? `${detail.readyMs} ms` : ''); }
function skip(name, reason) { report.checks.push({ name, pass: null, reason }); console.log('SKIP', name, reason); }
async function waitFor(fn, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Timed out waiting for expected browser state');
}
async function noOverflow(page) {
  const value = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  if (value.content > value.width + 1) {
    console.log('OVERFLOW', await page.locator('body *').evaluateAll(nodes => nodes.map(n => ({ tag: n.tagName, class: n.className?.baseVal ?? n.className, text: (n.textContent || '').slice(0, 70), left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right })).filter(n => n.right > innerWidth + 1 || n.left < -1).slice(-25)));
    await page.screenshot({ path: path.join(results, `overflow-${value.width}.png`), fullPage: true });
  }
  assert(value.content <= value.width + 1, JSON.stringify(value));
}
async function click(page, name) { await page.getByRole('button', { name, exact: true }).click(); }
async function taskDone(page) { await page.locator('.feedback.success').waitFor(); }
async function next(page) { await page.locator('.feedback .primary').click(); }
async function answer(page, names) { for (const name of names) await page.locator('.task-area').getByRole('button', { name, exact: true }).click(); await taskDone(page); }
async function pairs(page, names) { for (const [left, right] of names) { await page.locator('.matching').getByRole('button', { name: left, exact: true }).click(); await page.locator('.matching').getByRole('button', { name: right, exact: true }).click(); } await taskDone(page); }
async function station(page, name) { await page.locator('.map-land').getByRole('button', { name: new RegExp(name) }).click(); }

async function instrument(context) {
  await context.addInitScript(() => {
    window.__audio = { made: 0, played: 0, failures: [], overlap: 0, oscillators: 0, contexts: [] };
    const NativeAudio = window.Audio;
    const live = new Set();
    window.Audio = function(...args) {
      const audio = new NativeAudio(...args); window.__audio.made++; live.add(audio);
      audio.addEventListener('playing', () => {
        window.__audio.played++;
        const active = [...live].filter(a => !a.paused && !a.ended && a.currentSrc);
        window.__audio.overlap = Math.max(window.__audio.overlap, active.length);
      });
      audio.addEventListener('error', () => { if (audio.getAttribute('src')) window.__audio.failures.push(audio.error?.code); });
      return audio;
    };
    window.Audio.prototype = NativeAudio.prototype;
    const NativeContext = window.AudioContext || window.webkitAudioContext;
    if (NativeContext) {
      window.AudioContext = class extends NativeContext {
        constructor(...args) { super(...args); window.__audio.contexts.push(this); }
        createOscillator(...args) { window.__audio.oscillators++; return super.createOscillator(...args); }
      };
    }
  });
}

async function journey(browser, browserName, base) {
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await instrument(context);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [], failed = [], external = [];
  let supportsAudio;
  page.on('pageerror', e => errors.push(e.message));
  page.on('requestfailed', r => failed.push(r.url().slice(0, 160)));
  page.on('request', r => { if (/^https?:/.test(r.url()) && !r.url().startsWith(base)) external.push(r.url()); });
  try {
    const started = Date.now();
    await page.goto(base + 'lomonosov-game/');
    await page.locator('.start').waitFor();
    supportsAudio = await page.evaluate(() => Boolean(window.AudioContext || window.webkitAudioContext));
    assert(supportsAudio || browserName === 'webkit' && process.platform === 'win32', 'Native Web Audio support is required for this browser test');
    const timing = await page.evaluate(() => ({ navigation: performance.getEntriesByType('navigation')[0].toJSON(), paints: performance.getEntriesByType('paint').map(p => ({ name: p.name, ms: p.startTime })) }));
    check(browserName + ': initial render', { readyMs: Date.now() - started, timing });
    assert.equal(await page.locator('#author-credit').textContent(), '© 2026. Автор — Чернеева Т. А. Все права защищены.');
    assert.equal(await page.evaluate(() => window.__audio.played), 0);
    assert.equal(await page.evaluate(() => window.__audio.contexts.length), 0);
    await page.screenshot({ path: path.join(results, `${browserName}-desktop.png`), fullPage: true });
    await page.locator('.start').click();
    await page.getByRole('heading', { name: 'Карта открытий' }).waitFor();
    if (supportsAudio) {
      await waitFor(() => page.evaluate(() => window.__audio.played > 0));
      check(browserName + ': audio starts after click');
    } else {
      skip(browserName + ': audio playback', 'This browser build has no native AudioContext. Verify sound in a browser with audio support and real Safari.');
    }
    await station(page, 'Поляна вопросов');
    await page.locator('.task-area').getByRole('button', { name: 'Ничего не делать', exact: true }).click();
    assert.equal(await page.locator('.feedback.success').count(), 0);
  } catch (e) {
    await page.screenshot({ path: path.join(results, `${browserName}-failure.png`), fullPage: true });
    throw e;
  }
  // Continue only if the first task remains active after an incorrect choice.
  assert.equal(await page.locator('.feedback.success').count(), 0);
  await page.getByRole('button', { name: /Подсказка/ }).click();
  await answer(page, ['Наблюдать', 'Задавать вопросы', 'Исследовать']); await next(page);
  await click(page, '☀ В тёплую комнату'); await click(page, '💧 Вода'); await click(page, 'Проверить догадку →');
  await click(page, '❄ На мороз'); await click(page, '❄ Лёд'); await click(page, 'Проверить догадку →');
  await taskDone(page); await next(page);
  await answer(page, ['Рассматривает лист']); await next(page);
  await station(page, 'Галерея учёных');
  await pairs(page, [['Михаил Ломоносов', 'Цветное стекло'], ['Дмитрий Менделеев', 'Таблица элементов'], ['Иван Павлов', 'Реакции на сигналы']]); await next(page);
  await answer(page, ['Михаил Ломоносов']); await next(page);
  await station(page, 'Дорога к знаниям');
  await answer(page, ['Книги', 'Тёплая одежда', 'Дорожная еда']); await next(page);
  for (const name of ['Русский Север', 'Рыбный обоз', 'Москва']) await page.locator('.route').getByRole('button', { name: new RegExp(name) }).click();
  await taskDone(page); await next(page); await answer(page, ['Учиться']); await next(page);
  await station(page, 'Мастерская мозаики');
  const tiles = ['Голубой уголок', 'Золотой луч', 'Голубой уголок', 'Золотой луч', 'Серединка солнца', 'Золотой луч', 'Голубой уголок', 'Золотой луч', 'Голубой уголок'];
  for (let i = 0; i < tiles.length; i++) { await page.locator('.palette').getByRole('button', { name: new RegExp(tiles[i]) }).click(); await page.getByRole('button', { name: new RegExp(`^Место ${i + 1}:`) }).click(); }
  await taskDone(page); await next(page); await answer(page, ['Мозаика']); await next(page);
  await station(page, 'Дом знаний');
  for (const name of ['Фундамент', 'Стены', 'Окна', 'Крыша', 'Книги']) await page.locator('.building-pieces').getByRole('button', { name, exact: true }).click();
  await taskDone(page); await next(page);
  await pairs(page, [['Книги', 'Читать и учиться'], ['Телескоп', 'Изучать небо'], ['Растение', 'Изучать природу']]); await next(page);
  await station(page, 'Город открытий');
  await pairs(page, [['Изучаем растения', 'Лучше заботимся о них'], ['Исследуем материалы', 'Создаём полезные и красивые вещи'], ['Наблюдаем за небом', 'Больше знаем о мире'], ['Учимся и делимся', 'Решаем новые задачи']]); await next(page);
  await click(page, 'Я — маленький исследователь! →');
  for (const name of ['Исследуют мир', 'Михаил Ломоносов', 'Учиться', 'Мозаики', 'Ухаживать за растением']) { await answer(page, [name]); await next(page); }
  await page.getByRole('heading', { name: 'Юный исследователь' }).waitFor();
  await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem('lomonosov-session-v1'))?.quizDone === true));
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lomonosov-session-v1')));
  assert.equal(saved.completed.length, 6); assert(saved.quizDone); assert.equal(Object.keys(saved.evidence).length, 18);
  assert.equal(saved.evidence.actions.mistakes, 1); assert.equal(saved.evidence.actions.hints, 1);
  await page.screenshot({ path: path.join(results, `${browserName}-diploma.png`), fullPage: true });
  check(browserName + ': six stations, 13 tasks, five quiz questions, diploma, errors and hints');
  await page.reload(); await page.locator('.start').click();
  await click(page, 'Мой диплом →');
  await page.getByRole('heading', { name: 'Юный исследователь' }).waitFor();
  check(browserName + ': reload preserves progress');
  await click(page, 'Для педагога');
  await page.locator('dialog .teacher-stations button').first().click();
  await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem('lomonosov-session-v1'))?.completed.length === 5));
  const reset = await page.evaluate(() => JSON.parse(localStorage.getItem('lomonosov-session-v1')));
  assert.equal(reset.completed.length, 5); assert.equal(reset.quizDone, false);
  check(browserName + ': teacher repeats one station');
  await page.getByRole('button', { name: 'Настройки звука', exact: true }).click();
  await page.getByLabel('Отключить весь звук', { exact: false }).check();
  await page.getByLabel('Музыка', { exact: true }).focus(); await page.keyboard.press('End'); await page.keyboard.press('ArrowLeft');
  await page.getByLabel('Голос', { exact: true }).focus(); await page.keyboard.press('Home'); await page.keyboard.press('ArrowRight');
  await page.getByLabel('Уменьшить движение', { exact: false }).check();
  await waitFor(async () => await page.locator('html').getAttribute('data-reduced') === 'true');
  assert.equal(await page.locator('html').getAttribute('data-reduced'), 'true');
  await page.getByLabel('Отключить весь звук', { exact: false }).uncheck();
  await click(page, '♫ Проверить звук и голос');
  await page.getByText('Подключить свою озвучку', { exact: true }).click();
  const sample = /data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)/.exec(fs.readFileSync(path.join(root, 'index.html'), 'utf8'))[1];
  await page.getByLabel('Выбрать записи озвучки', { exact: true }).setInputFiles({ name: '001.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(sample, 'base64') });
  // Export must remain fully standalone with original embedded media.
  const [download] = await Promise.all([page.waitForEvent('download'), click(page, 'Скачать игру с новым голосом')]);
  const downloadPath = path.join(results, `${browserName}-export.html`);
  await download.saveAs(downloadPath);
  const exported = fs.readFileSync(downloadPath, 'utf8');
  assert(exported.includes('data:audio/mpeg;base64,')); assert(exported.includes('Автор — Чернеева Т. А.'));
  fs.unlinkSync(downloadPath);
  await click(page, 'Закрыть');
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Повторить инструкцию', exact: true }).click();
  if (supportsAudio) await waitFor(() => page.evaluate(() => window.__audio.played > 1));
  const audio = await page.evaluate(() => ({ played: window.__audio.played, failures: window.__audio.failures, overlap: window.__audio.overlap, oscillators: window.__audio.oscillators, states: window.__audio.contexts.map(c => c.state) }));
  if (supportsAudio) {
    assert(audio.oscillators > 0); assert(audio.overlap <= 1); assert.deepEqual(audio.failures, []);
    check(browserName + ': recordings, music/effects, volume, no overlapping voice', audio);
  }
  check(browserName + ': sound controls, reduced motion, voice import, portable export');
  const images = await page.locator('img').evaluateAll(items => items.map(i => ({ complete: i.complete, width: i.naturalWidth })));
  assert(images.every(i => i.complete && i.width > 0));
  await noOverflow(page); assert.deepEqual(errors, []); assert.deepEqual(failed, []); assert.deepEqual(external, []);
  check(browserName + ': no browser errors, broken requests, external network dependencies');
  await page.getByRole('button', { name: 'На главный экран', exact: true }).click();
  await click(page, '↺ Начать заново'); await click(page, 'Отмена');
  assert.equal(await page.locator('.start').count(), 1);
  await click(page, '↺ Начать заново'); await click(page, 'Да, начать заново');
  await waitFor(() => page.evaluate(() => JSON.parse(localStorage.getItem('lomonosov-session-v1'))?.completed.length === 0));
  check(browserName + ': confirmed full reset');
  await context.close();
}

async function responsive(browser, browserName, base) {
  for (const [width, height] of [[320, 740], [390, 844], [768, 1024], [1024, 768], [1920, 1080]]) {
    const touch = width < 1200;
    const context = await browser.newContext({ viewport: { width, height }, hasTouch: touch, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    await page.goto(base + 'lomonosov-game/'); await page.locator('.start').waitFor(); await noOverflow(page);
    if (width === 390 || width === 768) await page.screenshot({ path: path.join(results, `${browserName}-${width}.png`), fullPage: true });
    await page.locator('.start')[touch ? 'tap' : 'click'](); await noOverflow(page);
    for (const name of ['Поляна вопросов', 'Галерея учёных', 'Дорога к знаниям', 'Мастерская мозаики', 'Дом знаний', 'Город открытий']) {
      const node = page.locator('.map-land').getByRole('button', { name: new RegExp(name) });
      const bounds = await node.boundingBox(); assert(bounds.height >= 48 && bounds.width >= 48);
      await node[touch ? 'tap' : 'click'](); await noOverflow(page);
      if (name === 'Поляна вопросов') { await page.locator('.choice').first()[touch ? 'tap' : 'click'](); await waitFor(async () => await page.locator('.choice.found').count() === 1); }
      await click(page, '← К карте путешествия');
    }
    await page.goto(base + 'lomonosov-game/docs/'); await page.getByRole('heading', { name: 'По следам великих открытий', exact: true }).waitFor(); await noOverflow(page);
    await page.getByRole('link', { name: '← Вернуться к игре' }).click(); await page.locator('.start').waitFor();
    check(browserName + `: ${width}×${height} layout, ${touch ? 'touch' : 'mouse'}, all station screens, memo`);
    await context.close();
  }
  const page = await browser.newPage(); await page.goto(base); await page.locator('.start').waitFor(); await page.close();
  check(browserName + ': hosting at domain root and subdirectory');
}

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  for (const name of (process.env.TEST_BROWSERS || 'chromium').split(',')) {
    const engine = { chromium, firefox, webkit }[name];
    assert(engine, 'Unknown browser: ' + name);
    const options = { headless: true };
    if (process.env.BROWSER_CHANNEL && name === 'chromium') options.channel = process.env.BROWSER_CHANNEL;
    const browser = process.env.BROWSER_PROFILE && name === 'chromium'
      ? (await engine.launchPersistentContext(process.env.BROWSER_PROFILE, options)).browser()
      : await engine.launch(options);
    report.browsers.push({ engine: name, version: browser.version(), channel: options.channel });
    try { if (!process.env.RESPONSIVE_ONLY) await journey(browser, name, base); await responsive(browser, name, base); }
    catch (error) { for (const [i, page] of browser.contexts().flatMap(c => c.pages()).entries()) { await page.screenshot({ path: path.join(results, `${name}-failure-${i}.png`), fullPage: true }).catch(() => {}); } throw error; }
    finally { await browser.close(); }
  }
})().catch(e => { console.error(e); report.error = e.stack; process.exitCode = 1; })
  .finally(() => { server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(results, 'results.json'), JSON.stringify(report, null, 2)); });
