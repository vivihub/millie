'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const SOURCE = fs.readFileSync(path.join(__dirname, '../apps-script/Runtime.gs'), 'utf8');
const HEADERS = 'user_id,name,location,hobby,fears,sleep_time,live_alone,secrets,phase,message_count,invite_count,started_at,last_reply_at,ending_type,is_active,history,workplace,commute,pet,invite_explained,reaction_type,weird_response,invite_response,night_owl,pos_score,neg_score,blunt_score,topics,no_reply_count,last_broadcast_at,referred_by,source,awaiting_source,last_fortune_date,anniversaries_sent,kaidan_told,invite_requested'.split(',');
const EVENT_PREFIX = 'MILLIE_EVENT_';
const COMPLETION_SHEET = 'millie_event_dedupe';
const COMPLETION_HEADERS = ['event_key', 'created_at', 'status'];

function harness(options = {}) {
  const props = {
    SPREADSHEET_ID: 'test-sheet', MILLIE_GATEWAY_SECRET: 'test-gateway-secret',
    CHANNEL_ACCESS_TOKEN: 'test-line-token', ...options.properties
  };
  const state = {
    sheets: {}, writes: 0, opens: 0, sends: [], endpoints: [], headers: [], coreCalls: 0, aiCalls: 0,
    failures: [], responseHeaders: [], locked: false, failWriteOnce: false, failPendingOnce: false,
    failCompletionWriteOnce: false, failDeleteOnce: false
  };
  class Sheet {
    constructor(rows = []) {
      this.rows = rows.map(row => row.slice());
      this.maxRows = Math.max(1000, rows.length);
      this.maxColumns = Math.max(26, ...rows.map(row => row.length));
    }
    getLastColumn() { return Math.max(0, ...this.rows.map(row => row.length)); }
    getLastRow() { return this.rows.length; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxColumns; }
    insertRowsAfter(after, count) {
      assert.equal(after, this.maxRows, 'adapter only appends blank grid rows');
      assert.ok(count > 0);
      this.maxRows += count;
      state.writes += 1;
    }
    insertColumnsAfter(after, count) {
      assert.equal(after, this.maxColumns);
      assert.ok(count > 0);
      this.maxColumns += count;
      state.writes += 1;
    }
    getRange(row, column, height = 1, width = 1) {
      assert.ok(row > 0 && column > 0 && height > 0 && width > 0);
      if (row + height - 1 > this.maxRows || column + width - 1 > this.maxColumns) throw new Error('range exceeds grid limits');
      return {
        getValues: () => Array.from({ length: height }, (_, dy) =>
          Array.from({ length: width }, (_, dx) => this.rows[row - 1 + dy]?.[column - 1 + dx] ?? '')),
        createTextFinder: text => {
          let entire = false;
          return {
            matchEntireCell(value) { entire = value; return this; },
            findAll: () => {
              const found = [];
              for (let dy = 0; dy < height; dy += 1) {
                for (let dx = 0; dx < width; dx += 1) {
                  const value = String(this.rows[row - 1 + dy]?.[column - 1 + dx] ?? '');
                  if (entire ? value === text : value.includes(text)) found.push({ getRow: () => row + dy });
                }
              }
              return found;
            }
          };
        },
        setValues: values => {
          if (state.failWriteOnce) { state.failWriteOnce = false; throw new Error('simulated sheet failure'); }
          if (state.failCompletionWriteOnce && this === state.sheets[COMPLETION_SHEET] && row > 1) {
            state.failCompletionWriteOnce = false; throw new Error('simulated completion sheet failure');
          }
          assert.equal(values.length, height);
          values.forEach((valuesRow, dy) => {
            assert.equal(valuesRow.length, width);
            if (!this.rows[row - 1 + dy]) this.rows[row - 1 + dy] = [];
            valuesRow.forEach((value, dx) => { this.rows[row - 1 + dy][column - 1 + dx] = value; });
          });
          state.writes += 1;
        }
      };
    }
    deleteRows(row, count) { this.rows.splice(row - 1, count); this.maxRows -= count; state.writes += 1; }
  }
  if (options.sheet !== false) state.sheets.users = new Sheet(options.rows || [HEADERS]);
  if (options.completions !== false) state.sheets[COMPLETION_SHEET] = new Sheet(options.completionRows || [COMPLETION_HEADERS]);
  const book = {
    getSheetByName: name => state.sheets[name] || null,
    insertSheet: name => { assert.equal(state.sheets[name], undefined); return (state.sheets[name] = new Sheet()); }
  };
  const properties = {
    getProperty: name => Object.prototype.hasOwnProperty.call(props, name) ? props[name] : null,
    getProperties: () => ({ ...props }),
    setProperty: (name, value) => {
      if (state.failPendingOnce && name.startsWith(EVENT_PREFIX) && JSON.parse(value).status === 'pending') {
        state.failPendingOnce = false;
        throw new Error('simulated property failure');
      }
      props[name] = String(value); return properties;
    },
    deleteProperty: name => {
      if (state.failDeleteOnce && name.startsWith(EVENT_PREFIX)) { state.failDeleteOnce = false; throw new Error('simulated property deletion failure'); }
      delete props[name]; return properties;
    }
  };
  const core = options.core || {
    newUser: (id, now) => ({ user_id: id, message_count: 0, phase: 0, is_active: true, history: '[]', started_at: now }),
    respond: (user, text, ctx) => {
      state.coreCalls += 1;
      if (text === '停止' || text === '再開') return {
        user: { ...user, is_active: text === '再開' }, messages: [text + 'しました。'], counted: false
      };
      const counted = text !== '__follow__';
      const after = { ...user, is_active: true, last_reply_at: ctx.now };
      if (counted) {
        after.message_count = (Number(user.message_count) || 0) + 1;
        after.phase = Math.floor(after.message_count / 5);
        after.history = JSON.stringify([{ role: 'user', content: text }]);
      }
      return {
        user: after, messages: [counted ? `reply:${text}` : 'わたし、ミリー。'], counted,
        ...(text === '共有' ? { shareCard: { title: 'secret name', lines: ['private text'] } } : {})
      };
    }
  };
  const sandbox = {
    Date, JSON, Math, Object, Array, String, Number, Error, isFinite,
    PropertiesService: { getScriptProperties: () => properties },
    SpreadsheetApp: {
      openById: id => { assert.equal(id, 'test-sheet'); state.opens += 1; return book; },
      flush: () => {}
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: millis => { assert.equal(millis, 5000); if (options.busy) return false; state.locked = true; return true; },
        hasLock: () => state.locked,
        releaseLock: () => { state.locked = false; }
      })
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: content => ({ content, setMimeType() { return this; } })
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, text) => Array.from(crypto.createHash('sha256').update(text).digest()),
      getUuid: () => crypto.randomUUID(),
      newBlob: text => ({ getBytes: () => Array.from(Buffer.from(text)) }),
      formatDate: date => new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10)
    },
    UrlFetchApp: {
      fetch: (url, args) => {
        assert.ok(['https://api.line.me/v2/bot/message/reply', 'https://api.line.me/v2/bot/message/push'].includes(url));
        assert.equal(args.headers.Authorization, 'Bearer test-line-token');
        state.endpoints.push(url);
        state.headers.push({ ...args.headers });
        state.sends.push(JSON.parse(args.payload));
        const failure = state.failures.shift();
        const responseHeaders = state.responseHeaders.shift() || {};
        if (failure === 'network') throw new Error('network failure');
        return { getResponseCode: () => failure || 200, getHeaders: () => responseHeaders, getAllHeaders: () => responseHeaders };
      }
    },
    MillieCore: core
  };
  if (options.ai) sandbox.MillieAI = { enhance: (...args) => { state.aiCalls += 1; return options.ai(...args); } };
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: 'Runtime.gs' });
  return {
    state, props, sandbox,
    receive(events, secret = props.MILLIE_GATEWAY_SECRET) {
      return JSON.parse(sandbox.doPost({ postData: { contents: JSON.stringify({ gatewaySecret: secret, events }) } }).content);
    },
    receivePush(events) {
      return JSON.parse(sandbox.MillieRuntime.receivePushEvents(events).content);
    },
    user(id = 'U-test-user') {
      const sheet = state.sheets.users;
      const headers = sheet.rows[0];
      const row = sheet.rows.slice(1).find(values => values[headers.indexOf('user_id')] === id);
      if (!row) return null;
      return Object.fromEntries(headers.map((header, index) => [header, row[index] ?? '']));
    },
    records() {
      const pending = Object.entries(props).filter(([key]) => key.startsWith(EVENT_PREFIX)).map(([key, value]) => ({ key, ...JSON.parse(value) }));
      const done = (state.sheets[COMPLETION_SHEET]?.rows.slice(1) || []).map(([key, created, status]) => ({ key, v: 1, created, status }));
      return pending.concat(done);
    }
  };
}

