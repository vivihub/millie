'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '../apps-script/LegacyTransport.gs'), 'utf8');
const BASE = ['timestamp', 'userId', 'text', 'status'];
const META = ['millie_event_id', 'event_type', 'attempts', 'last_attempt_at'];
const NOW = Date.parse('2026-11-05T10:00:00Z');
const UID = 'U0123456789abcdef0123456789abcdef';

function harness(options = {}) {
  const state = { now: NOW, opens: 0, locked: false, writes: [], calls: [], triggers: [], deleted: [], nextTrigger: 1, sheets: {}, flushes: 0, formulas: 0 };
  const props = { SPREADSHEET_ID: 'test-sheet', MILLIE_V10_READY: 'true', MILLIE_V10_INSTALLED_AT: new Date(NOW).toISOString(), ...options.properties };
  class FakeDate extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  class Sheet {
    constructor(values = []) {
      this.values = values.map(row => row.slice());
      this.maxRows = options.maxRows || Math.max(10, values.length);
      this.maxColumns = options.maxColumns || Math.max(4, ...values.map(row => row.length));
    }
    getLastRow() { return this.values.length; }
    getLastColumn() { return Math.max(0, ...this.values.map(row => row.length)); }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertRowsAfter(after, count) { assert.equal(after, this.maxRows); assert.ok(count > 0); this.maxRows += count; }
    insertColumnsAfter(after, count) { assert.equal(after, this.maxColumns); assert.ok(count > 0); this.maxColumns += count; }
    getRange(row, col, height = 1, width = 1) {
      assert.ok(row > 0 && col > 0 && height > 0 && width > 0);
      assert.ok(row + height - 1 <= this.maxRows, 'row grid extended first');
      assert.ok(col + width - 1 <= this.maxColumns, 'column grid extended first');
      return {
        getValues: () => Array.from({ length: height }, (_, dy) => Array.from({ length: width }, (_, dx) => this.values[row - 1 + dy]?.[col - 1 + dx] ?? '')),
        setValues: values => {
          assert.equal(values.length, height);
          values.forEach((cells, dy) => {
            assert.equal(cells.length, width);
            if (!this.values[row - 1 + dy]) this.values[row - 1 + dy] = [];
            cells.forEach((value, dx) => {
              // GAS treats '=' strings as formulas. The leading quote escapes
              // the formula and getValues returns the literal text.
              if (typeof value === 'string' && value.startsWith("'")) value = value.slice(1);
              else if (typeof value === 'string' && value.startsWith('=')) { state.formulas += 1; value = 2; }
              this.values[row - 1 + dy][col - 1 + dx] = value;
            });
          });
          state.writes.push({ row, col, height, width });
        }
      };
    }
  }
  if (options.rows) state.sheets.queue = new Sheet(options.rows);
  const properties = {
    getProperty: key => Object.hasOwn(props, key) ? props[key] : null,
    setProperty: (key, value) => { props[key] = String(value); return properties; },
    deleteProperty: key => { delete props[key]; return properties; }
  };
  const book = { getSheetByName: name => state.sheets[name] || null, insertSheet: name => (state.sheets[name] = new Sheet()) };
  function trigger(id, handler = 'processQueue') { return { getUniqueId: () => id, getHandlerFunction: () => handler }; }
  state.triggers = (options.triggers || []).map(([id, handler]) => trigger(id, handler));
  const sandbox = {
    Date: FakeDate, JSON, Math, Object, Array, Number, String, Error, isFinite,
    PropertiesService: { getScriptProperties: () => properties },
    SpreadsheetApp: {
      openById: id => { assert.equal(id, 'test-sheet'); state.opens += 1; return book; },
      flush: () => { assert.equal(state.locked, true, 'flush writes before releasing ScriptLock'); state.flushes += 1; }
    },
    LockService: {
      getScriptLock: () => { throw new Error('queue must not contend with Runtime ScriptLock'); },
      getUserLock: () => {
      let acquired = false;
      return {
        tryLock: timeout => { assert.equal(timeout, 25000); if (state.locked) return false; acquired = true; state.locked = true; return true; },
        releaseLock: () => { assert.ok(acquired); acquired = false; state.locked = false; }
      };
    } },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => Array.from(crypto.createHash('sha256').update(value).digest()),
      newBlob: value => ({ getBytes: () => Array.from(Buffer.from(value)) })
    },
    ContentService: { MimeType: { JSON: 'application/json' }, createTextOutput: content => ({ getContent: () => content, setMimeType() { return this; } }) },
    HtmlService: { createHtmlOutput: content => ({ getContent: () => content }) },
    ScriptApp: {
      getProjectTriggers: () => state.triggers.slice(),
      deleteTrigger: t => { state.deleted.push(t.getUniqueId()); state.triggers = state.triggers.filter(item => item !== t); },
      newTrigger: handler => {
        assert.equal(handler, 'processQueue');
        const builder = { timeBased() { return builder; }, after(delay) { builder.delay = delay; return builder; }, create() {
          const t = trigger('new-' + state.nextTrigger++); t.delay = builder.delay; state.triggers.push(t); return t;
        } };
        return builder;
      }
    },
    MillieRuntime: { receivePushEvents: events => {
      assert.equal(state.locked, false, 'queue releases UserLock before invoking Runtime');
      state.calls.push(JSON.parse(JSON.stringify(events)));
      return { getContent: () => JSON.stringify(options.runtime ? options.runtime(events, state) : { ok: true }) };
    } }
  };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'LegacyTransport.gs' });
  return {
    state, props, sandbox,
    post(events, extra = {}) { return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ events, ...extra }) } }).getContent()); },
    raw(value) { return JSON.parse(sandbox.doPost({ postData: { contents: value } }).getContent()); },
    rows() { return state.sheets.queue?.values || []; },
    get(row, name) { return this.rows()[row - 1][this.rows()[0].indexOf(name)]; },
    tick(ms) { state.now += ms; }
  };
}

