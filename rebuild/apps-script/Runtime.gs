/**
 * Millie LINE adapter. Install alongside Core.gs (and optional AI.gs).
 * No broadcast triggers are created. The deployed endpoint accepts only the
 * authenticated envelope emitted by the signature-verifying gateway.
 */
var MillieRuntime = (function () {
  'use strict';

  var HEADERS = [
    'user_id', 'name', 'location', 'hobby', 'fears', 'sleep_time',
    'live_alone', 'secrets', 'phase', 'message_count', 'invite_count',
    'started_at', 'last_reply_at', 'ending_type', 'is_active', 'history',
    'workplace', 'commute', 'pet', 'invite_explained', 'reaction_type',
    'weird_response', 'invite_response', 'night_owl', 'pos_score', 'neg_score',
    'blunt_score', 'topics', 'no_reply_count', 'last_broadcast_at',
    'referred_by', 'source', 'awaiting_source', 'last_fortune_date',
    'anniversaries_sent', 'kaidan_told', 'invite_requested'
  ];
  var BOOLEAN_FIELDS = ['is_active', 'invite_explained', 'night_owl', 'awaiting_source', 'invite_requested'];
  var NUMBER_FIELDS = ['phase', 'message_count', 'invite_count', 'pos_score', 'neg_score', 'blunt_score', 'no_reply_count'];
  var EVENT_PREFIX = 'MILLIE_EVENT_';
  var EVENT_TTL_MS = 24 * 60 * 60 * 1000;
  var COMPLETION_SHEET = 'millie_event_dedupe';
  var COMPLETION_HEADERS = ['event_key', 'created_at', 'status'];
  var COMPLETION_PRUNED_AT = 'MILLIE_DEDUPE_PRUNED_AT';
  var COMPLETION_PRUNE_MS = 60 * 60 * 1000;
  var MAX_RECORD_BYTES = 8000;
  var MAX_PROPERTY_BYTES = 400 * 1024;
  var MAX_PENDING_RECORDS = 2000;
  var MAX_BODY_BYTES = 1024 * 1024;
  var MAX_BATCH_EVENTS = 100;
  var DEFAULT_ADD_URL = 'https://line.me/R/ti/p/@575kepfk';

  function fault(code) {
    var error = new Error(code);
    error.code = code;
    return error;
  }

  function json(value) {
    return ContentService.createTextOutput(JSON.stringify(value))
      .setMimeType(ContentService.MimeType.JSON);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function bytes(value) {
    return Utilities.newBlob(String(value)).getBytes().length;
  }

  function equalSecret(left, right) {
    if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
    var different = left.length ^ right.length;
    var size = Math.max(left.length, right.length);
    for (var i = 0; i < size; i += 1) {
      different |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
    }
    return different === 0;
  }

  function hash(value) {
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8)
      .map(function (n) { return ('0' + ((n + 256) % 256).toString(16)).slice(-2); }).join('');
  }

  function requireProperty(properties, name) {
    var value = properties.getProperty(name);
    if (!value) throw fault('missing_' + name.toLowerCase());
    return value;
  }

  function openBook(properties) {
    return SpreadsheetApp.openById(requireProperty(properties, 'SPREADSHEET_ID'));
  }

  function inspectSchema(sheet) {
    if (!sheet) return { ok: false, reason: 'users_sheet_missing', missing: HEADERS.slice(), extra: [], duplicate: [] };
    var lastColumn = sheet.getLastColumn();
    var values = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getValues()[0] : [];
    var headers = values.map(function (value) { return String(value).trim(); });
    var map = {};
    var duplicate = [];
    headers.forEach(function (header, index) {
      if (!header) return;
      if (Object.prototype.hasOwnProperty.call(map, header)) duplicate.push(header);
      else map[header] = index;
    });
    var missing = HEADERS.filter(function (name) { return !Object.prototype.hasOwnProperty.call(map, name); });
    var extra = headers.filter(function (name) { return name && HEADERS.indexOf(name) < 0; });
    return {
      ok: missing.length === 0 && duplicate.length === 0,
      reason: duplicate.length ? 'duplicate_headers' : (missing.length ? 'missing_headers' : 'ready'),
      missing: missing, extra: extra, duplicate: duplicate,
      headers: headers, map: map
    };
  }

  function requireSchema(book) {
    var sheet = book.getSheetByName('users');
    var schema = inspectSchema(sheet);
    if (!schema.ok) throw fault('schema_' + schema.reason);
    return { sheet: sheet, schema: schema };
  }

  function publicSchema(schema, sheet) {
    return {
      ok: schema.ok,
      reason: schema.reason,
      requiredColumns: HEADERS.length,
      missing: schema.missing,
      extra: schema.extra,
      duplicate: schema.duplicate,
      userRows: sheet ? Math.max(0, sheet.getLastRow() - 1) : 0,
      changes: []
    };
  }

  function decode(name, value) {
    if (Object.prototype.toString.call(value) === '[object Date]') return value.toISOString();
    if (BOOLEAN_FIELDS.indexOf(name) >= 0 && typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    if (NUMBER_FIELDS.indexOf(name) >= 0 && value !== '' && isFinite(Number(value))) return Number(value);
    return value;
  }

  function cell(value) {
    if (value === null || typeof value === 'undefined') return '';
    if (Array.isArray(value) || (typeof value === 'object')) value = JSON.stringify(value);
    // User supplied profile text must remain text, including a leading '='.
    if (typeof value === 'string' && value.charAt(0) === '=') return "'" + value;
    return value;
  }

  function findUser(store, userId) {
    var sheet = store.sheet;
    var lastRow = sheet.getLastRow();
    var index = store.schema.map.user_id;
    if (lastRow < 2) return { row: 0, user: null };
    var ids = sheet.getRange(2, index + 1, lastRow - 1, 1).getValues();
    var row = 0;
    ids.forEach(function (values, offset) {
      if (String(values[0]) === userId) {
        if (row) throw fault('duplicate_user_id');
        row = offset + 2;
      }
    });
    if (!row) return { row: 0, user: null };
    var values = sheet.getRange(row, 1, 1, store.schema.headers.length).getValues()[0];
    var user = {};
    HEADERS.forEach(function (name) { user[name] = decode(name, values[store.schema.map[name]]); });
    return { row: row, user: user };
  }

  function userPatch(before, after, userId) {
    if (!after || typeof after !== 'object' || Array.isArray(after)) throw fault('invalid_core_user');
    var patch = {};
    HEADERS.forEach(function (name) {
      if (name === 'user_id') return;
      if (Object.prototype.hasOwnProperty.call(after, name) && JSON.stringify(before[name]) !== JSON.stringify(after[name])) {
        patch[name] = after[name] === undefined ? null : after[name];
      }
    });
    if (!before.user_id) patch.user_id = userId;
    return patch;
  }

  function ensureRows(sheet, lastNeededRow) {
    var maxRows = sheet.getMaxRows();
    if (lastNeededRow > maxRows) sheet.insertRowsAfter(maxRows, Math.max(500, lastNeededRow - maxRows));
  }

  function applyPatch(store, found, patch, userId) {
    var row = found.row || Math.max(2, store.sheet.getLastRow() + 1);
    if (!found.row && patch.user_id !== userId) throw fault('invalid_new_user_patch');
    if (patch.user_id && patch.user_id !== userId) throw fault('invalid_user_patch');
    ensureRows(store.sheet, row);
    var writes = Object.keys(patch).map(function (name) {
      if (HEADERS.indexOf(name) < 0) throw fault('invalid_patch_field');
      return { column: store.schema.map[name] + 1, value: cell(patch[name]) };
    }).sort(function (a, b) { return a.column - b.column; });
    // Write only changed canonical cells. Additional columns and formulas are untouched.
    var run = [];
    function flushRun() {
      if (run.length) store.sheet.getRange(row, run[0].column, 1, run.length)
        .setValues([run.map(function (write) { return write.value; })]);
      run = [];
    }
    writes.forEach(function (write) {
      if (run.length && write.column !== run[run.length - 1].column + 1) flushRun();
      run.push(write);
    });
    flushRun();
    SpreadsheetApp.flush();
    return row;
  }

  function prune(properties, now) {
    var all = properties.getProperties();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(EVENT_PREFIX) !== 0) return;
      var record;
      try { record = JSON.parse(all[key]); } catch (_) { return; }
      if (typeof record.created === 'number' && now - record.created >= EVENT_TTL_MS) properties.deleteProperty(key);
    });
  }

  function completionStore(book) {
    var sheet = book.getSheetByName(COMPLETION_SHEET);
    var created = false;
    if (!sheet) {
      sheet = book.insertSheet(COMPLETION_SHEET);
      sheet.getRange(1, 1, 1, COMPLETION_HEADERS.length).setValues([COMPLETION_HEADERS.slice()]);
      SpreadsheetApp.flush();
      created = true;
    }
    var headers = sheet.getLastColumn() ? sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0] : [];
    if (JSON.stringify(headers) !== JSON.stringify(COMPLETION_HEADERS)) throw fault('schema_invalid_event_dedupe');
    return { sheet: sheet, created: created };
  }

  function completed(completions, key, now) {
    var lastRow = completions.sheet.getLastRow();
    if (lastRow < 2) return null;
    // Sheets searches the key column; successful event volume does not consume
    // ScriptProperties capacity or require loading all completed records.
    var matches = completions.sheet.getRange(2, 1, lastRow - 1, 1)
      .createTextFinder(key).matchEntireCell(true).findAll();
    for (var i = 0; i < matches.length; i += 1) {
      var values = completions.sheet.getRange(matches[i].getRow(), 1, 1, 3).getValues()[0];
      var created = Number(values[1]);
      if (isFinite(created) && now - created < EVENT_TTL_MS && (values[2] === 'done' || values[2] === 'abandoned')) {
        return { v: 1, created: created, status: values[2] };
      }
    }
    return null;
  }

  function pruneCompleted(completions, properties, now) {
    var lastPruned = Number(properties.getProperty(COMPLETION_PRUNED_AT));
    if (lastPruned && now - lastPruned < COMPLETION_PRUNE_MS) return;
    var sheet = completions.sheet;
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      var values = sheet.getRange(2, 2, lastRow - 1, 1).getValues();
      var runs = [];
      var start = 0;
      values.forEach(function (row, index) {
        var created = Number(row[0]);
        var expired = isFinite(created) && now - created >= EVENT_TTL_MS;
        if (expired && !start) start = index + 2;
        if (start && (!expired || index === values.length - 1)) {
          var end = expired ? index + 2 : index + 1;
          runs.push({ row: start, count: end - start + 1 });
          start = 0;
        }
      });
      // Delete only expired metadata rows in our own sheet, from bottom upward.
      runs.reverse().forEach(function (run) { sheet.deleteRows(run.row, run.count); });
      if (runs.length) SpreadsheetApp.flush();
    }
    properties.setProperty(COMPLETION_PRUNED_AT, String(now));
  }

  function migrateCompleted(completions, properties, now) {
    var all = properties.getProperties();
    var legacy = [];
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(EVENT_PREFIX) !== 0) return;
      var record;
      try { record = JSON.parse(all[key]); } catch (_) { return; }
      if (record.status !== 'done' && record.status !== 'abandoned') return;
      if (record.v !== 1 || typeof record.created !== 'number' || !isFinite(record.created)) throw fault('corrupt_outbox_record');
      legacy.push({ key: key, record: record });
    });
    if (!legacy.length) return;
    // One batch migrates older deployments, including an already-full 2,000
    // record Properties store. Keep originals until the sheet write is durable.
    var lastRow = completions.sheet.getLastRow();
    var known = {};
    if (lastRow > 1) completions.sheet.getRange(2, 1, lastRow - 1, 3).getValues().forEach(function (row) {
      if (now - Number(row[1]) < EVENT_TTL_MS) known[row[0]] = true;
    });
    var rows = [];
    legacy.sort(function (a, b) { return a.record.created - b.record.created; }).forEach(function (item) {
      if (!known[item.key] && now - item.record.created < EVENT_TTL_MS) {
        rows.push([item.key, item.record.created, item.record.status]);
        known[item.key] = true;
      }
    });
    if (rows.length) {
      ensureRows(completions.sheet, lastRow + rows.length);
      completions.sheet.getRange(lastRow + 1, 1, rows.length, 3).setValues(rows);
      SpreadsheetApp.flush();
    }
    legacy.forEach(function (item) { properties.deleteProperty(item.key); });
  }

  function saveRecord(properties, key, record) {
    var serialized = JSON.stringify(record);
    if (bytes(serialized) > MAX_RECORD_BYTES) throw fault('outbox_record_too_large');
    var all = properties.getProperties();
    var keys = Object.keys(all);
    var count = 0;
    var size = bytes(key) + bytes(serialized);
    keys.forEach(function (existingKey) {
      if (existingKey === key) return;
      size += bytes(existingKey) + bytes(all[existingKey]);
      if (existingKey.indexOf(EVENT_PREFIX) === 0) count += 1;
    });
    if (size > MAX_PROPERTY_BYTES || count >= MAX_PENDING_RECORDS) throw fault('outbox_capacity_reached');
    properties.setProperty(key, serialized);
  }

  function loadRecord(properties, key) {
    var value = properties.getProperty(key);
    if (!value) return null;
    var record;
    try { record = JSON.parse(value); } catch (_) { throw fault('corrupt_outbox_record'); }
    if (!record || record.v !== 1 || ['prepared', 'pending', 'done', 'abandoned'].indexOf(record.status) < 0) {
      throw fault('corrupt_outbox_record');
    }
    return record;
  }

  function markDone(completions, properties, key, record, status) {
    // Flush the metadata-only completion before removing the pending outbox.
    // A crash between these steps is resolved by consulting the sheet first.
    if (!completed(completions, key, new Date().getTime())) {
      var row = completions.sheet.getLastRow() + 1;
      ensureRows(completions.sheet, row);
      completions.sheet.getRange(row, 1, 1, 3)
        .setValues([[key, record.created, status || 'done']]);
      SpreadsheetApp.flush();
    }
    properties.deleteProperty(key);
  }

  function finishPrepared(store, properties, key, record, userId) {
    if (!record.patch || typeof record.patch !== 'object' || Array.isArray(record.patch) || !Array.isArray(record.messages)) {
      throw fault('corrupt_outbox_record');
    }
    var found = findUser(store, userId);
    if (Object.keys(record.patch).length) applyPatch(store, found, record.patch, userId);
    record.status = 'pending';
    // State is now durable in users; the pending outbox needs only its messages.
    delete record.patch;
    saveRecord(properties, key, record);
  }

  function recoverPrepared(store, properties, userId) {
    var userHash = hash(userId);
    var all = properties.getProperties();
    var prepared = [];
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(EVENT_PREFIX) !== 0) return;
      var record;
      try { record = JSON.parse(all[key]); } catch (_) { return; }
      if (record.userHash === userHash && record.status === 'prepared') prepared.push({ key: key, record: record });
    });
    prepared.sort(function (a, b) { return a.record.created - b.record.created; });
    prepared.forEach(function (item) { finishPrepared(store, properties, item.key, item.record, userId); });
  }

  function abandonInactiveOutbox(store, completions, properties, userId) {
    var found = findUser(store, userId);
    if (!found.user || found.user.is_active !== false) return;
    var userHash = hash(userId);
    var all = properties.getProperties();
    Object.keys(all).forEach(function (key) {
      if (key.indexOf(EVENT_PREFIX) !== 0) return;
      var record;
      try { record = JSON.parse(all[key]); } catch (_) { return; }
      if (record.userHash === userHash && record.status === 'pending' && record.activeReply === true) {
        markDone(completions, properties, key, record, 'abandoned');
      }
    });
  }

  function safeText(value, maxLength) {
    return String(value || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, maxLength);
  }

  function shareFlex(card, properties) {
    // Only allow fixed public card copy. Never interpolate names or conversation text.
    // Core's card requests the share action; the rendering is deliberately anonymous.
    var addUrl = properties.getProperty('LINE_ADD_URL') || DEFAULT_ADD_URL;
    if (!/^https:\/\//.test(addUrl)) addUrl = DEFAULT_ADD_URL;
    var publicCard = null;
    if (card && ['hanako', 'ongaku', 'akai', 'echo'].indexOf(card.id) >= 0 && typeof MillieCore.publicCard === 'function') {
      publicCard = MillieCore.publicCard(card.id);
    }
    var title = publicCard && typeof publicCard.title === 'string' ? safeText(publicCard.title, 100) : '返事をしたら、\n物語が始まった。';
    var lines = publicCard && Array.isArray(publicCard.lines) ? publicCard.lines.filter(function (line) { return typeof line === 'string'; }).slice(0, 4).map(function (line) { return safeText(line, 200); }).join('\n') : 'あなたのLINEにも、ミリーから。';
    return {
      type: 'flex', altText: 'ミリーちゃんとの怪談体験',
      contents: {
        type: 'bubble', size: 'mega',
        body: {
          type: 'box', layout: 'vertical', backgroundColor: '#121019', spacing: 'md', paddingAll: '24px',
          contents: [
            { type: 'text', text: 'ミリーちゃん', size: 'xs', color: '#CBBED7', weight: 'bold' },
            { type: 'text', text: title, wrap: true, size: 'xl', weight: 'bold', color: '#FFFFFF' },
            { type: 'text', text: lines || 'あなたのLINEにも、ミリーから。', wrap: true, size: 'sm', color: '#D4CBDC' }
          ]
        },
        footer: {
          type: 'box', layout: 'vertical', backgroundColor: '#121019',
          contents: [{ type: 'button', style: 'primary', color: '#705480', action: { type: 'uri', label: 'ミリーに会いにいく', uri: addUrl } }]
        }
      }
    };
  }

  function lineMessages(result, properties) {
    if (!Array.isArray(result.messages) || result.messages.length > 4) throw fault('invalid_core_messages');
    var messages = result.messages.filter(function (text) { return typeof text === 'string' && text.length > 0; })
      .map(function (text) { return { type: 'text', text: safeText(text, 5000) }; });
    if (messages.length !== result.messages.length) throw fault('invalid_core_messages');
    if (result.shareCard) messages.push(shareFlex(result.shareCard, properties));
    if (messages.length > 5) throw fault('too_many_line_messages');
    return messages;
  }

  function reply(properties, token, messages) {
    if (!messages.length) return { success: true };
    if (typeof token !== 'string' || !token) return { success: false, code: 'reply_token_missing', retryable: false };
    var accessToken = requireProperty(properties, 'CHANNEL_ACCESS_TOKEN');
    var response;
    try {
      response = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
        method: 'post', contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + accessToken },
        payload: JSON.stringify({ replyToken: token, messages: messages }),
        muteHttpExceptions: true
      });
    } catch (_) {
      return { success: false, code: 'line_network_error', retryable: true };
    }
    var status = response.getResponseCode();
    if (status >= 200 && status < 300) return { success: true };
    // Do not log the response body: LINE may include request details.
    // 400 can mean an already-used / expired token. Keep pending for a redelivery
    // with a usable token; never resend this event through the push API.
    return { success: false, code: 'line_http_' + status, retryable: status === 400 || status === 429 || status >= 500 };
  }

  function context(now) {
    return { now: now.toISOString(), dateKey: Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd') };
  }

  function computeResult(found, event, userId, ctx) {
    var before = found.user || {};
    var user = found.user ? clone(found.user) : MillieCore.newUser(userId, ctx.now);
    var result;
    if (event.type === 'unfollow') {
      if (!found.user) return { before: before, result: { user: {}, messages: [], counted: false } };
      user.is_active = false;
      result = { user: user, messages: [], counted: false };
    } else if (event.type === 'follow' && found.user) {
      user.is_active = true;
      result = { user: user, messages: ['……また会えたね。\nお話の続き、聞いてくれる？'], counted: false };
    } else {
      var input = event.type === 'follow' ? '__follow__' : event.message.text;
      result = MillieCore.respond(user, input, ctx);
      if (result && result.aiEligible === true && typeof MillieAI !== 'undefined' && typeof MillieAI.enhance === 'function') {
        var fallback = clone(result);
        try {
          var enhanced = MillieAI.enhance(clone(user), input, clone(result), ctx);
          if (enhanced && Array.isArray(enhanced.messages)) {
            // AI only supplies presentation. Progress and sharing remain Core's decision.
            result.messages = enhanced.messages;
            if (enhanced.user && typeof enhanced.user.history === 'string') result.user.history = enhanced.user.history;
          }
        } catch (_) { result = fallback; }
      }
    }
    if (!result || !result.user || !Array.isArray(result.messages)) throw fault('invalid_core_response');
    return { before: before, result: result };
  }

  function supported(event) {
    if (!event || !event.source || event.source.type !== 'user' || typeof event.source.userId !== 'string' || !event.source.userId) return false;
    if (event.type === 'follow' || event.type === 'unfollow') return true;
    return event.type === 'message' && event.message && event.message.type === 'text' &&
      typeof event.message.text === 'string' && event.message.text.length > 0 && event.message.text.length <= 5000;
  }

  function handleEvent(store, completions, properties, event, now) {
    if (!supported(event)) return { status: 'skipped' };
    if (typeof event.webhookEventId !== 'string' || !event.webhookEventId || event.webhookEventId.length > 256) {
      throw fault('webhook_event_id_required');
    }
    var key = EVENT_PREFIX + hash(event.webhookEventId);
    if (completed(completions, key, now.getTime())) {
      // Clean up an outbox left behind after a successful completion write.
      if (properties.getProperty(key)) properties.deleteProperty(key);
      return { status: 'duplicate' };
    }
    var record = loadRecord(properties, key);
    if (record && (record.status === 'done' || record.status === 'abandoned')) return { status: 'duplicate' };
    var userId = event.source.userId;
    if (record && record.userHash !== hash(userId)) throw fault('event_source_mismatch');
    // Complete this user's interrupted sheet commit before computing a later
    // event. Otherwise an old prepared patch could roll back newer progress.
    recoverPrepared(store, properties, userId);
    abandonInactiveOutbox(store, completions, properties, userId);
    if (completed(completions, key, now.getTime())) return { status: 'duplicate' };
    record = loadRecord(properties, key);
    if (record && (record.status === 'done' || record.status === 'abandoned')) return { status: 'duplicate' };
    var found = findUser(store, userId);
    if (!record) {
      var computed = computeResult(found, event, userId, context(now));
      var patch = userPatch(computed.before, computed.result.user, userId);
      // An unknown unfollow is recorded without creating a user row.
      if (event.type === 'unfollow' && !found.user) patch = {};
      record = {
        v: 1, created: now.getTime(), status: 'prepared', userHash: hash(userId),
        patch: patch, messages: lineMessages(computed.result, properties),
        activeReply: computed.result.user.is_active !== false
      };
      // Journal first. A crash before/after sheet writes replays the same patch,
      // never reruns the narrative engine or adds to message_count again.
      saveRecord(properties, key, record);
    }
    if (record.status === 'prepared') {
      finishPrepared(store, properties, key, record, userId);
    }
    abandonInactiveOutbox(store, completions, properties, userId);
    if (completed(completions, key, now.getTime())) return { status: 'duplicate' };
    record = loadRecord(properties, key);
    if (record.status === 'abandoned') return { status: 'duplicate' };
    var outcome = reply(properties, event.replyToken, record.messages);
    if (outcome.success) {
      markDone(completions, properties, key, record);
      return { status: 'done' };
    }
    // Retain the fixed outbox on LINE errors. No additional history/count update.
    // The gateway returns non-2xx so LINE redelivery can supply another token.
    return { status: 'pending', error: outcome.code };
  }

  function receive(e) {
    var lock = null;
    try {
      var raw = e && e.postData && e.postData.contents;
      if (typeof raw !== 'string' || bytes(raw) > MAX_BODY_BYTES) return json({ ok: false, error: 'invalid_envelope' });
      var payload;
      try { payload = JSON.parse(raw); } catch (_) { return json({ ok: false, error: 'invalid_json' }); }
      var properties = PropertiesService.getScriptProperties();
      if (!payload || !equalSecret(payload.gatewaySecret, properties.getProperty('MILLIE_GATEWAY_SECRET'))) {
        return json({ ok: false, error: 'unauthorized' });
      }
      if (!Array.isArray(payload.events) || payload.events.length > MAX_BATCH_EVENTS) return json({ ok: false, error: 'invalid_events' });
      // LINE's empty verify request needs neither Sheets nor an access token.
      if (!payload.events.length) return json({ ok: true, processed: 0 });
      lock = LockService.getScriptLock();
      if (!lock.tryLock(5000)) return json({ ok: false, error: 'busy' });
      var now = new Date();
      prune(properties, now.getTime());
      var book = openBook(properties);
      var store = requireSchema(book);
      var completions = completionStore(book);
      pruneCompleted(completions, properties, now.getTime());
      migrateCompleted(completions, properties, now.getTime());
      var processed = 0;
      var skipped = 0;
      var pending = false;
      var errors = [];
      payload.events.forEach(function (event) {
        var result = handleEvent(store, completions, properties, event, now);
        if (result.status === 'skipped') skipped += 1;
        else processed += 1;
        if (result.status === 'pending') {
          pending = true;
          if (errors.indexOf(result.error) < 0) errors.push(result.error);
        }
      });
      return json({ ok: !pending, processed: processed, skipped: skipped, errors: errors });
    } catch (error) {
      // Return machine-readable errors only. No LINE IDs, message text, or secrets.
      return json({ ok: false, error: error && error.code ? error.code : 'runtime_error' });
    } finally {
      if (lock && lock.hasLock()) lock.releaseLock();
    }
  }

  function preview() {
    var properties = PropertiesService.getScriptProperties();
    var book = openBook(properties);
    var sheet = book.getSheetByName('users');
    return publicSchema(inspectSchema(sheet), sheet);
  }

  function install() {
    var properties = PropertiesService.getScriptProperties();
    requireProperty(properties, 'MILLIE_GATEWAY_SECRET');
    requireProperty(properties, 'CHANNEL_ACCESS_TOKEN');
    if (properties.getProperty('GEMINI_API_KEY')) requireProperty(properties, 'GEMINI_MODEL');
    var lock = LockService.getScriptLock();
    if (!lock.tryLock(5000)) throw fault('busy');
    try {
      var book = openBook(properties);
      var sheet = book.getSheetByName('users');
      if (!sheet) {
        sheet = book.insertSheet('users');
        var maxColumns = sheet.getMaxColumns();
        if (maxColumns < HEADERS.length) sheet.insertColumnsAfter(maxColumns, HEADERS.length - maxColumns);
        sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS.slice()]);
        SpreadsheetApp.flush();
        var newCompletions = completionStore(book);
        if (!properties.getProperty('MILLIE_V10_INSTALLED_AT')) properties.setProperty('MILLIE_V10_INSTALLED_AT', new Date().toISOString());
        var created = publicSchema(inspectSchema(sheet), sheet);
        created.changes = ['created_users_sheet_with_37_headers'];
        if (newCompletions.created) created.changes.push('created_event_dedupe_sheet');
        return created;
      }
      var schema = inspectSchema(sheet);
      if (!schema.ok) throw fault('schema_' + schema.reason);
      var completions = completionStore(book);
      if (!properties.getProperty('MILLIE_V10_INSTALLED_AT')) properties.setProperty('MILLIE_V10_INSTALLED_AT', new Date().toISOString());
      // Existing headers, users, queue, logs, and triggers are never modified here.
      var result = publicSchema(schema, sheet);
      if (completions.created) result.changes.push('created_event_dedupe_sheet');
      return result;
    } finally { lock.releaseLock(); }
  }

  return {
    receive: receive,
    preview: preview,
    install: install,
    health: function () { return json({ ok: true, service: 'millie-runtime', version: '1.0', gatewayRequired: true }); }
  };
}());

function doPost(e) { return MillieRuntime.receive(e); }
function doGet(e) { return MillieRuntime.health(); }
function previewMigration() { return MillieRuntime.preview(); }
function installMillieV10() { return MillieRuntime.install(); }