function event(id = 'event-1', text = 'こんにちは', overrides = {}) {
  return {
    webhookEventId: id, replyToken: `reply-token-${id}`, timestamp: Date.now(), type: 'message',
    source: { type: 'user', userId: 'U-test-user' }, message: { type: 'text', id: `msg-${id}`, text }, ...overrides
  };
}

test('rejects direct / unauthenticated requests before accessing user data', () => {
  const h = harness();
  assert.deepEqual(h.receive([event()], 'wrong'), { ok: false, error: 'unauthorized' });
  assert.equal(h.state.opens, 0);
  assert.equal(h.state.coreCalls, 0);
  assert.equal(h.state.sends.length, 0);
  assert.deepEqual(JSON.parse(h.sandbox.doPost({ postData: { contents: '{' } }).content), { ok: false, error: 'invalid_json' });
  assert.equal(h.receive([]).ok, true);
  assert.equal(h.state.opens, 0);
});

test('uses header names and preserves reordered and extra existing columns', () => {
  const headers = [...HEADERS.slice().reverse(), 'operator_note'];
  const row = headers.map(name => ({ user_id: 'U-test-user', message_count: 9, phase: 1, is_active: 'TRUE', operator_note: '=untouched-formula' })[name] ?? '');
  const h = harness({ rows: [headers, row] });
  const originalHeaders = h.state.sheets.users.rows[0].slice();
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.user().message_count, 10);
  assert.equal(h.user().operator_note, '=untouched-formula');
  assert.deepEqual(h.state.sheets.users.rows[0], originalHeaders);
  assert.equal(h.sandbox.previewMigration().extra[0], 'operator_note');
});