function message(id = 'event-1', text = 'こんにちは') {
  return { type: 'message', timestamp: NOW, webhookEventId: id, source: { type: 'user', userId: UID }, message: { type: 'text', text } };
}

test('empty verification, ignored sources and malformed requests do not touch Sheets', () => {
  const h = harness();
  assert.equal(h.post([]).ok, true);
  assert.equal(h.post([{ ...message(), source: { type: 'group', userId: UID } }]).queued, 0);
  assert.equal(h.post([{ ...message(), source: { type: 'user', userId: '' } }]).queued, 0);
  assert.equal(h.post([{ ...message(), message: { type: 'text', text: 'x'.repeat(5001) } }]).queued, 0);
  assert.equal(h.raw('{').error, 'invalid_json');
  assert.equal(h.raw('x'.repeat(256 * 1024 + 1)).error, 'invalid_body');
  assert.equal(h.raw(JSON.stringify({ events: Array(101).fill(message()) })).error, 'invalid_events');
  assert.equal(h.raw('null').error, 'invalid_events');
  assert.equal(h.state.opens, 0);
});

test('metadata appends after all existing columns and batch enqueue is one data write', () => {
  const old = ['2026-11-05T09:59:00Z', UID, 'old', 'done', 'keep-value', '=A2'];
  const h = harness({ rows: [[...BASE, 'custom', 'formula'], old], maxRows: 2, maxColumns: 6 });
  assert.equal(h.post([message(), message('event-2')]).queued, 2);
  assert.deepEqual(h.rows()[0], [...BASE, 'custom', 'formula', ...META]);
  assert.deepEqual(h.rows()[1], old);
  assert.equal(h.get(3, 'millie_event_id'), 'event-1');
  assert.equal(h.get(4, 'millie_event_id'), 'event-2');
  assert.equal(h.state.writes.filter(w => w.row === 3 && w.height === 2).length, 1);
  assert.equal(h.state.triggers.length, 1);
  assert.equal(h.state.triggers[0].delay, 1000);
  h.post([message('event-3')]);
  assert.equal(h.state.triggers.length, 1, 'enqueue reuses its own scheduled worker');
});

