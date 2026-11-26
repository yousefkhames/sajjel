/* Sajjel library store: IndexedDB wrapper. Browser only. */
(function (root) {
  'use strict';
  var DB_NAME = 'sajjel';
  var STORE = 'recordings';

  function open() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function withStore(mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, mode);
        var out = fn(tx.objectStore(STORE));
        tx.oncomplete = function () { db.close(); resolve(out && out.result !== undefined ? out.result : out); };
        tx.onerror = function () { db.close(); reject(tx.error); };
      });
    });
  }

  // rec: {id, name, createdAt, durationMs, size, mimeType, ext, thumb (dataURL|null), blob}
  function put(rec) {
    return withStore('readwrite', function (s) { s.put(rec); }).then(function () { return rec.id; });
  }
  function all() {
    return withStore('readonly', function (s) { return s.getAll(); }).then(function (rows) {
      rows = rows || [];
      rows.sort(function (a, b) { return b.createdAt - a.createdAt; });
      return rows;
    });
  }
  function get(id) {
    return withStore('readonly', function (s) { return s.get(id); });
  }
  function remove(id) {
    return withStore('readwrite', function (s) { s.delete(id); });
  }

  root.SajjelDB = { put: put, all: all, get: get, remove: remove };
})(typeof self !== 'undefined' ? self : this);