test('read-only preview and installer never repair or clear existing schema', () => {
  const headers = HEADERS.filter(name => name !== 'history');
  const h = harness({ rows: [headers, ['U-existing']] });
  assert.equal(h.sandbox.previewMigration().ok, false);
  assert.equal(h.state.writes, 0);
  assert.throws(() => h.sandbox.installMillieV10(), /schema_missing_headers/);
  assert.equal(h.state.writes, 0);
  assert.equal(h.state.sheets.users.rows.length, 2);
  const fresh = harness({ sheet: false });
  assert.equal(fresh.sandbox.installMillieV10().ok, true);
  assert.equal(fresh.state.sheets.users.rows[0].length, 37);
  const writes = fresh.state.writes;
  assert.equal(fresh.sandbox.installMillieV10().ok, true);
  assert.equal(fresh.state.writes, writes);
  assert.ok(fresh.props.MILLIE_V10_INSTALLED_AT);
});

test('duplicate completed webhook does not count or reply twice; completed records contain metadata only', () => {
  const h = harness();
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.receive([event('event-1', 'こんにちは', { replyToken: 'new-token' })]).ok, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.state.sends.length, 1);
  const record = h.records()[0];
  assert.equal(record.status, 'done');
  assert.equal(Object.keys(record).sort().join(','), 'created,key,status,v');
  assert.ok(!JSON.stringify(record).includes('U-test-user'));
  assert.ok(!JSON.stringify(record).includes('こんにちは'));
});

test('failed LINE reply retains a fixed pending outbox; redelivery retries without recounting', () => {
  const h = harness();
  h.state.failures.push(500);
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.records()[0].status, 'pending');
  assert.equal(h.records()[0].patch, undefined);
  const result = h.receive([event('event-1', '改ざんされた再送文', { replyToken: 'fresh-token' })]);
  assert.equal(result.ok, true);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.user().message_count, 1);
  assert.deepEqual(h.state.sends[0].messages, h.state.sends[1].messages);
  assert.equal(h.state.sends[1].replyToken, 'fresh-token');
  assert.equal(h.records()[0].status, 'done');
});

test('expired or used reply tokens stay pending and never invoke a push API', () => {
  const h = harness();
  h.state.failures.push(400, 400);
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.records()[0].status, 'pending');
  assert.equal(h.state.sends.length, 2);
});

test('prepared journal recovers a failed sheet commit without rerunning Core', () => {
  const h = harness();
  h.state.failWriteOnce = true;
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.user(), null);
  assert.equal(h.records()[0].status, 'prepared');
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.state.sends.length, 1);
});

test('later user events finish an interrupted commit first and old retries do not roll back progress', () => {
  const h = harness();
  h.state.failPendingOnce = true;
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.records()[0].status, 'prepared');
  assert.equal(h.receive([event('event-2', '続き')]).ok, true);
  assert.equal(h.user().message_count, 2);
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.user().message_count, 2);
  assert.equal(h.state.coreCalls, 2);
});

test('follow greeting is uncounted; refollow keeps progress; unfollow deactivates', () => {
  const h = harness();
  assert.equal(h.receive([event('follow-1', '', { type: 'follow' })]).ok, true);
  assert.equal(h.user().message_count, 0);
  assert.equal(h.receive([event('message-1')]).ok, true);
  assert.equal(h.receive([event('unfollow-1', '', { type: 'unfollow', replyToken: undefined })]).ok, true);
  assert.equal(h.user().is_active, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.receive([event('follow-2', '', { type: 'follow' })]).ok, true);
  assert.equal(h.user().is_active, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.coreCalls, 2);
  const noUser = harness();
  assert.equal(noUser.receive([event('unfollow-only', '', { type: 'unfollow' })]).ok, true);
  assert.equal(noUser.user(), null);
});

test('ignores groups, rooms and non-text messages', () => {
  const h = harness();
  const response = h.receive([
    event('group', 'hello', { source: { type: 'group', userId: 'U-test-user', groupId: 'G-test' } }),
    event('image', '', { message: { type: 'image', id: 'image-1' } })
  ]);
  assert.equal(response.ok, true);
  assert.equal(response.skipped, 2);
  assert.equal(h.user(), null);
  assert.equal(h.state.coreCalls, 0);
  assert.equal(h.state.sends.length, 0);
});

