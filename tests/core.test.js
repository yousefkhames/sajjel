/* Unit tests for recorder-core.js and i18n.js. Run: npm test */
const assert = require('assert');
const C = require('../recorder-core.js');
const I = require('../i18n.js');

let n = 0;
function ok(name, fn) { fn(); n++; console.log('ok -', name); }

ok('pickMimeType prefers mp4 when supported', () => {
  const r = C.pickMimeType(() => true);
  assert.strictEqual(r.ext, 'mp4');
  assert(r.mimeType.includes('avc1'));
});
ok('pickMimeType falls back through the list', () => {
  const r = C.pickMimeType(m => m === 'video/webm;codecs=vp8,opus');
  assert.strictEqual(r.mimeType, 'video/webm;codecs=vp8,opus');
  assert.strictEqual(r.ext, 'webm');
});
ok('pickMimeType returns null when nothing is supported', () => {
  assert.strictEqual(C.pickMimeType(() => false), null);
});
ok('extForMime maps mp4 and webm', () => {
  assert.strictEqual(C.extForMime('video/mp4;codecs=avc1'), 'mp4');
  assert.strictEqual(C.extForMime('video/webm;codecs=vp9'), 'webm');
  assert.strictEqual(C.extForMime(undefined), 'webm');
});
ok('videoConstraints respects quality and fps', () => {
  const hd = C.videoConstraints('hd', 30);
  assert.strictEqual(hd.width.ideal, 1280);
  assert.strictEqual(hd.frameRate.max, 30);
  const src = C.videoConstraints('source', 60);
  assert.strictEqual(src.width, undefined);
  assert.strictEqual(src.frameRate.ideal, 60);
  const bad = C.videoConstraints('nope', 15);
  assert.strictEqual(bad.width, undefined); // unknown quality falls back to source
});
ok('videoBitsPerSecond uses presets with balanced default', () => {
  assert.strictEqual(C.videoBitsPerSecond('saver'), 1500000);
  assert.strictEqual(C.videoBitsPerSecond('crisp'), 9000000);
  assert.strictEqual(C.videoBitsPerSecond('whatever'), 4500000);
});
ok('estimateSize computes bytes from bitrate', () => {
  assert.strictEqual(C.estimateSize(8000000, 10), 10000000); // 1 MB/s * 10s
  assert.strictEqual(C.estimateSize(8000000, 0), 0);
  assert.strictEqual(C.estimateSize(8000000, -5), 0);
});
ok('formatDuration formats mm:ss and h:mm:ss', () => {
  assert.strictEqual(C.formatDuration(0), '00:00');
  assert.strictEqual(C.formatDuration(999), '00:00');
  assert.strictEqual(C.formatDuration(65000), '01:05');
  assert.strictEqual(C.formatDuration(3600000), '1:00:00');
  assert.strictEqual(C.formatDuration(3723000), '1:02:03');
  assert.strictEqual(C.formatDuration(-100), '00:00');
});
ok('formatDurationLocalized uses Eastern Arabic digits for ar', () => {
  assert.strictEqual(C.formatDurationLocalized(65000, 'ar'), '٠١:٠٥');
  assert.strictEqual(C.formatDurationLocalized(65000, 'en'), '01:05');
});
ok('formatBytes scales units', () => {
  assert.strictEqual(C.formatBytes(0), '0 B');
  assert.strictEqual(C.formatBytes(512), '512 B');
  assert.strictEqual(C.formatBytes(2048), '2 KB');
  assert.strictEqual(C.formatBytes(1536000), '1.5 MB');
  assert.strictEqual(C.formatBytes(3 * 1024 ** 3), '3 GB');
});
ok('makeFilename is filesystem-safe and uses local time', () => {
  const f = C.makeFilename(new Date(2026, 10, 26, 9, 5, 3), 'mp4');
  assert.strictEqual(f, 'sajjel-2026-11-26-09-05-03.mp4');
  assert(!/[\\/:*?"<>| ]/.test(f));
});
ok('state machine: happy path idle->starting->recording->saving->done->idle', () => {
  let s = 'idle';
  s = C.transition(s, 'start'); assert.strictEqual(s, 'starting');
  s = C.transition(s, 'ready'); assert.strictEqual(s, 'recording');
  s = C.transition(s, 'stop'); assert.strictEqual(s, 'saving');
  s = C.transition(s, 'saved'); assert.strictEqual(s, 'done');
  s = C.transition(s, 'reset'); assert.strictEqual(s, 'idle');
});
ok('state machine: pause and resume only while recording', () => {
  assert.strictEqual(C.transition('recording', 'pause'), 'paused');
  assert.strictEqual(C.transition('paused', 'resume'), 'recording');
  assert.strictEqual(C.transition('paused', 'pause'), null);
  assert.strictEqual(C.transition('idle', 'pause'), null);
  assert.strictEqual(C.transition('saving', 'pause'), null);
});
ok('state machine: picker cancel and user ending share are handled', () => {
  assert.strictEqual(C.transition('starting', 'cancel'), 'idle');
  assert.strictEqual(C.transition('starting', 'fail'), 'error');
  assert.strictEqual(C.transition('recording', 'ended'), 'saving');
  assert.strictEqual(C.transition('paused', 'ended'), 'saving');
  assert.strictEqual(C.transition('error', 'reset'), 'idle');
});
ok('state machine: invalid events return null', () => {
  assert.strictEqual(C.transition('idle', 'stop'), null);
  assert.strictEqual(C.transition('done', 'pause'), null);
  assert.strictEqual(C.transition('bogus', 'start'), null);
});
ok('canRecord and isActive match the flow', () => {
  assert(C.canRecord('idle') && C.canRecord('done'));
  assert(!C.canRecord('recording') && !C.canRecord('starting'));
  assert(C.isActive('recording') && C.isActive('paused') && C.isActive('saving'));
  assert(!C.isActive('idle') && !C.isActive('done'));
});
ok('elapsed excludes paused spans', () => {
  const t0 = 100000;
  // started at t0, paused t0+1000..t0+3000, now t0+10000 -> 8s
  assert.strictEqual(C.elapsed(t0, [[t0 + 1000, t0 + 3000]], null, t0 + 10000), 8000);
  // currently paused since t0+8000, now t0+10000 -> 8s - 2s = 6s... compute: total 10s, spans 2s, pausedSince 2s -> 6s
  assert.strictEqual(C.elapsed(t0, [[t0 + 1000, t0 + 3000]], t0 + 8000, t0 + 10000), 6000);
  assert.strictEqual(C.elapsed(null, [], null, t0), 0);
  assert(C.elapsed(t0, [], null, t0 - 5000) >= 0); // clock skew never negative
});
ok('i18n: en and ar define the same keys, all non-empty', () => {
  const en = Object.keys(I.STRINGS.en), ar = Object.keys(I.STRINGS.ar);
  assert.strictEqual(en.length, ar.length);
  en.forEach(k => {
    assert(ar.includes(k), 'missing ar key ' + k);
    assert(I.STRINGS.en[k].trim() && I.STRINGS.ar[k].trim(), 'empty string ' + k);
  });
});
ok('i18n: t() falls back to en for unknown lang, key for unknown key', () => {
  assert.strictEqual(I.t('fr', 'record'), I.STRINGS.en.record);
  assert.strictEqual(I.t('en', 'no_such_key'), 'no_such_key');
});

// Randomized state-machine fuzz: after any legal path, reset from done/error reaches idle.
ok('state machine fuzz: 500 random walks stay consistent', () => {
  const events = ['start', 'ready', 'cancel', 'fail', 'pause', 'resume', 'stop', 'ended', 'saved', 'reset'];
  let seed = 42;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let run = 0; run < 500; run++) {
    let s = 'idle';
    for (let i = 0; i < 20; i++) {
      const e = events[Math.floor(rnd() * events.length)];
      const next = C.transition(s, e);
      if (next !== null) {
        s = next;
        assert(Object.keys({ idle:1, starting:1, recording:1, paused:1, saving:1, done:1, error:1 }).includes(s));
      } else {
        assert.strictEqual(C.transition(s, e), null); // deterministic
      }
    }
    if (s === 'done' || s === 'error') assert.strictEqual(C.transition(s, 'reset'), 'idle');
  }
});

console.log('\n' + n + ' tests passed');
