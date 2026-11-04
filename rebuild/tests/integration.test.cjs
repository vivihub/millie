'use strict';

// Real Core / Runtime / AI integration; only Sheets, LINE, and Gemini I/O are mocked.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Reuse the adapter's harness without registering its separate unit tests.
const harnessModule = { exports: {} };
const harnessContext = {
  require: name => name === 'node:test' ? () => {} : require(name),
  __dirname, module: harnessModule, Buffer, console
};
vm.createContext(harnessContext);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'runtime.test.cjs'), 'utf8'), harnessContext);
const { harness, event, HEADERS } = harnessModule.exports;

function actualCore() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Core.gs'), 'utf8'), context);
  return context.MillieCore;
}

test('real Core + Runtime: follow, 52 counted turns, ending, and anonymous sharing', () => {
  const h = harness({ core: actualCore() });
  assert.equal(h.receive([event('follow', '', { type: 'follow' })]).ok, true);
  assert.equal(h.user().message_count, 0);
  for (let i = 1; i <= 52; i += 1) {
    const result = h.receive([event('turn-' + i, 'うん ' + i)]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(h.user().message_count, i);
    assert.ok(h.state.sends.at(-1).messages.length <= 3);
  }
  assert.ok(h.user().ending_type);
  assert.equal(h.receive([event('share', '共有')]).ok, true);
  assert.ok(h.state.sends.at(-1).messages.some(message => message.type === 'flex'));
  assert.equal(h.user().message_count, 52);
});

test('real Core + Runtime: maximum Japanese input fits history and outbox limits', () => {
  const h = harness({ core: actualCore() });
  for (let i = 1; i <= 12; i += 1) {
    const result = h.receive([event('long-' + i, '長'.repeat(5000))]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(Buffer.byteLength(h.user().history, 'utf8') <= 2400);
  }
  assert.equal(h.user().message_count, 12);
});

test('real Core + Runtime: polite stopping suppresses old pending replies after resume', () => {
  const h = harness({ core: actualCore() });
  h.state.failures.push(500);
  assert.equal(h.receive([event('pending', 'ともだちとけんかした')]).ok, false);
  assert.equal(h.receive([event('stop', 'やめてください')]).ok, true);
  assert.equal(h.user().is_active, false);
  const sentAtStop = h.state.sends.length;
  assert.equal(h.receive([event('pending', 'ともだちとけんかした')]).ok, true);
  assert.equal(h.state.sends.length, sentAtStop);
  assert.equal(h.receive([event('resume', '再開')]).ok, true);
  assert.equal(h.user().is_active, true);
  assert.equal(h.receive([event('pending', 'ともだちとけんかした')]).ok, true);
  assert.equal(h.state.sends.length, sentAtStop + 1);
  assert.equal(h.user().message_count, 1);
});

test('real Core + Runtime: reset preserves existing profiles, referral count, and extra columns', () => {
  const headers = [...HEADERS.slice().reverse(), 'operator_note'];
  const expected = {
    name: '既存名前', location: '旧住所', workplace: '既存勤務先',
    invite_count: 7, operator_note: '=untouched-formula'
  };
  const values = {
    ...expected, user_id: 'U-test-user', message_count: 9, phase: 2, is_active: true
  };
  const row = headers.map(name => values[name] ?? '');
  const h = harness({ core: actualCore(), rows: [headers, row] });
  assert.equal(h.receive([event('reset', 'もう一度')]).ok, true);
  for (const [name, value] of Object.entries(expected)) assert.equal(h.user()[name], value, name);
  assert.equal(h.user().message_count, 0);
  assert.deepEqual(h.state.sheets.users.rows[0], headers);
});

test('real Core + AI + Runtime: actual reply is remembered across repeated input', () => {
  const h = harness({
    core: actualCore(),
    properties: { MILLIE_AI_ENABLED: 'true', GEMINI_MODEL: 'test-model', GEMINI_API_KEY: 'fake-test-key' }
  });
  const lineFetch = h.sandbox.UrlFetchApp.fetch;
  const requests = [];
  h.sandbox.UrlFetchApp.fetch = (url, options) => {
    if (!url.startsWith('https://generativelanguage.googleapis.com/')) return lineFetch(url, options);
    requests.push(JSON.parse(options.payload));
    const text = JSON.stringify({ messages: ['実際のAI返答 ' + requests.length] });
    return {
      getResponseCode: () => 200,
      getContentText: () => JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }] })
    };
  };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/AI.gs'), 'utf8'), h.sandbox);
  for (let i = 1; i <= 2; i += 1) {
    assert.equal(h.receive([event('ai-' + i, 'こんにちは')]).ok, true);
    assert.equal(h.state.sends.at(-1).messages[0].text, '実際のAI返答 ' + i);
    assert.equal(JSON.parse(h.user().history).at(-1).content, '実際のAI返答 ' + i);
  }
  assert.equal(requests[1].contents.map(item => item.role).join(','), 'user,model,user');
  assert.ok(requests[1].contents.some(item => item.parts.some(part => part.text === '実際のAI返答 1')));
});