test('shared Flex card contains fixed anonymous public copy and never profile data', () => {
  const h = harness();
  assert.equal(h.receive([event('share', '共有')]).ok, true);
  const flex = h.state.sends[0].messages.find(message => message.type === 'flex');
  assert.ok(flex);
  assert.ok(!JSON.stringify(flex).includes('secret name'));
  assert.ok(!JSON.stringify(flex).includes('private text'));
  assert.ok(!JSON.stringify(flex).includes('U-test-user'));
  assert.ok(JSON.stringify(flex).includes('https://line.me/R/ti/p/@575kepfk'));
});

test('record size and aggregate capacity fail before changing user state', () => {
  const large = harness({
    core: {
      newUser: id => ({ user_id: id, message_count: 0, is_active: true }),
      respond: user => ({ user: { ...user, message_count: 1 }, messages: Array.from({ length: 4 }, () => crypto.randomBytes(3000).toString('base64')), counted: true })
    }
  });
  const response = large.receive([event('large')]);
  assert.equal(response.ok, false);
  assert.equal(response.error, 'outbox_record_too_large');
  assert.equal(large.user(), null);
  assert.equal(large.state.sends.length, 0);
  const full = harness({ properties: { unrelated_existing_property: 'a'.repeat(400 * 1024) } });
  assert.equal(full.receive([event()]).error, 'outbox_capacity_reached');
  assert.equal(full.user(), null);
});

test('prunes event dedupe after the documented 24 hour window', () => {
  const h = harness();
  assert.equal(h.receive([event()]).ok, true);
  h.state.sheets[COMPLETION_SHEET].rows[1][1] = Date.now() - 25 * 3600000;
  h.props.MILLIE_DEDUPE_PRUNED_AT = '0';
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.user().message_count, 2);
  assert.equal(h.state.coreCalls, 2);
});

test('optional AI only runs when Core explicitly marks a response eligible', () => {
  const h = harness({ ai: () => { throw new Error('must not run'); } });
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.state.aiCalls, 0);
  const eligible = harness({
    core: {
      newUser: id => ({ user_id: id, message_count: 0 }),
      respond: user => ({ user: { ...user, message_count: 1 }, messages: ['core fallback'], counted: true, aiEligible: true })
    },
    ai: () => { throw new Error('AI failure'); }
  });
  assert.equal(eligible.receive([event()]).ok, true);
  assert.equal(eligible.state.aiCalls, 1);
  assert.equal(eligible.state.sends[0].messages[0].text, 'core fallback');
});

test('lock contention is bounded and does not mutate state', () => {
  const h = harness({ busy: true });
  assert.deepEqual(h.receive([event()]), { ok: false, error: 'busy' });
  assert.equal(h.state.opens, 0);
  assert.equal(h.state.coreCalls, 0);
});

test('stop / unfollow abandons older active outbox replies, including after a resume', () => {
  for (const stopEvent of [event('stop', '停止'), event('unfollow', '', { type: 'unfollow' })]) {
    const h = harness();
    h.state.failures.push(500);
    assert.equal(h.receive([event('earlier')]).ok, false);
    assert.equal(h.records()[0].status, 'pending');
    assert.equal(h.receive([stopEvent]).ok, true);
    assert.equal(h.user().is_active, false);
    assert.equal(h.records()[0].status, 'abandoned');
    assert.equal(h.receive([event('resume', '再開')]).ok, true);
    assert.equal(h.user().is_active, true);
    const sends = h.state.sends.length;
    assert.equal(h.receive([event('earlier')]).ok, true);
    assert.equal(h.state.sends.length, sends);
    assert.equal(h.user().message_count, 1);
  }
});

test('AI reply and its history persist together while progress remains Core-owned', () => {
  const history = JSON.stringify([{ role: 'assistant', content: 'AIの返信' }]);
  const h = harness({
    core: {
      newUser: id => ({ user_id: id, message_count: 0, is_active: true }),
      respond: user => ({ user: { ...user, message_count: 1, history: '[]' }, messages: ['core fallback'], counted: true, aiEligible: true })
    },
    ai: (_user, _text, result) => ({ ...result, messages: ['AIの返信'], user: { ...result.user, message_count: 999, history } })
  });
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.state.sends[0].messages[0].text, 'AIの返信');
  assert.equal(h.user().history, history);
  assert.equal(h.user().message_count, 1);
});

test('share cards select only Core-owned public copy by allowlisted topic ID', () => {
  const h = harness({
    core: {
      newUser: id => ({ user_id: id, message_count: 0, is_active: true }),
      respond: user => ({ user, messages: ['カードを置くね。'], counted: false, shareCard: { id: 'hanako', title: 'private title', lines: ['private history'] } }),
      publicCard: id => ({ title: id + 'の公開カード', lines: ['固定の公開文'] })
    }
  });
  assert.equal(h.receive([event('share-card')]).ok, true);
  const flex = JSON.stringify(h.state.sends[0].messages[1]);
  assert.ok(flex.includes('hanakoの公開カード'));
  assert.ok(flex.includes('固定の公開文'));
  assert.ok(!flex.includes('private title'));
  assert.ok(!flex.includes('private history'));
});