test('event IDs survive retries/redelivery, with a stable synthetic fallback', () => {
  const h = harness();
  const event = message(); delete event.webhookEventId;
  h.post([event, event, message('real-line-event')]);
  assert.match(h.get(2, 'millie_event_id'), /^legacy-[0-9a-f]{64}$/);
  assert.equal(h.get(2, 'millie_event_id'), h.get(3, 'millie_event_id'));
  assert.equal(h.get(4, 'millie_event_id'), 'real-line-event');
  h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 3);
  assert.equal(h.state.calls[0][0].webhookEventId, h.state.calls[1][0].webhookEventId);
  assert.equal(h.get(2, 'status'), 'done');
  assert.equal(h.state.locked, false);
});

test('user text and external event IDs stay literal instead of evaluating as Sheet formulas', () => {
  const h = harness();
  h.post([message('=external-event-id', '=1+1'), message('quote-id', "'=1+1"), message('quote-text-id', "'hello")]);
  assert.equal(h.get(2, 'text'), '=1+1');
  assert.equal(h.get(2, 'millie_event_id'), '=external-event-id');
  h.sandbox.processQueue();
  assert.equal(h.state.calls[0][0].message.text, '=1+1');
  assert.equal(h.state.calls[0][0].webhookEventId, '=external-event-id');
  assert.equal(h.state.calls[1][0].message.text, "'=1+1");
  assert.equal(h.state.calls[2][0].message.text, "'hello");
  assert.equal(h.get(2, 'status'), 'done');
  assert.equal(h.state.formulas, 0);
  assert.ok(h.state.flushes > 0);
});

test('Runtime failures retry after 30 seconds with the same event ID, at most three attempts', () => {
  const h = harness({ runtime: () => ({ ok: false, errors: ['line_500'] }) });
  h.post([message('same-id')]);
  h.sandbox.processQueue();
  assert.equal(h.get(2, 'status'), 'pending');
  assert.equal(h.get(2, 'attempts'), 1);
  assert.equal(h.state.triggers[0].delay, 30000);
  h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 1, 'manual/old triggers cannot skip retry delay');
  h.tick(30000); h.sandbox.processQueue();
  assert.equal(h.get(2, 'attempts'), 2);
  h.tick(30000); h.sandbox.processQueue();
  assert.equal(h.get(2, 'attempts'), 3);
  assert.equal(h.get(2, 'status'), 'failed');
  assert.equal(h.state.triggers.length, 0);
  h.tick(30000); h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 3);
  assert.deepEqual(h.state.calls.map(events => events[0].webhookEventId), ['same-id', 'same-id', 'same-id']);
});

test('legacy backlog is preserved without sending, but recent and identified events run', () => {
  const h = harness({ rows: [[...BASE, ...META],
    ['2026-11-04T10:00:00Z', UID, 'old pending', 'pending'],
    ['not-a-date', UID, 'unknown age', 'pending'],
    ['2026-11-05T09:55:00Z', UID, 'recent', 'pending'],
    ['2026-11-04T10:00:00Z', UID, 'new identified', 'pending', 'known-old', 'message', 0, ''],
    ['2026-11-04T10:00:00Z', UID, 'old done', 'done']
  ] });
  h.sandbox.processQueue();
  assert.equal(h.get(2, 'status'), 'legacy_pending');
  assert.equal(h.get(3, 'status'), 'legacy_pending');
  assert.equal(h.get(4, 'status'), 'done');
  assert.equal(h.get(5, 'status'), 'done');
  assert.equal(h.get(6, 'status'), 'done');
  assert.equal(h.state.calls.length, 2);
  assert.equal(h.rows().length, 6);
  assert.equal(h.rows()[1][2], 'old pending');
});

test('stale processing keeps its ID and increments the existing attempt', () => {
  const h = harness({ rows: [[...BASE, ...META], ['2026-11-05T09:58:00Z', UID, 'retry', 'processing', 'stale-id', 'message', 1, '2026-11-05T09:59:00Z']] });
  h.sandbox.processQueue();
  assert.equal(h.get(2, 'status'), 'done');
  assert.equal(h.get(2, 'attempts'), 2);
  assert.equal(h.state.calls[0][0].webhookEventId, 'stale-id');
});

