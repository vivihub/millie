/* Existing direct GAS webhook + queue transport. LINE signature verification is
 * unchanged from that transport; this adapter does not claim a verified request.
 * Deploy with executeAs=USER_DEPLOYING: owner-executed webhooks and installed
 * triggers then share UserLock, independently of Runtime's ScriptLock.
 * Install Runtime's schema and server-only gateway secret before setting READY. */
var MillieLegacy = (function () {
  'use strict';
  var HEADERS = ['timestamp', 'userId', 'text', 'status'];
  var META = ['millie_event_id', 'event_type', 'attempts', 'last_attempt_at'];
  var TRIGGER = 'MILLIE_QUEUE_TRIGGER_ID';
  var WORKER = 'MILLIE_QUEUE_WORKER';
  var DEFAULT_LINE = 'https://line.me/R/ti/p/@575kepfk';
  var RETRY_MS = 30000;
  var MAX_ATTEMPTS = 3;

  function json(value) {
    return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
  }
  function properties() { return PropertiesService.getScriptProperties(); }
  function hash(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8)
      .map(function (byte) { return ('0' + ((byte + 256) % 256).toString(16)).slice(-2); }).join('');
  }
  function millis(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return isFinite(value) ? value : NaN;
    return value ? Date.parse(String(value)) : NaN;
  }
  function validUser(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\u0000-\u001f\u007f]/.test(value);
  }
  function normalize(event, fallbackTime) {
    if (!event || !event.source || event.source.type !== 'user' || !validUser(event.source.userId)) return null;
    var type = event.type;
    var text = '';
    if (type === 'message') {
      if (!event.message || event.message.type !== 'text' || typeof event.message.text !== 'string' ||
          !event.message.text.length || event.message.text.length > 5000) return null;
      text = event.message.text;
    } else if (type !== 'follow' && type !== 'unfollow') return null;
    var originalTime = typeof event.timestamp === 'number' && isFinite(event.timestamp) ? event.timestamp : null;
    var timestamp = originalTime === null ? fallbackTime : originalTime;
    if (!isFinite(timestamp) || Math.abs(timestamp) > 8640000000000000) return null;
    var eventId = typeof event.webhookEventId === 'string' && event.webhookEventId.length > 0 &&
      event.webhookEventId.length <= 256 ? event.webhookEventId :
      'legacy-' + hash(JSON.stringify([type, originalTime, event.source.userId, text]));
    return { id: eventId, type: type, uid: event.source.userId, text: text, timestamp: timestamp };
  }
  function locked(fn) {
    var lock = LockService.getUserLock();
    if (!lock.tryLock(25000)) throw new Error('queue_busy');
    try { return fn(); } finally {
      // Commit the Spreadsheet service's write-back cache before another
      // webhook observes getLastRow() or a worker sees this row's claim.
      try { SpreadsheetApp.flush(); } finally { lock.releaseLock(); }
    }
  }
  function literal(value) { return typeof value === 'string' && /^[=']/.test(value) ? "'" + value : value; }
  function grid(sheet, rows, columns) {
    if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
    if (sheet.getMaxColumns() < columns) sheet.insertColumnsAfter(sheet.getMaxColumns(), columns - sheet.getMaxColumns());
  }
  function queue(props) {
    var id = props.getProperty('SPREADSHEET_ID');
    if (!id) throw new Error('spreadsheet_not_configured');
    var book = SpreadsheetApp.openById(id);
    var sheet = book.getSheetByName('queue') || book.insertSheet('queue');
    if (!sheet.getLastRow()) {
      grid(sheet, 1, HEADERS.length);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    }
    var width = Math.max(HEADERS.length, sheet.getLastColumn());
    var headers = sheet.getRange(1, 1, 1, width).getValues()[0];
    HEADERS.forEach(function (header, index) {
      if (headers[index] !== header) throw new Error('invalid_queue_headers');
    });
    var missing = [];
    META.forEach(function (header) {
      if (headers.indexOf(header) < 0) missing.push(header);
      else if (headers.indexOf(header) !== headers.lastIndexOf(header)) throw new Error('duplicate_queue_metadata');
    });
    if (missing.length) {
      grid(sheet, 1, width + missing.length);
      sheet.getRange(1, width + 1, 1, missing.length).setValues([missing]);
      headers = headers.concat(missing);
      width += missing.length;
    }
    var columns = {};
    META.forEach(function (header) { columns[header] = headers.indexOf(header) + 1; });
    return { sheet: sheet, width: width, columns: columns };
  }
  function removeOwnTrigger(props) {
    var own = props.getProperty(TRIGGER);
    if (!own) return;
    ScriptApp.getProjectTriggers().forEach(function (trigger) {
      if (trigger.getUniqueId() === own) ScriptApp.deleteTrigger(trigger);
    });
    props.deleteProperty(TRIGGER);
  }
  function scheduleLocked(props, delay) {
    var own = props.getProperty(TRIGGER);
    if (own && ScriptApp.getProjectTriggers().some(function (trigger) { return trigger.getUniqueId() === own; })) return false;
    var trigger = ScriptApp.newTrigger('processQueue').timeBased().after(Math.max(1000, delay || 1000)).create();
    props.setProperty(TRIGGER, trigger.getUniqueId());
    return true;
  }
  function schedule(delay) { return locked(function () { return scheduleLocked(properties(), delay); }); }
  function enqueue(events) {
    if (!events.length) return { ok: true, queued: 0 };
    return locked(function () {
      var props = properties();
      var store = queue(props);
      var rows = events.map(function (event) {
        var row = new Array(store.width).fill('');
        row[0] = new Date(event.timestamp).toISOString();
        row[1] = literal(event.uid);
        row[2] = literal(event.text);
        row[3] = 'pending';
        row[store.columns.millie_event_id - 1] = literal(event.id);
        row[store.columns.event_type - 1] = event.type;
        row[store.columns.attempts - 1] = 0;
        return row;
      });
      var next = store.sheet.getLastRow() + 1;
      grid(store.sheet, next + rows.length - 1, store.width);
      store.sheet.getRange(next, 1, rows.length, store.width).setValues(rows);
      scheduleLocked(props, 1000);
      return { ok: true, queued: rows.length };
    });
  }
  function receive(e) {
    try {
      var raw = e && e.postData && e.postData.contents;
      if (typeof raw !== 'string' || Utilities.newBlob(raw).getBytes().length > 256 * 1024) return json({ ok: false, error: 'invalid_body' });
      var body;
      try { body = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'invalid_json' }); }
      if (!body || !Array.isArray(body.events) || body.events.length > 100) return json({ ok: false, error: 'invalid_events' });
      var now = Date.now();
      var events = body.events.map(function (event) { return normalize(event, now); }).filter(function (event) { return !!event; });
      return json(enqueue(events));
    } catch (_) { return json({ ok: false, error: 'queue_unavailable' }); }
  }
  function compat(uid, text, type) {
    var now = Date.now();
    var event = normalize({ type: type, timestamp: now, source: { type: 'user', userId: uid }, message: { type: 'text', text: text } }, now);
    return event ? enqueue([event]) : { ok: false, error: 'invalid_event' };
  }
  function update(store, row, column, value) { store.sheet.getRange(row, column).setValues([[literal(value)]]); }
  function rows(store) {
    var count = store.sheet.getLastRow() - 1;
    return count > 0 ? store.sheet.getRange(2, 1, count, store.width).getValues() : [];
  }
  function oldPending(row, columns, installed) {
    if (row[3] !== 'pending' || row[columns.millie_event_id - 1]) return false;
    var created = millis(row[0]);
    // Missing dates cannot establish that a pre-v10 backlog is safe to send.
    return isFinite(installed) && (!isFinite(created) || created < installed - 10 * 60000);
  }
  function claim(props, now, deadline) {
    var store = queue(props);
    var values = rows(store);
    var c = store.columns;
    var installed = millis(props.getProperty('MILLIE_V10_INSTALLED_AT'));
    var nextDelay = null;
    for (var i = 0; i < values.length; i += 1) {
      if (Date.now() >= deadline) return { delay: 1000 };
      var row = values[i];
      if (oldPending(row, c, installed)) { update(store, i + 2, 4, 'legacy_pending'); continue; }
      if (row[3] !== 'pending' && row[3] !== 'processing') continue;
      var attempts = Math.max(0, Number(row[c.attempts - 1]) || 0);
      if (attempts >= MAX_ATTEMPTS) { update(store, i + 2, 4, 'failed'); continue; }
      var lastAttempt = millis(row[c.last_attempt_at - 1]);
      var wait = attempts && isFinite(lastAttempt) ? lastAttempt + RETRY_MS - now : 0;
      if (wait > 0) { nextDelay = nextDelay === null ? wait : Math.min(nextDelay, wait); continue; }
      var type = row[c.event_type - 1] || (row[2] === '__follow__' ? 'follow' : 'message');
      var event = normalize({ type: type, timestamp: millis(row[0]), webhookEventId: row[c.millie_event_id - 1],
        source: { type: 'user', userId: row[1] }, message: { type: 'text', text: row[2] } }, now);
      if (!event) { update(store, i + 2, 4, 'failed'); continue; }
      // Persist the same id before any Runtime call, including migrated rows.
      update(store, i + 2, c.millie_event_id, event.id);
      update(store, i + 2, c.event_type, event.type);
      update(store, i + 2, c.attempts, attempts + 1);
      update(store, i + 2, c.last_attempt_at, new Date(now).toISOString());
      update(store, i + 2, 4, 'processing');
      return { row: i + 2, id: event.id, attempt: attempts + 1, event: event };
    }
    return { delay: nextDelay };
  }
  function finish(props, task, success) {
    var store = queue(props);
    var row = store.sheet.getRange(task.row, 1, 1, store.width).getValues()[0];
    if (row[store.columns.millie_event_id - 1] === task.id && row[3] === 'processing' &&
        Number(row[store.columns.attempts - 1]) === task.attempt) {
      update(store, task.row, 4, success ? 'done' : task.attempt >= MAX_ATTEMPTS ? 'failed' : 'pending');
    }
  }
  function workDelay(props, now) {
    var store = queue(props);
    var c = store.columns;
    var delay = null;
    rows(store).forEach(function (row) {
      if (row[3] !== 'pending' && row[3] !== 'processing') return;
      var last = millis(row[c.last_attempt_at - 1]);
      var wait = Number(row[c.attempts - 1]) && isFinite(last) ? Math.max(1000, last + RETRY_MS - now) : 1000;
      delay = delay === null ? wait : Math.min(delay, wait);
    });
    return delay;
  }
  function process() {
    var props = properties();
    var token = String(Date.now()) + ':' + String(Math.random());
    var owns = false;
    var start = Date.now();
    try {
      owns = locked(function () {
        removeOwnTrigger(props);
        if (props.getProperty('MILLIE_V10_READY') !== 'true') return false;
        var current;
        try { current = JSON.parse(props.getProperty(WORKER) || 'null'); } catch (_) {}
        if (current && current.until > start) return false;
        props.setProperty(WORKER, JSON.stringify({ token: token, until: start + 300000 }));
        return true;
      });
      if (!owns) return;
      var count = 0;
      while (count < 20 && Date.now() - start < 240000) {
        if (props.getProperty('MILLIE_V10_READY') !== 'true') break;
        var task = locked(function () { return claim(props, Date.now(), start + 240000); });
        if (!task.event) break;
        count += 1;
        var event = { type: task.event.type, timestamp: task.event.timestamp, webhookEventId: task.id,
          source: { type: 'user', userId: task.event.uid } };
        if (event.type === 'message') event.message = { type: 'text', text: task.event.text };
        var success = false;
        try {
          // Runtime takes its separate ScriptLock. No queue UserLock is held here.
          success = JSON.parse(MillieRuntime.receivePushEvents([event]).getContent()).ok === true;
        } catch (_) {}
        locked(function () { finish(props, task, success); });
      }
    } finally {
      if (owns) locked(function () {
        var current;
        try { current = JSON.parse(props.getProperty(WORKER) || 'null'); } catch (_) {}
        if (current && current.token === token) props.deleteProperty(WORKER);
        if (props.getProperty('MILLIE_V10_READY') === 'true') {
          var delay = workDelay(props, Date.now());
          if (delay !== null) scheduleLocked(props, delay);
        }
      });
    }
  }
  function landing(e) {
    if (e && e.parameter && e.parameter.health === '1') return json({ ok: true, service: 'millie', storyVersion: 'v10', transport: 'legacy-queue' });
    var url = properties().getProperty('LINE_ADD_URL');
    if (typeof url !== 'string' || !/^https:\/\/[^\s<>"'\\]+$/i.test(url)) url = DEFAULT_LINE;
    var safe = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    return HtmlService.createHtmlOutput('<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ミリーちゃん</title><body><p><a href="' + safe + '">LINEでミリーちゃんと話す</a></p></body></html>');
  }
  function previewQueue() {
    return locked(function () {
      var store = queue(properties());
      var counts = {};
      rows(store).forEach(function (row) { var status = String(row[3] || 'empty'); counts[status] = (counts[status] || 0) + 1; });
      return { rows: store.sheet.getLastRow() - 1, statuses: counts };
    });
  }
  return { receive: receive, process: process, landing: landing, schedule: schedule, previewQueue: previewQueue,
    onMessage: function (uid, text) { return compat(uid, text, 'message'); },
    onFollow: function (uid) { return compat(uid, '', 'follow'); } };
}());

function doPost(e) { return MillieLegacy.receive(e); }
function onMessage(uid, text) { return MillieLegacy.onMessage(uid, text); }
function onFollow(uid) { return MillieLegacy.onFollow(uid); }
function processQueue() { return MillieLegacy.process(); }
function doGet(e) { return MillieLegacy.landing(e); }
function midnightBroadcast() {}
function horrorBroadcast() {}
function marketingReport() {}