test('more than 2,000 successful events keep working and every completion still deduplicates', () => {
  const h = harness();
  for (let i = 0; i < 2105; i += 1) {
    const result = h.receive([event('viral-' + i, 'hello')]);
    assert.equal(result.ok, true, `event ${i}: ${JSON.stringify(result)}`);
  }
  assert.equal(h.user().message_count, 2105);
  assert.equal(h.state.sheets[COMPLETION_SHEET].rows.length, 2106);
  assert.ok(h.state.sheets[COMPLETION_SHEET].getMaxRows() >= 2106);
  assert.equal(Object.keys(h.props).filter(key => key.startsWith(EVENT_PREFIX)).length, 0);
  const sends = h.state.sends.length;
  for (const index of [0, 1999, 2000, 2104]) assert.equal(h.receive([event('viral-' + index, 'hello')]).ok, true);
  assert.equal(h.user().message_count, 2105);
  assert.equal(h.state.coreCalls, 2105);
  assert.equal(h.state.sends.length, sends);
  for (const row of h.state.sheets[COMPLETION_SHEET].rows.slice(1)) {
    assert.equal(row.length, 3);
    assert.ok(/^MILLIE_EVENT_[a-f0-9]{64}$/.test(row[0]));
    assert.ok(!JSON.stringify(row).includes('U-test-user'));
    assert.ok(!JSON.stringify(row).includes('hello'));
  }
});

test('migrates an already-full legacy done store before accepting the next event', () => {
  const legacy = {};
  const now = Date.now();
  for (let i = 0; i < 2000; i += 1) {
    const key = EVENT_PREFIX + crypto.createHash('sha256').update('legacy-' + i).digest('hex');
    legacy[key] = JSON.stringify({ v: 1, created: now, status: i % 2 ? 'abandoned' : 'done' });
  }
  const h = harness({ properties: legacy });
  assert.equal(h.receive([event('new-after-legacy')]).ok, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.sheets[COMPLETION_SHEET].rows.length, 2002);
  assert.ok(h.state.sheets[COMPLETION_SHEET].getMaxRows() >= 2002);
  assert.equal(Object.keys(h.props).filter(key => key.startsWith(EVENT_PREFIX)).length, 0);
  assert.equal(h.receive([event('legacy-0')]).ok, true);
  assert.equal(h.receive([event('legacy-1999')]).ok, true);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.state.sends.length, 1);
});

test('sheet completion survives failure to delete the pending property and suppresses its retry', () => {
  const h = harness();
  h.state.failDeleteOnce = true;
  assert.equal(h.receive([event()]).ok, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.state.sheets[COMPLETION_SHEET].rows.length, 2);
  assert.equal(Object.keys(h.props).filter(key => key.startsWith(EVENT_PREFIX)).length, 1);
  assert.equal(h.receive([event()]).ok, true);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.state.sends.length, 1);
  assert.equal(Object.keys(h.props).filter(key => key.startsWith(EVENT_PREFIX)).length, 0);
});

test('legacy migration keeps original dedupe records until its sheet write succeeds', () => {
  const key = EVENT_PREFIX + crypto.createHash('sha256').update('legacy-protected').digest('hex');
  const h = harness({ properties: { [key]: JSON.stringify({ v: 1, created: Date.now(), status: 'done' }) } });
  h.state.failCompletionWriteOnce = true;
  assert.equal(h.receive([event('next')]).ok, false);
  assert.ok(h.props[key]);
  assert.equal(h.state.coreCalls, 0);
  assert.equal(h.user(), null);
  assert.equal(h.receive([event('next')]).ok, true);
  assert.equal(h.props[key], undefined);
  assert.equal(h.receive([event('legacy-protected')]).ok, true);
  assert.equal(h.state.coreCalls, 1);
});

test('pending outbox ceiling remains bounded and fails before mutating user state', () => {
  const properties = {};
  for (let i = 0; i < 2000; i += 1) properties[EVENT_PREFIX + 'other-pending-' + i] = JSON.stringify({
    v: 1, created: Date.now(), status: 'pending', userHash: 'other', messages: []
  });
  const h = harness({ properties });
  assert.equal(h.receive([event('no-outbox-space')]).error, 'outbox_capacity_reached');
  assert.equal(h.user(), null);
  assert.equal(h.state.sends.length, 0);
});

