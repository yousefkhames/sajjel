/* Sajjel core: pure recording logic. No DOM, no browser APIs.
   Used by app.js in the browser and by tests/core.test.js in Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SajjelCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- MIME type selection ------------------------------------------ */
  // Ordered by preference. MP4 first because it plays everywhere
  // (QuickTime, Windows Media Player, phones) without conversion.
  var MIME_CANDIDATES = [
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' }
  ];

  // isSupported: function(mime) -> boolean (MediaRecorder.isTypeSupported in the browser)
  function pickMimeType(isSupported) {
    for (var i = 0; i < MIME_CANDIDATES.length; i++) {
      if (isSupported(MIME_CANDIDATES[i].mime)) return { mimeType: MIME_CANDIDATES[i].mime, ext: MIME_CANDIDATES[i].ext };
    }
    return null; // caller must handle "no recorder support"
  }

  function extForMime(mimeType) {
    if (!mimeType) return 'webm';
    return mimeType.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
  }

  /* ---- Quality presets ---------------------------------------------- */
  var QUALITY = {
    hd:     { width: 1280, height: 720,  label: 'HD 720p' },
    fullhd: { width: 1920, height: 1080, label: 'Full HD 1080p' },
    source: { width: null, height: null, label: 'Source' }
  };
  var BITRATE = { saver: 1500000, balanced: 4500000, crisp: 9000000 };

  // MediaStreamTrack constraints for getDisplayMedia's video track.
  function videoConstraints(qualityKey, fps) {
    var q = QUALITY[qualityKey] || QUALITY.source;
    var c = { frameRate: { ideal: fps === 60 ? 60 : 30, max: fps === 60 ? 60 : 30 } };
    if (q.width) { c.width = { ideal: q.width }; c.height = { ideal: q.height }; }
    return c;
  }

  function videoBitsPerSecond(bitrateKey) {
    return BITRATE[bitrateKey] || BITRATE.balanced;
  }

  // Estimated file size in bytes for a recording of `seconds` at `bitsPerSecond`.
  function estimateSize(bitsPerSecond, seconds) {
    if (seconds <= 0) return 0;
    return Math.round((bitsPerSecond / 8) * seconds);
  }

  /* ---- Formatting ---------------------------------------------------- */
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // 0 -> "00:00", 65s -> "01:05", 1h2m3s -> "1:02:03"
  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var total = Math.floor(ms / 1000);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : pad2(m) + ':' + pad2(s);
  }

  // Localized digits for the Arabic UI (Eastern Arabic numerals).
  function formatDurationLocalized(ms, lang) {
    var t = formatDuration(ms);
    if (lang !== 'ar') return t;
    var eastern = '٠١٢٣٤٥٦٧٨٩';
    return t.replace(/[0-9]/g, function (d) { return eastern[+d]; });
  }

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) n = 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (Math.round(n / 102.4) / 10) + ' KB';
    if (n < 1024 * 1024 * 1024) return (Math.round(n / 104857.6) / 10) + ' MB';
    return (Math.round(n / 107374182.4) / 10) + ' GB';
  }

  // sajjel-2026-11-26-14-30-05 (local time, filesystem-safe)
  function makeFilename(date, ext) {
    var d = date instanceof Date ? date : new Date();
    var stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '-' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
    return 'sajjel-' + stamp + '.' + (ext || 'webm');
  }

  /* ---- Recorder state machine --------------------------------------- */
  // idle -> starting -> recording <-> paused -> saving -> done -> idle
  // Any failure lands in "error"; reset always returns to idle.
  var TRANSITIONS = {
    idle:      { start: 'starting' },
    starting:  { ready: 'recording', fail: 'error', cancel: 'idle' },
    recording: { pause: 'paused', stop: 'saving', fail: 'error', ended: 'saving' },
    paused:    { resume: 'recording', stop: 'saving', fail: 'error', ended: 'saving' },
    saving:    { saved: 'done', fail: 'error' },
    done:      { reset: 'idle', start: 'starting' },
    error:     { reset: 'idle' }
  };

  // Returns the next state, or null when the event is not allowed from `state`.
  function transition(state, event) {
    var row = TRANSITIONS[state];
    if (!row || !Object.prototype.hasOwnProperty.call(row, event)) return null;
    return row[event];
  }

  function canRecord(state) { return state === 'idle' || state === 'done'; }
  function isActive(state) { return state === 'recording' || state === 'paused' || state === 'starting' || state === 'saving'; }

  /* ---- Elapsed clock (pausable) -------------------------------------- */
  // Elapsed ms excluding paused spans. `now` is injected for tests.
  function elapsed(startedAt, pausedSpans, pausedSince, now) {
    if (startedAt == null) return 0;
    var total = now - startedAt;
    var paused = 0;
    for (var i = 0; i < pausedSpans.length; i++) paused += pausedSpans[i][1] - pausedSpans[i][0];
    if (pausedSince != null) paused += now - pausedSince;
    return Math.max(0, total - paused);
  }

  return {
    MIME_CANDIDATES: MIME_CANDIDATES,
    QUALITY: QUALITY,
    BITRATE: BITRATE,
    pickMimeType: pickMimeType,
    extForMime: extForMime,
    videoConstraints: videoConstraints,
    videoBitsPerSecond: videoBitsPerSecond,
    estimateSize: estimateSize,
    formatDuration: formatDuration,
    formatDurationLocalized: formatDurationLocalized,
    formatBytes: formatBytes,
    makeFilename: makeFilename,
    transition: transition,
    canRecord: canRecord,
    isActive: isActive,
    elapsed: elapsed
  };
});
