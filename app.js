/* Sajjel app: UI + recording orchestration.
   Logic that does not need the DOM lives in recorder-core.js (SajjelCore). */
(function () {
  'use strict';
  var C = window.SajjelCore;
  var I = window.SajjelI18n;
  var DB = window.SajjelDB;

  var SETTINGS_KEY = 'sajjel.settings.v1';
  var defaults = { lang: 'ar', quality: 'source', fps: 30, bitrate: 'balanced', mic: false, sysAudio: true, countdown: false };
  var settings = loadSettings();

  var state = 'idle';          // state machine state
  // closing or reloading the tab while recording would lose the clip: ask the browser to confirm
  window.addEventListener('beforeunload', function (e) { if (state === 'recording' || state === 'paused') { e.preventDefault(); e.returnValue = ''; } });
  var stream = null;           // display stream
  var micStream = null;
  var audioCtx = null;
  var recorder = null;
  var chunks = [];
  var mimePick = null;
  var startedAt = null;
  var pausedSince = null;
  var pausedSpans = [];
  var tickHandle = null;
  var lastBlobUrl = null;

  var $ = function (id) { return document.getElementById(id); };

  /* ---------------- settings ---------------- */
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, defaults);
      var s = JSON.parse(raw);
      var out = Object.assign({}, defaults);
      Object.keys(defaults).forEach(function (k) { if (s[k] !== undefined) out[k] = s[k]; });
      return out;
    } catch (e) { return Object.assign({}, defaults); }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  /* ---------------- i18n ---------------- */
  function t(key) { return I.t(settings.lang, key); }
  function applyLang() {
    document.documentElement.lang = settings.lang;
    document.documentElement.dir = settings.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = settings.lang === 'ar'
      ? 'سجّل — سجّل شاشتك من المتصفح'
      : 'Sajjel — Screen recorder in your browser';
    document.querySelectorAll('[data-i]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i')); });
    $('brandName').textContent = t('appName');
    $('brandTag').textContent = t('tagline');
    $('heroTitle').textContent = t('heroTitle');
    $('heroSub').textContent = t('heroSub');
    $('langBtn').textContent = t('langBtn');
    $('recordBtn').setAttribute('aria-label', t('record'));
    if (state === 'idle' || state === 'done') $('bigTimer').textContent = C.formatDuration(0);
    updateControls();
    renderLibrary();
  }

  /* ---------------- support check ---------------- */
  function supportProblem() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') return 'unsupported';
    if (typeof window.MediaRecorder !== 'function') return 'noRecorder';
    return null;
  }

  /* ---------------- status ---------------- */
  function setStatus(key, kind) {
    var el = $('statusLine');
    el.textContent = key ? t(key) : '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  /* ---------------- state machine ---------------- */
  function go(event) {
    var next = C.transition(state, event);
    if (!next) return false;
    state = next;
    updateControls();
    return true;
  }

  function updateControls() {
    var rec = $('recordBtn');
    var active = C.isActive(state);
    rec.classList.toggle('recording', state === 'recording' || state === 'paused');
    rec.disabled = state === 'starting' || state === 'saving';
    $('bigTimer').classList.toggle('live', state === 'recording');
    $('pauseBtn').hidden = !(state === 'recording' || state === 'paused');
    $('pausedChip').hidden = state !== 'paused';
    $('onair').hidden = !(state === 'recording' || state === 'paused');
    $('pauseLabel').textContent = state === 'paused' ? t('resume') : t('pause');
    $('pauseIcon').setAttribute('d', state === 'paused' ? 'M8 5v14l11-7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
    $('recordBtn').setAttribute('aria-label', active ? t('stop') : t('record'));
    if (!active) { $('preview').hidden = true; $('stageHint').hidden = false; }
  }

  /* ---------------- recording ---------------- */
  function buildAudioTrack(displayStream) {
    var tracks = [];
    displayStream.getAudioTracks().forEach(function (tr) { tracks.push(tr); });
    if (!settings.mic) return Promise.resolve(tracks);
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
      .then(function (mic) {
        micStream = mic;
        if (tracks.length) {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          var dest = audioCtx.createMediaStreamDestination();
          audioCtx.createMediaStreamSource(new MediaStream(tracks)).connect(dest);
          audioCtx.createMediaStreamSource(mic).connect(dest);
          return dest.stream.getAudioTracks();
        }
        return mic.getAudioTracks();
      })
      .catch(function () {
        setStatus('errMic', 'err');
        return tracks;
      });
  }

  function startRecording() {
    if (!go('start')) return;
    setStatus('starting');
    var problem = supportProblem();
    if (problem) { setStatus(problem, 'err'); go('cancel'); return; }
    mimePick = C.pickMimeType(function (m) { return MediaRecorder.isTypeSupported(m); });
    if (!mimePick) { setStatus('noRecorder', 'err'); go('cancel'); return; }

    navigator.mediaDevices.getDisplayMedia({
      video: C.videoConstraints(settings.quality, settings.fps),
      audio: settings.sysAudio
    }).then(function (s) {
      stream = s;
      return buildAudioTrack(s).then(function (audioTracks) {
        var merged = new MediaStream(s.getVideoTracks());
        audioTracks.forEach(function (tr) { merged.addTrack(tr); });
        return merged;
      });
    }).then(function (merged) {
      return runCountdown().then(function () { return merged; });
    }).then(function (merged) {
      if (state !== 'starting') { stopTracks(); return; }
      chunks = [];
      recorder = new MediaRecorder(merged, {
        mimeType: mimePick.mimeType,
        videoBitsPerSecond: C.videoBitsPerSecond(settings.bitrate)
      });
      recorder.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
      recorder.onstop = onRecorderStop;
      recorder.onerror = function () { go('fail'); setStatus('errGeneric', 'err'); cleanupCapture(); };
      var videoTrack = merged.getVideoTracks()[0];
      if (videoTrack) videoTrack.addEventListener('ended', function () { if (state === 'recording' || state === 'paused') stopRecording(); });

      startedAt = Date.now();
      pausedSince = null;
      pausedSpans = [];
      recorder.start(1000);
      go('ready');
      setStatus(null);
      $('preview').srcObject = stream;
      $('preview').hidden = false;
      $('stageHint').hidden = true;
      $('preview').play().catch(function () {});
      $('estLine').hidden = false;
      tickHandle = setInterval(tick, 250);
      tick();
    }).catch(function (err) {
      try { window.__sajjelError = { name: err && err.name, message: err && String(err.message || err) }; } catch (e) {}
      cleanupCapture();
      if (state === 'starting') go('cancel');
      else if (C.isActive(state)) go('fail');
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) setStatus('errPermission', 'err');
      else if (err && (err.name === 'NotReadableError' || err.name === 'AbortError')) setStatus('errDevice', 'err');
      else setStatus('errGeneric', 'err');
    });
  }

  function runCountdown() {
    if (!settings.countdown) return Promise.resolve();
    var overlay = $('countOverlay');
    overlay.hidden = false;
    var nums = settings.lang === 'ar' ? ['٣', '٢', '١'] : ['3', '2', '1'];
    return new Promise(function (resolve) {
      var i = 0;
      (function next() {
        if (state !== 'starting' || i >= nums.length) { overlay.hidden = true; resolve(); return; }
        overlay.textContent = nums[i++];
        setTimeout(next, 850);
      })();
    });
  }

  function tick() {
    var ms = C.elapsed(startedAt, pausedSpans, pausedSince, Date.now());
    var txt = C.formatDuration(ms); // tabular Latin digits: always covered by tabular fonts
    $('bigTimer').textContent = txt;
    $('onairTime').textContent = txt;
    var est = C.estimateSize(C.videoBitsPerSecond(settings.bitrate), ms / 1000);
    var line = $('estLine');
    line.textContent = '';
    line.appendChild(document.createTextNode(t('estSize') + ' '));
    var bdi = document.createElement('bdi');
    bdi.textContent = C.formatBytes(est);
    line.appendChild(bdi);
  }

  function pauseResume() {
    if (state === 'recording') {
      try { recorder.pause(); } catch (e) {}
      pausedSince = Date.now();
      go('pause');
    } else if (state === 'paused') {
      try { recorder.resume(); } catch (e) {}
      pausedSpans.push([pausedSince, Date.now()]);
      pausedSince = null;
      go('resume');
    }
    tick();
  }

  function stopRecording() {
    if (!(state === 'recording' || state === 'paused')) return;
    go(state === 'paused' ? 'stop' : 'stop');
    setStatus('saving');
    clearInterval(tickHandle);
    if (pausedSince != null) { pausedSpans.push([pausedSince, Date.now()]); pausedSince = null; }
    try { recorder.stop(); } catch (e) { onRecorderStop(); }
  }

  function onRecorderStop() {
    var durationMs = C.elapsed(startedAt, pausedSpans, null, Date.now());
    var blob = new Blob(chunks, { type: mimePick.mimeType.split(';')[0] });
    cleanupCapture();
    $('preview').srcObject = null;
    if (!blob.size) {
      go('fail'); setStatus('errGeneric', 'err');
      return;
    }
    saveRecording(blob, durationMs).then(function () {
      if (state === 'saving') go('saved');
      setStatus('saved', 'ok');
    }).catch(function () {
      // IndexedDB failed: do not lose the video, offer the download directly.
      if (state === 'saving') go('saved');
      setStatus('errSave', 'err');
      triggerDownload(blob, C.makeFilename(new Date(), mimePick.ext));
    });
    $('bigTimer').classList.remove('live');
  }

  function cleanupCapture() {
    stopTracks();
    if (audioCtx) { audioCtx.close().catch(function () {}); audioCtx = null; }
    recorder = null;
    $('estLine').hidden = true;
    $('preview').hidden = true;
    $('stageHint').hidden = false;
  }
  function stopTracks() {
    if (stream) { stream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) {} }); stream = null; }
    if (micStream) { micStream.getTracks().forEach(function (tr) { try { tr.stop(); } catch (e) {} }); micStream = null; }
  }

  function saveRecording(blob, durationMs) {
    var now = new Date();
    var rec = {
      id: 'rec-' + now.getTime() + '-' + Math.floor(Math.random() * 1e6),
      name: t('untitled') + ' ' + C.formatDuration(durationMs),
      createdAt: now.getTime(),
      durationMs: durationMs,
      size: blob.size,
      mimeType: blob.type,
      ext: C.extForMime(mimePick.mimeType),
      thumb: null,
      blob: blob
    };
    return makeThumb(blob).then(function (thumb) {
      rec.thumb = thumb;
      return DB.put(rec);
    }).then(function () {
      $('bigTimer').textContent = C.formatDuration(0);
      renderLibrary();
    });
  }

  function makeThumb(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob);
      var v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      var done = function (val) { URL.revokeObjectURL(url); resolve(val); };
      var timer = setTimeout(function () { done(null); }, 4000);
      v.onloadeddata = function () { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
      v.onseeked = function () {
        clearTimeout(timer);
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 192; canvas.height = 120;
          canvas.getContext('2d').drawImage(v, 0, 0, 192, 120);
          done(canvas.toDataURL('image/jpeg', 0.7));
        } catch (e) { done(null); }
      };
      v.onerror = function () { clearTimeout(timer); done(null); };
      v.src = url;
    });
  }

  /* ---------------- downloads ---------------- */
  function triggerDownload(blob, filename) {
    if (lastBlobUrl) URL.revokeObjectURL(lastBlobUrl);
    lastBlobUrl = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = lastBlobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* ---------------- library ---------------- */
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.toLocaleDateString(settings.lang === 'ar' ? 'ar-EG' : 'en-GB', { day: 'numeric', month: 'short' }) +
      ' ' + d.toLocaleTimeString(settings.lang === 'ar' ? 'ar-EG' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
  }

  function renderLibrary() {
    DB.all().then(function (rows) {
      var list = $('libList');
      list.textContent = '';
      $('libEmpty').hidden = rows.length > 0;
      var badge = $('libCount');
      badge.hidden = rows.length === 0;
      badge.textContent = rows.length;
      var total = 0;
      rows.forEach(function (r) { total += r.size || 0; list.appendChild(recCard(r)); });
      $('storageVal').textContent = C.formatBytes(total);
      if (navigator.storage && navigator.storage.estimate) {
        navigator.storage.estimate().then(function (est) {
          var quota = est.quota || 0;
          var pct = quota ? Math.min(100, Math.round((est.usage || 0) / quota * 100)) : 0;
          $('meterFill').style.width = Math.max(1, pct) + '%';
        }).catch(function () {});
      } else {
        $('meterFill').style.width = total ? '8%' : '1%';
      }
    }).catch(function () {});
  }

  function recCard(r) {
    var card = document.createElement('div');
    card.className = 'rec';
    card.dataset.id = r.id;

    var thumb = document.createElement('div');
    thumb.className = 'thumb';
    if (r.thumb) thumb.style.backgroundImage = 'url(' + r.thumb + ')';
    var dur = document.createElement('span');
    dur.className = 'dur';
    dur.textContent = C.formatDurationLocalized(r.durationMs, settings.lang);
    thumb.appendChild(dur);

    var meta = document.createElement('div');
    meta.className = 'meta';
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = r.name;
    var sub = document.createElement('div');
    sub.className = 'sub';
    var bdiSize = document.createElement('bdi');
    bdiSize.textContent = C.formatBytes(r.size);
    var bdiExt = document.createElement('bdi');
    bdiExt.textContent = r.ext.toUpperCase();
    sub.appendChild(document.createTextNode(fmtDate(r.createdAt) + ' · '));
    sub.appendChild(bdiSize);
    sub.appendChild(document.createTextNode(' · '));
    sub.appendChild(bdiExt);
    var actions = document.createElement('div');
    actions.className = 'actions';

    var dl = document.createElement('button');
    dl.className = 'primary';
    dl.type = 'button';
    dl.textContent = t('download');
    dl.addEventListener('click', function () { triggerDownload(r.blob, safeFileName(r.name, r.ext)); });

    var play = document.createElement('button');
    play.type = 'button';
    play.textContent = t('play');
    play.addEventListener('click', function () {
      var dlg = $('playerDialog');
      $('dlgTitle').textContent = r.name;
      var v = $('playerVideo');
      v.src = URL.createObjectURL(r.blob);
      if (dlg.showModal) dlg.showModal(); else dlg.setAttribute('open', '');
    });

    var ren = document.createElement('button');
    ren.type = 'button';
    ren.textContent = t('rename');
    ren.addEventListener('click', function () {
      var n = window.prompt(t('renamePrompt'), r.name);
      if (n && n.trim()) {
        r.name = n.trim().slice(0, 120);
        DB.put(r).then(renderLibrary);
      }
    });

    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'danger';
    del.textContent = t('del');
    del.addEventListener('click', function () {
      if (window.confirm(t('confirmDelete'))) DB.remove(r.id).then(renderLibrary);
    });

    actions.appendChild(dl); actions.appendChild(play); actions.appendChild(ren); actions.appendChild(del);
    meta.appendChild(name); meta.appendChild(sub); meta.appendChild(actions);
    card.appendChild(thumb); card.appendChild(meta);
    return card;
  }

  function safeFileName(name, ext) {
    var base = String(name || 'sajjel').replace(/[\\/:*?"<>|]/g, '-').slice(0, 80);
    return base + '.' + ext;
  }

  /* ---------------- demo clip ---------------- */
  // Generates a real 3-second WebM in-page (canvas -> captureStream -> MediaRecorder),
  // so the library and downloads can be tried without sharing a screen.
  function makeDemoClip() {
    var canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 400;
    var ctx = canvas.getContext('2d');
    var pick = C.pickMimeType(function (m) { return MediaRecorder.isTypeSupported(m) && m.indexOf('webm') !== -1; })
      || C.pickMimeType(function (m) { return MediaRecorder.isTypeSupported(m); });
    if (!pick || !canvas.captureStream) { setStatus('errGeneric', 'err'); return; }
    var stream2 = canvas.captureStream(30);
    var rec = new MediaRecorder(stream2, { mimeType: pick.mimeType, videoBitsPerSecond: 2000000 });
    var parts = [];
    rec.ondataavailable = function (e) { if (e.data.size) parts.push(e.data); };
    rec.onstop = function () {
      stream2.getTracks().forEach(function (tr) { tr.stop(); });
      var blob = new Blob(parts, { type: pick.mimeType.split(';')[0] });
      var wasMime = mimePick; mimePick = pick;
      saveRecording(blob, 3000).then(function () { mimePick = wasMime; setStatus(null); });
    };
    var t0 = performance.now();
    (function draw() {
      var el = (performance.now() - t0) / 1000;
      ctx.fillStyle = '#0d0f12'; ctx.fillRect(0, 0, 640, 400);
      ctx.strokeStyle = '#2a2f36';
      for (var x = 0; x < 640; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 400); ctx.stroke(); }
      ctx.fillStyle = '#ff4d42';
      ctx.beginPath(); ctx.arc(320 + Math.sin(el * 2) * 200, 200 + Math.cos(el * 3) * 100, 34, 0, 7); ctx.fill();
      ctx.fillStyle = '#e8eaed'; ctx.font = 'bold 44px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('Sajjel', 320, 90);
      ctx.fillStyle = '#f5a524'; ctx.font = 'bold 30px system-ui';
      ctx.fillText(el.toFixed(1) + 's', 320, 350);
      if (el < 3) requestAnimationFrame(draw); else rec.stop();
    })();
    rec.start(500);
  }

  /* ---------------- tabs ---------------- */
  document.querySelectorAll('.tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.tab').forEach(function (b) { b.classList.toggle('on', b === btn); });
      document.querySelectorAll('.pane').forEach(function (p) { p.classList.remove('on'); });
      $('pane-' + btn.dataset.tab).classList.add('on');
      if (btn.dataset.tab === 'library') renderLibrary();
    });
  });

  /* ---------------- settings widgets ---------------- */
  function bindSeg(id, key, parse) {
    var seg = $(id);
    function paint() {
      seg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', (parse ? parse(b.dataset.v) : b.dataset.v) === settings[key]);
      });
    }
    seg.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      settings[key] = parse ? parse(b.dataset.v) : b.dataset.v;
      saveSettings(); paint();
    });
    paint();
  }
  bindSeg('qualitySeg', 'quality');
  bindSeg('fpsSeg', 'fps', Number);
  bindSeg('bitrateSeg', 'bitrate');

  function bindSwitch(id, key) {
    var sw = $(id);
    sw.checked = !!settings[key];
    sw.addEventListener('change', function () { settings[key] = sw.checked; saveSettings(); });
  }
  bindSwitch('micSw', 'mic');
  bindSwitch('sysSw', 'sysAudio');
  bindSwitch('countSw', 'countdown');

  /* ---------------- wiring ---------------- */
  $('recordBtn').addEventListener('click', function () {
    if (state === 'recording' || state === 'paused') stopRecording();
    else if (C.canRecord(state)) startRecording();
  });
  $('pauseBtn').addEventListener('click', pauseResume);
  $('langBtn').addEventListener('click', function () {
    settings.lang = settings.lang === 'ar' ? 'en' : 'ar';
    saveSettings(); applyLang();
  });
  $('demoBtn').addEventListener('click', makeDemoClip);
  $('dlgClose').addEventListener('click', function () {
    var v = $('playerVideo');
    v.pause(); v.removeAttribute('src'); v.load();
    $('playerDialog').close();
  });

  var problem = supportProblem();
  if (problem) {
    var n = $('unsupported');
    n.hidden = false;
    n.textContent = t(problem);
  }

  applyLang();
  updateControls();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }

  // Test/debug introspection (used by tests/e2e.js).
  window.__sajjel = {
    get state() { return state; },
    settings: settings,
    core: C,
    makeDemoClip: makeDemoClip,
    listRecordings: function () { return DB.all(); }
  };
})();