test('expired completion cleanup preserves active metadata and every existing users column', () => {
  const now = Date.now();
  const old = now - 25 * 3600000;
  const h = harness({ completionRows: [
    COMPLETION_HEADERS,
    ['old-a', old, 'done'], ['keep-a', now, 'done'],
    ['old-b', old, 'done'], ['old-c', old, 'abandoned'], ['keep-b', now, 'abandoned']
  ] });
  assert.equal(h.receive([event()]).ok, true);
  const keys = h.state.sheets[COMPLETION_SHEET].rows.slice(1).map(row => row[0]);
  assert.ok(keys.includes('keep-a'));
  assert.ok(keys.includes('keep-b'));
  assert.ok(!keys.some(key => key.startsWith('old-')));
  assert.deepEqual(h.state.sheets.users.rows[0], HEADERS);
});

test('installer creates the separate metadata sheet; mismatched metadata headers fail closed', () => {
  const missing = harness({ completions: false });
  const result = missing.sandbox.installMillieV10();
  assert.ok(result.changes.includes('created_event_dedupe_sheet'));
  assert.deepEqual(missing.state.sheets[COMPLETION_SHEET].rows[0], COMPLETION_HEADERS);
  const malformed = harness({ completionRows: [['existing_unrelated_header'], ['do not overwrite']] });
  assert.equal(malformed.receive([event()]).error, 'schema_invalid_event_dedupe');
  assert.equal(malformed.state.coreCalls, 0);
  assert.equal(malformed.state.sheets[COMPLETION_SHEET].rows[1][0], 'do not overwrite');
  assert.equal(malformed.state.writes, 0);
});

test('new user past the 1,000-row grid expands rows and preserves existing rows and extra columns', () => {
  const headers = [...HEADERS, 'operator_note'];
  const rows = [headers];
  for (let i = 0; i < 999; i += 1) rows.push(headers.map(name => ({
    user_id: 'U-existing-' + i, name: '既存' + i, message_count: 4, operator_note: '=existing-formula-' + i
  })[name] ?? ''));
  const h = harness({ rows });
  assert.equal(h.state.sheets.users.getMaxRows(), 1000);
  assert.equal(h.receive([event('new-user-beyond-grid')]).ok, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.sheets.users.getLastRow(), 1001);
  assert.ok(h.state.sheets.users.getMaxRows() >= 1001);
  assert.equal(h.state.sheets.users.getMaxColumns(), headers.length);
  assert.deepEqual(h.state.sheets.users.rows.slice(0, 1000), rows);
});

test('internal push entrypoint sends to the event user without a reply token and deduplicates once', () => {
  const h = harness();
  const incoming = event('internal-push', 'こんにちは', { replyToken: undefined });
  assert.equal(h.receivePush([incoming]).ok, true);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.deepEqual(h.state.endpoints, ['https://api.line.me/v2/bot/message/push']);
  assert.deepEqual(h.state.sends[0], { to: 'U-test-user', messages: [{ type: 'text', text: 'reply:こんにちは' }] });
  assert.equal(h.receivePush([event('internal-push', '変更された再送文', { replyToken: undefined })]).ok, true);
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.user().message_count, 1);
});

test('failed internal push retries immutable messages without rerunning Core or recounting', () => {
  const h = harness();
  h.state.failures.push(500);
  assert.equal(h.receivePush([event('push-pending', 'はじめの文', { replyToken: undefined })]).ok, false);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.records()[0].status, 'pending');
  const retryKey = h.records()[0].pushRetryKey;
  assert.match(retryKey, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
  assert.equal(h.state.headers[0]['X-Line-Retry-Key'], retryKey);
  const original = JSON.parse(JSON.stringify(h.state.sends[0]));
  assert.equal(h.receivePush([event('push-pending', '違う再送文', { replyToken: undefined })]).ok, true);
  assert.deepEqual(h.state.sends[1], original);
  assert.equal(h.state.headers[1]['X-Line-Retry-Key'], retryKey);
  assert.deepEqual(h.state.endpoints, [
    'https://api.line.me/v2/bot/message/push', 'https://api.line.me/v2/bot/message/push'
  ]);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.records()[0].status, 'done');
});

test('public payload push flags cannot select push delivery or replace a missing reply token', () => {
  const h = harness();
  const post = incoming => JSON.parse(h.sandbox.doPost({ postData: { contents: JSON.stringify({
    gatewaySecret: h.props.MILLIE_GATEWAY_SECRET,
    deliveryMode: 'push', transport: 'push', push: true,
    events: [incoming]
  }) } }).content);
  assert.equal(post(event('public-flags', '通常返信', { deliveryMode: 'push', transport: 'push', push: true })).ok, true);
  assert.equal(h.state.endpoints[0], 'https://api.line.me/v2/bot/message/reply');
  assert.equal(h.state.sends[0].replyToken, 'reply-token-public-flags');
  assert.equal(h.state.sends[0].to, undefined);
  const before = h.state.sends.length;
  assert.equal(post(event('public-missing-token', '返信tokenなし', {
    replyToken: undefined, deliveryMode: 'push', transport: 'push', push: true
  })).ok, false);
  assert.equal(h.state.sends.length, before);
  assert.ok(!h.state.endpoints.includes('https://api.line.me/v2/bot/message/push'));
  assert.equal(post(event('public-missing-token', '再送', { replyToken: 'fresh-public-token', deliveryMode: 'push' })).ok, true);
  assert.equal(h.state.sends.at(-1).replyToken, 'fresh-public-token');
  assert.equal(h.state.endpoints.at(-1), 'https://api.line.me/v2/bot/message/reply');
  assert.equal(h.user().message_count, 2);
});