test('worker deletes only its own trigger, preserving unrelated/legacy trigger handlers', () => {
  const h = harness({ properties: { MILLIE_QUEUE_TRIGGER_ID: 'own' }, triggers: [['own', 'processQueue'], ['other-queue', 'processQueue'], ['night', 'midnightBroadcast']] });
  h.sandbox.processQueue();
  assert.deepEqual(h.state.deleted, ['own']);
  assert.deepEqual(h.state.triggers.map(t => t.getUniqueId()), ['other-queue', 'night']);
  assert.equal(h.props.MILLIE_QUEUE_TRIGGER_ID, undefined);
});

test('readiness gate and active worker lease prevent Sheet access and processing', () => {
  const paused = harness({ properties: { MILLIE_V10_READY: 'false' } });
  paused.sandbox.processQueue();
  assert.equal(paused.state.opens, 0);
  assert.equal(paused.state.calls.length, 0);
  const busy = harness({ properties: { MILLIE_QUEUE_WORKER: JSON.stringify({ token: 'other', until: NOW + 300000 }) } });
  busy.sandbox.processQueue();
  assert.equal(busy.state.opens, 0);
  assert.equal(JSON.parse(busy.props.MILLIE_QUEUE_WORKER).token, 'other');
});

test('run processes at most 20 rows, then schedules the remainder', () => {
  const h = harness();
  h.post(Array.from({ length: 22 }, (_, i) => message('event-' + i)));
  h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 20);
  assert.equal(h.get(22, 'status'), 'pending');
  assert.equal(h.state.triggers.length, 1);
  h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 22);
  assert.equal(h.state.triggers.length, 0);
});

test('240-second run budget leaves unprocessed rows queued for another run', () => {
  const h = harness({ runtime: (_events, state) => { state.now += 240000; return { ok: true }; } });
  h.post([message('first'), message('later')]);
  h.sandbox.processQueue();
  assert.equal(h.state.calls.length, 1);
  assert.equal(h.get(2, 'status'), 'done');
  assert.equal(h.get(3, 'status'), 'pending');
  assert.equal(h.state.triggers.length, 1);
});

test('new webhook can enqueue while Runtime owns its separate ScriptLock', () => {
  let h;
  h = harness({ runtime: events => {
    if (events[0].webhookEventId === 'first') assert.equal(h.post([message('arrived-during-ai')]).queued, 1);
    return { ok: true };
  } });
  h.post([message('first')]);
  h.sandbox.processQueue();
  assert.deepEqual(h.state.calls.map(events => events[0].webhookEventId), ['first', 'arrived-during-ai']);
  assert.equal(h.get(3, 'status'), 'done');
});

test('follow/unfollow and compatibility methods enqueue typed events; administrative flags are ignored', () => {
  const h = harness();
  h.post([{ type: 'follow', webhookEventId: 'follow-id', timestamp: NOW, source: { type: 'user', userId: UID } },
    { type: 'unfollow', webhookEventId: 'unfollow-id', timestamp: NOW, source: { type: 'user', userId: UID } }],
  { action: 'install', method: 'previewQueue', gatewaySecret: 'arbitrary' });
  h.sandbox.onFollow(UID);
  h.sandbox.onMessage(UID, '作品の話');
  h.sandbox.processQueue();
  assert.deepEqual(h.state.calls.map(events => events[0].type), ['follow', 'unfollow', 'follow', 'message']);
  assert.equal(h.state.calls[3][0].message.text, '作品の話');
  assert.equal(h.state.calls[0][0].replyToken, undefined);
});

test('health is static, landing URLs are escaped/https only and old broadcasts are harmless', () => {
  const h = harness({ properties: { LINE_ADD_URL: 'javascript:alert(1)' } });
  const health = JSON.parse(h.sandbox.doGet({ parameter: { health: '1', from: UID } }).getContent());
  assert.deepEqual(health, { ok: true, service: 'millie', storyVersion: 'v10', transport: 'legacy-queue' });
  assert.match(h.sandbox.doGet({ parameter: { from: UID } }).getContent(), /https:\/\/line.me\/R\/ti\/p\/@575kepfk/);
  h.props.LINE_ADD_URL = 'https://example.com/?a=1&b=2';
  assert.match(h.sandbox.doGet({}).getContent(), /a=1&amp;b=2/);
  h.sandbox.midnightBroadcast(); h.sandbox.horrorBroadcast(); h.sandbox.marketingReport();
  assert.equal(h.state.opens, 0);
  assert.equal(h.state.calls.length, 0);
});
