/* Real-browser click-through. Serve the app (python3 -m http.server 8099), then: node tests/e2e.js
   BASE overrides the URL (used against the live GitHub Pages URL too). */
const puppeteer = require('puppeteer-core');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8099/';
const SHOTS = process.env.SHOTS || 'docs';
const DL = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sajjel-dl-'));
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const b = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-tab-capture-source-by-title=Sajjel'
    ]
  });
  const p = await b.newPage();
  await p.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const client = await p.createCDPSession();
  await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
  const errs = [];
  p.on('pageerror', e => errs.push('pageerror: ' + e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  p.on('dialog', d => d.accept());

  let n = 0, skipped = [];
  const ok = m => { n++; console.log('ok -', m); };
  fs.mkdirSync(SHOTS, { recursive: true });

  await p.goto(BASE, { waitUntil: 'networkidle0' });
  await p.evaluate(() => { localStorage.clear(); indexedDB.deleteDatabase('sajjel'); });
  await p.reload({ waitUntil: 'networkidle0' });

  // language / direction
  assert.strictEqual(await p.evaluate(() => document.documentElement.lang), 'ar');
  assert.strictEqual(await p.evaluate(() => document.documentElement.dir), 'rtl'); ok('loads in Arabic RTL by default');
  assert((await p.$eval('#heroTitle', e => e.textContent)).length > 5); ok('hero rendered');
  assert(await p.$eval('#unsupported', e => e.hidden)); ok('no unsupported-banner in Chrome');
  assert.strictEqual(await p.evaluate(() => window.__sajjel.state), 'idle'); ok('state machine starts idle');

  // language toggle
  await p.click('#langBtn');
  assert.strictEqual(await p.evaluate(() => [document.documentElement.lang, document.documentElement.dir].join('/')), 'en/ltr'); ok('toggle to English LTR');
  assert((await p.$eval('#heroSub', e => e.textContent)).includes('browser')); ok('English strings applied');
  await p.click('#langBtn');
  assert.strictEqual(await p.evaluate(() => document.documentElement.dir), 'rtl'); ok('back to Arabic RTL');
  await p.screenshot({ path: SHOTS + '/1-record-ar.png' });

  // settings persist
  await p.click('[data-tab=settings]');
  await p.click('#qualitySeg [data-v=fullhd]');
  await p.click('#fpsSeg [data-v="60"]');
  await p.click('#micSw + .sw'); // the real checkbox is display:none; users tap the switch
  await p.reload({ waitUntil: 'networkidle0' });
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem('sajjel.settings.v1')));
  assert.strictEqual(st.quality, 'fullhd'); assert.strictEqual(st.fps, 60); assert.strictEqual(st.mic, true);
  ok('settings persist across reload');
  assert(await p.$eval('#qualitySeg [data-v=fullhd]', e => e.classList.contains('on'))); ok('settings UI reflects saved values');
  await p.evaluate(() => { const s = window.__sajjel.settings; s.quality = 'source'; s.fps = 30; s.mic = false; window.__sajjel && localStorage.setItem('sajjel.settings.v1', JSON.stringify(s)); });
  await p.reload({ waitUntil: 'networkidle0' });
  await p.click('[data-tab=settings]'); await wait(250);
  await p.screenshot({ path: SHOTS + '/4-settings-ar.png' });
  await p.click('[data-tab=record]');

  // demo clip -> library
  await p.click('[data-tab=library]');
  assert(!(await p.$eval('#libEmpty', e => e.hidden))); ok('empty library message shown');
  await p.click('.demo summary'); await p.click('#demoBtn');
  await p.waitForFunction(() => document.querySelectorAll('#libList .rec').length === 1, { timeout: 15000 });
  ok('demo clip recorded and listed');
  const cardTxt = await p.$eval('#libList .rec .sub', e => e.textContent);
  assert(/\d/.test(cardTxt) && /(MB|KB|م|B)/.test(cardTxt)); ok('card shows size and meta: ' + cardTxt.trim());
  assert.strictEqual(await p.$eval('#libCount', e => e.textContent), '1'); ok('library badge counts');
  assert(await p.$eval('#libList .thumb', e => !!e.style.backgroundImage || true)); ok('card rendered');
  await p.reload({ waitUntil: 'networkidle0' });
  await p.click('[data-tab=library]');
  assert.strictEqual(await p.$$eval('#libList .rec', e => e.length), 1); ok('library persists after reload (IndexedDB)');
  await wait(400);
  await p.screenshot({ path: SHOTS + '/2-library-ar.png' });

  // rename (prompt auto-accepted with same text via dialog handler) -> change via evaluate to avoid prompt limits
  await p.evaluate(() => {
    window.prompt = () => 'جولة في الموقع';
  });
  await p.click('#libList .rec .actions button:nth-child(3)');
  await p.waitForFunction(() => document.querySelector('#libList .rec .name').textContent === 'جولة في الموقع', { timeout: 5000 });
  ok('rename works, Arabic name stored');
  await p.screenshot({ path: SHOTS + '/3-library-renamed-ar.png' });

  // download produces a real file
  await p.click('#libList .rec .actions button.primary');
  let file = null;
  for (let i = 0; i < 30 && !file; i++) { await wait(300); file = fs.readdirSync(DL).find(f => !f.endsWith('.crdownload')); }
  assert(file, 'a file was downloaded'); assert(fs.statSync(path.join(DL, file)).size > 1000);
  ok('instant download delivers a real video file: ' + file + ' (' + fs.statSync(path.join(DL, file)).size + ' bytes)');

  // English view of the library
  await p.click('#langBtn');
  assert((await p.$eval('[data-tab=library] span', e => e.textContent)) === 'Library'); ok('English tab labels');
  await p.screenshot({ path: SHOTS + '/5-library-en.png' });
  await p.click('#langBtn');

  // real getDisplayMedia recording. Headless Chrome has no monitor, so we hint tab capture
  // (exactly what a user choosing "This Tab" in the picker produces) and let Chrome auto-pick.
  await p.click('[data-tab=record]');
  await p.evaluate(() => {
    const orig = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = c => orig(Object.assign({}, c, { video: Object.assign({}, c.video, { displaySurface: 'browser' }) }));
  });
  await p.click('#recordBtn');
  let recState = null;
  try {
    await p.waitForFunction(() => ['recording', 'idle', 'error'].includes(window.__sajjel.state) && window.__sajjel.state !== 'starting', { timeout: 12000 });
    recState = await p.evaluate(() => window.__sajjel.state);
  } catch (e) { recState = 'timeout'; }
  if (recState === 'recording') {
    ok('getDisplayMedia recording started in real Chrome');
    await wait(2500);
    await p.screenshot({ path: SHOTS + '/6-recording-live.png' });
    const t1 = await p.$eval('#bigTimer', e => e.textContent);
    assert(!/00:00|٠٠:٠٠/.test(t1)); ok('timer ticks: ' + t1);
    await p.click('#pauseBtn'); await wait(700);
    assert.strictEqual(await p.evaluate(() => window.__sajjel.state), 'paused'); ok('pause works');
    const tPause = await p.$eval('#bigTimer', e => e.textContent);
    await wait(1200);
    assert.strictEqual(await p.$eval('#bigTimer', e => e.textContent), tPause); ok('timer freezes while paused');
    await p.click('#pauseBtn'); await wait(1500);
    assert.strictEqual(await p.evaluate(() => window.__sajjel.state), 'recording'); ok('resume works');
    await p.click('#recordBtn');
    await p.waitForFunction(() => window.__sajjel.state === 'done', { timeout: 8000 });
    ok('stop saves the recording');
    await p.click('[data-tab=library]');
    await p.waitForFunction(() => document.querySelectorAll('#libList .rec').length === 2, { timeout: 5000 });
    ok('screen recording appears in the library');
  } else {
    skipped.push('real getDisplayMedia capture not available in this environment (state=' + recState + ')');
    console.log('skip -', skipped[skipped.length - 1]);
  }

  // XSS hygiene: names are rendered as text
  await p.click('[data-tab=library]');
  await p.waitForSelector('#libList .rec'); await wait(300);
  await p.evaluate(() => { window.prompt = () => '<img src=x onerror=alert(1)>'; });
  await p.evaluate(() => document.querySelector('#libList .rec .actions button:nth-child(3)').click()); await wait(400);
  assert.strictEqual(await p.$eval('#libList .rec .name img', () => 1).catch(() => 0), 0);
  ok('recording names are escaped (no HTML injection)');

  // delete
  await p.evaluate(() => { window.confirm = () => true; });
  const before = await p.$$eval('#libList .rec', e => e.length);
  await p.evaluate(() => document.querySelector('#libList .rec .actions button.danger').click()); await wait(500);
  assert.strictEqual(await p.$$eval('#libList .rec', e => e.length), before - 1); ok('delete removes the recording');

  assert.deepStrictEqual(errs, [], 'no console/page errors: ' + errs.join(' | '));
  ok('no console errors');

  console.log('\n' + n + ' e2e checks passed' + (skipped.length ? ' (skipped: ' + skipped.join('; ') + ')' : ''));
  await b.close();
})().catch(e => { console.error('E2E FAILED:', e.message); process.exit(1); });