test('internal stop or unfollow abandons earlier push outbox replies through resume and replay', () => {
  for (const stop of [
    event('push-stop', '停止', { replyToken: undefined }),
    event('push-unfollow', '', { type: 'unfollow', replyToken: undefined })
  ]) {
    const h = harness();
    h.state.failures.push(500);
    assert.equal(h.receivePush([event('push-earlier', '以前の文', { replyToken: undefined })]).ok, false);
    assert.equal(h.records()[0].status, 'pending');
    assert.equal(h.receivePush([stop]).ok, true);
    assert.equal(h.user().is_active, false);
    assert.equal(h.records()[0].status, 'abandoned');
    const sentAtStop = h.state.sends.length;
    assert.equal(h.receivePush([event('push-earlier', '再送', { replyToken: undefined })]).ok, true);
    assert.equal(h.state.sends.length, sentAtStop);
    assert.equal(h.receivePush([event('push-resume', '再開', { replyToken: undefined })]).ok, true);
    assert.equal(h.user().is_active, true);
    const sentAtResume = h.state.sends.length;
    assert.equal(h.receivePush([event('push-earlier', '再々送', { replyToken: undefined })]).ok, true);
    assert.equal(h.state.sends.length, sentAtResume);
    assert.equal(h.user().message_count, 1);
    assert.ok(h.state.endpoints.every(url => url === 'https://api.line.me/v2/bot/message/push'));
  }
});

test('internal push Flex rendering stays anonymous and never renders untrusted share-card copy', () => {
  const h = harness();
  assert.equal(h.receivePush([event('push-share', '共有', { replyToken: undefined })]).ok, true);
  const payload = h.state.sends[0];
  assert.equal(payload.to, 'U-test-user');
  assert.equal(payload.replyToken, undefined);
  const card = payload.messages.find(message => message.type === 'flex');
  assert.ok(card);
  const rendered = JSON.stringify(card);
  assert.ok(!rendered.includes('secret name'));
  assert.ok(!rendered.includes('private text'));
  assert.ok(!rendered.includes('U-test-user'));
  assert.ok(rendered.includes('https://line.me/R/ti/p/@575kepfk'));
});

test('internal push preserves reordered 37-column schema, profiles, counters, and extra columns', () => {
  const headers = [...HEADERS.slice().reverse(), 'operator_note'];
  const preserved = { name: '既存名', workplace: '既存勤務先', secrets: '既存保管値', invite_count: 7, operator_note: '=existing-formula' };
  const values = { ...preserved, user_id: 'U-test-user', message_count: 8, phase: 1, is_active: true };
  const rows = [headers, headers.map(name => values[name] ?? '')];
  const h = harness({ rows });
  assert.equal(h.receivePush([event('push-schema', '会話', { replyToken: undefined })]).ok, true);
  assert.equal(h.user().message_count, 9);
  assert.deepEqual(h.state.sheets.users.rows[0], headers);
  assert.equal(h.state.sheets.users.getMaxColumns(), headers.length);
  for (const [name, value] of Object.entries(preserved)) assert.equal(h.user()[name], value, name);
});

test('internal push ignores group, room, and non-text events', () => {
  const h = harness();
  const result = h.receivePush([
    event('push-group', 'hello', { replyToken: undefined, source: { type: 'group', userId: 'U-test-user', groupId: 'G-test' } }),
    event('push-room', 'hello', { replyToken: undefined, source: { type: 'room', userId: 'U-test-user', roomId: 'R-test' } }),
    event('push-image', '', { replyToken: undefined, message: { type: 'image', id: 'synthetic-image' } })
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.skipped, 3);
  assert.equal(h.user(), null);
  assert.equal(h.state.coreCalls, 0);
  assert.equal(h.state.sends.length, 0);
});

test('pending events cannot cross between reply and internal push delivery modes', () => {
  for (const initiallyPush of [false, true]) {
    const h = harness();
    const incoming = event('fixed-delivery-mode', '元の文', { replyToken: initiallyPush ? undefined : 'original-reply-token' });
    const originalReceive = initiallyPush ? events => h.receivePush(events) : events => h.receive(events);
    const otherReceive = initiallyPush ? events => h.receive(events) : events => h.receivePush(events);
    h.state.failures.push(500);
    assert.equal(originalReceive([incoming]).ok, false);
    const original = JSON.parse(JSON.stringify(h.state.sends[0]));
    const endpoints = h.state.endpoints.slice();
    const result = otherReceive([event('fixed-delivery-mode', '変更した文')]);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'event_delivery_mode_mismatch');
    assert.equal(h.state.sends.length, 1);
    assert.deepEqual(h.state.endpoints, endpoints);
    assert.equal(h.state.coreCalls, 1);
    assert.equal(h.user().message_count, 1);
    assert.equal(originalReceive([incoming]).ok, true);
    assert.deepEqual(h.state.sends[1], original);
    assert.equal(h.state.coreCalls, 1);
    assert.equal(h.user().message_count, 1);
  }
});

test('pending push events cannot be replayed for a different user, even through another mode', () => {
  const h = harness();
  const incoming = event('fixed-user', '元の文', { replyToken: undefined });
  h.state.failures.push(500);
  assert.equal(h.receivePush([incoming]).ok, false);
  const altered = event('fixed-user', '他のユーザーの文', { source: { type: 'user', userId: 'U-different-user' } });
  for (const result of [h.receivePush([altered]), h.receive([altered])]) {
    assert.equal(result.ok, false);
    assert.equal(result.error, 'event_source_mismatch');
  }
  assert.equal(h.user('U-different-user'), null);
  assert.equal(h.state.sends.length, 1);
  assert.equal(h.state.coreCalls, 1);
  assert.equal(h.user().message_count, 1);
  assert.equal(h.receivePush([incoming]).ok, true);
  assert.equal(h.state.sends[1].to, 'U-test-user');
});

test('the public namespace receiver ignores a forged second argument requesting push', () => {
  const h = harness();
  const request = { postData: { contents: JSON.stringify({ gatewaySecret: h.props.MILLIE_GATEWAY_SECRET, events: [event('public-second-argument')] }) } };
  const result = JSON.parse(h.sandbox.MillieRuntime.receive(request, { deliveryMode: 'push', transport: 'push', push: true }).content);
  assert.equal(result.ok, true);
  assert.deepEqual(h.state.endpoints, ['https://api.line.me/v2/bot/message/reply']);
  assert.equal(h.state.sends[0].to, undefined);
  assert.equal(h.state.sends[0].replyToken, 'reply-token-public-second-argument');
});

test('reply requests never receive a push retry header, including reply retries', () => {
  const h = harness();
  h.state.failures.push(500);
  assert.equal(h.receive([event('reply-without-retry-key')]).ok, false);
  assert.equal(h.records()[0].pushRetryKey, undefined);
  assert.equal(h.receive([event('reply-without-retry-key')]).ok, true);
  for (const headers of h.state.headers) {
    assert.ok(!Object.keys(headers).some(name => name.toLowerCase() === 'x-line-retry-key'));
  }
});

test('push 409 with an accepted-request-id header is complete regardless of header casing', () => {
  for (const name of ['x-line-accepted-request-id', 'X-Line-Accepted-Request-Id', 'x-LiNe-AcCePtEd-ReQuEsT-Id']) {
    const h = harness();
    h.state.failures.push(409);
    h.state.responseHeaders.push({ [name]: 'synthetic-accepted-request-id' });
    const incoming = event('accepted-push-' + name, '会話', { replyToken: undefined });
    assert.equal(h.receivePush([incoming]).ok, true, name);
    assert.equal(h.records()[0].status, 'done');
    assert.equal(h.user().message_count, 1);
    assert.equal(h.state.coreCalls, 1);
    assert.equal(h.receivePush([incoming]).ok, true);
    assert.equal(h.state.sends.length, 1);
    assert.equal(h.state.coreCalls, 1);
  }
});

test('unconfirmed 409 remains pending and reuses the same key until a later successful push', () => {
  for (const responseHeaders of [{}, { 'x-line-request-id': 'unrelated-request-id' }, { 'x-line-accepted-request-id': '' }, { 'x-line-accepted-request-id': '   ' }]) {
    const h = harness();
    h.state.failures.push(409);
    h.state.responseHeaders.push(responseHeaders);
    const incoming = event('unconfirmed-push', '会話', { replyToken: undefined });
    assert.equal(h.receivePush([incoming]).ok, false);
    assert.equal(h.records()[0].status, 'pending');
    const key = h.records()[0].pushRetryKey;
    assert.equal(h.state.headers[0]['X-Line-Retry-Key'], key);
    assert.equal(h.receivePush([incoming]).ok, true);
    assert.equal(h.state.headers[1]['X-Line-Retry-Key'], key);
    assert.deepEqual(h.state.sends[0], h.state.sends[1]);
    assert.equal(h.state.coreCalls, 1);
    assert.equal(h.user().message_count, 1);
  }
});

test('accepted-request-id on a server error is not treated as an accepted duplicate', () => {
  const h = harness();
  h.state.failures.push(500);
  h.state.responseHeaders.push({ 'x-line-accepted-request-id': 'synthetic-id-on-error' });
  assert.equal(h.receivePush([event('error-with-accepted-id', '会話', { replyToken: undefined })]).ok, false);
  assert.equal(h.records()[0].status, 'pending');
  assert.equal(h.user().message_count, 1);
});

module.exports = { harness, event, HEADERS };
