'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, '../apps-script/Deployment.gs'), 'utf8');
const DEFAULTS = {
  SPREADSHEET_ID: 'private-sheet-id', CHANNEL_ACCESS_TOKEN: 'private-line-token',
  MILLIE_GATEWAY_SECRET: 'private-gateway-secret', MILLIE_AI_ENABLED: 'true',
  GEMINI_API_KEY: 'private-gemini-key', GEMINI_MODEL: 'gemini-test-model'
};

function harness(options = {}) {
  const values = { ...DEFAULTS, ...options.properties };
  const calls = [];
  let schemaCalls = 0;
  let writes = 0;
  const logs = [];
  const rejectWrite = () => { writes += 1; throw Error('unexpected write'); };
  const context = {
    PropertiesService: {
      getScriptProperties: () => {
        if (options.propertyServiceError) throw Error('private-line-token');
        return {
          getProperty: name => values[name] ?? null,
          setProperty: rejectWrite, setProperties: rejectWrite, deleteProperty: rejectWrite
        };
      }
    },
    previewMigration: () => {
      schemaCalls += 1;
      if (options.schemaError) throw Error('private-sheet-id private-gateway-secret');
      return options.schema ?? { ok: true, requiredColumns: 37, userRows: 999 };
    },
    UrlFetchApp: {
      fetch: (url, args) => {
        calls.push({ url, args });
        if (options.networkError) throw Error('private-line-token private-gemini-key');
        const line = url === 'https://api.line.me/v2/bot/info';
        const status = (line ? options.lineStatus : options.geminiStatus) ?? 200;
        const body = line ? (options.lineBody ?? {
          basicId: '@575kepfk', userId: 'unrelated-private-account-id', displayName: 'private display name'
        }) : (options.geminiBody ?? {
          name: 'models/' + values.GEMINI_MODEL, supportedGenerationMethods: ['countTokens', 'generateContent']
        });
        return {
          getResponseCode: () => status,
          getContentText: () => {
            if (status !== 200) throw Error('Do not inspect an error response body');
            return typeof body === 'string' ? body : JSON.stringify(body);
          }
        };
      }
    },
    Logger: { log: value => { logs.push(value); if (options.loggingError) throw Error('private-line-token'); } },
    console: { log: () => { throw Error('unexpected console logging'); } }
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'Deployment.gs' });
  return {
    context, values, calls, logs,
    run() { return JSON.parse(JSON.stringify(context.preflightMillieV10())); },
    stats() { return { schemaCalls, writes, logs: logs.length }; }
  };
}

function assertNoPrivateData(report, otherValues = []) {
  const serialized = JSON.stringify(report);
  const forbidden = [
    DEFAULTS.SPREADSHEET_ID, DEFAULTS.CHANNEL_ACCESS_TOKEN, DEFAULTS.MILLIE_GATEWAY_SECRET,
    DEFAULTS.GEMINI_API_KEY, 'unrelated-private-account-id', 'private display name', ...otherValues
  ];
  forbidden.forEach(value => assert.ok(!serialized.includes(value), 'private value must not appear in report'));
}

test('preflight succeeds using authenticated read-only GETs and emits only public identity metadata', () => {
  const h = harness();
  const report = h.run();
  assert.equal(report.ready, true);
  assert.equal(report.line.basicId, '@575kepfk');
  assert.equal(report.line.httpStatus, 200);
  assert.equal(report.gemini.modelId, DEFAULTS.GEMINI_MODEL);
  assert.equal(report.gemini.generateContent, true);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, 'https://api.line.me/v2/bot/info');
  assert.equal(h.calls[0].args.headers.Authorization, 'Bearer ' + DEFAULTS.CHANNEL_ACCESS_TOKEN);
  assert.equal(h.calls[1].url, 'https://generativelanguage.googleapis.com/v1beta/models/' + DEFAULTS.GEMINI_MODEL);
  assert.equal(h.calls[1].args.headers['x-goog-api-key'], DEFAULTS.GEMINI_API_KEY);
  h.calls.forEach(({ url, args }) => {
    assert.equal(args.method, 'get');
    assert.equal(args.followRedirects, false);
    assert.equal(args.muteHttpExceptions, true);
    assert.equal(args.payload, undefined);
    assert.ok(!url.includes(DEFAULTS.GEMINI_API_KEY));
    assert.ok(!url.includes(DEFAULTS.CHANNEL_ACCESS_TOKEN));
  });
  assert.deepEqual(h.stats(), { schemaCalls: 1, writes: 0, logs: 1 });
  assert.deepEqual(JSON.parse(h.logs[0]), report);
  assertNoPrivateData(report);
  assert.equal(h.context.doGet, undefined);
  assert.equal(h.context.doPost, undefined);
});

test('every required property is mandatory and the report shape is fixed', () => {
  Object.keys(DEFAULTS).forEach(name => {
    const h = harness({ properties: { [name]: '' } });
    const report = h.run();
    assert.equal(report.ready, false, name);
    assert.equal(report.configuration.ok, false, name);
    assert.equal(report.configuration.required[name], false);
    assert.deepEqual(Object.keys(report).sort(), ['ready', 'configuration', 'schema', 'line', 'gemini'].sort());
    assert.deepEqual(Object.keys(report.configuration).sort(), ['ok', 'required', 'aiEnabled', 'modelIdValid'].sort());
    assert.deepEqual(Object.keys(report.configuration.required).sort(), Object.keys(DEFAULTS).sort());
    assert.deepEqual(Object.keys(report.schema).sort(), ['checked', 'ok']);
    assert.deepEqual(Object.keys(report.line).sort(), ['checked', 'ok', 'httpStatus', 'basicId'].sort());
    assert.deepEqual(Object.keys(report.gemini).sort(), ['checked', 'ok', 'httpStatus', 'modelId', 'generateContent'].sort());
    assertNoPrivateData(report);
    assertNoPrivateData(JSON.parse(h.logs[0]));
    assert.equal(h.stats().writes, 0);
  });
});

test('AI disabled or a noncanonical enabled value prevents readiness', () => {
  for (const value of ['false', 'TRUE', '1', ' true ']) {
    const report = harness({ properties: { MILLIE_AI_ENABLED: value } }).run();
    assert.equal(report.configuration.aiEnabled, false);
    assert.equal(report.ready, false);
    assertNoPrivateData(report);
  }
});

test('a different LINE channel fails without exposing its basicId or account details', () => {
  const report = harness({ lineBody: {
    basicId: '@wrong-private-account', userId: 'wrong-private-user-id',
    displayName: DEFAULTS.CHANNEL_ACCESS_TOKEN
  } }).run();
  assert.equal(report.ready, false);
  assert.equal(report.line.ok, false);
  assert.equal(report.line.basicId, null);
  assert.equal(report.line.httpStatus, 200);
  assertNoPrivateData(report, ['@wrong-private-account', 'wrong-private-user-id']);
});

test('LINE and Gemini HTTP failures are reported without reading error bodies', () => {
  for (const status of [301, 401, 403, 429, 500]) {
    for (const service of ['line', 'gemini']) {
      const h = harness({ [service + 'Status']: status });
      const report = h.run();
      assert.equal(report.ready, false);
      assert.equal(report[service].ok, false);
      assert.equal(report[service].httpStatus, status);
      assertNoPrivateData(report);
    }
  }
});

test('schema failure or exception stays read-only and emits no sheet data or exception text', () => {
  for (const options of [
    { schema: { ok: false, missing: ['private-sheet-id'], extra: ['private-line-token'], userRows: 999 } },
    { schemaError: true }
  ]) {
    const h = harness(options);
    const report = h.run();
    assert.equal(report.ready, false);
    assert.deepEqual(report.schema, { checked: true, ok: false });
    assert.deepEqual(h.stats(), { schemaCalls: 1, writes: 0, logs: 1 });
    assertNoPrivateData(report);
    assert.ok(!JSON.stringify(report).includes('999'));
  }
});

test('invalid model configuration never becomes a URL or a reported identifier', () => {
  for (const model of ['models/gemini-test', '../private-model', 'gemini?key=private-gemini-key', ' model ']) {
    const h = harness({ properties: { GEMINI_MODEL: model } });
    const report = h.run();
    assert.equal(report.ready, false);
    assert.equal(report.configuration.modelIdValid, false);
    assert.equal(report.gemini.checked, false);
    assert.equal(report.gemini.modelId, null);
    assert.equal(h.calls.length, 1);
    assertNoPrivateData(report, [model]);
  }
});

test('Gemini must identify the requested model and support generateContent', () => {
  for (const body of [
    { name: 'models/unrelated-model-id', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/' + DEFAULTS.GEMINI_MODEL, supportedGenerationMethods: ['embedContent'] },
    { name: 'models/' + DEFAULTS.GEMINI_MODEL, supportedGenerationMethods: 'generateContent' },
    'invalid JSON private-gemini-key'
  ]) {
    const report = harness({ geminiBody: body }).run();
    assert.equal(report.ready, false);
    assert.equal(report.gemini.ok, false);
    assert.equal(report.gemini.generateContent, false);
    assertNoPrivateData(report, ['unrelated-model-id']);
  }
});

test('a credential accidentally pasted into model configuration is never emitted', () => {
  for (const name of ['CHANNEL_ACCESS_TOKEN', 'MILLIE_GATEWAY_SECRET', 'GEMINI_API_KEY', 'SPREADSHEET_ID']) {
    const report = harness({ properties: { GEMINI_MODEL: DEFAULTS[name] } }).run();
    assert.equal(report.ready, false);
    assert.equal(report.gemini.modelId, null);
    assertNoPrivateData(report);
  }
});

test('network, property-service, and logging exceptions never throw or expose their messages', () => {
  for (const options of [{ networkError: true }, { propertyServiceError: true }, { loggingError: true, schemaError: true }]) {
    const h = harness(options);
    let report;
    assert.doesNotThrow(() => { report = h.run(); });
    assert.equal(report.ready, false);
    assertNoPrivateData(report);
    assert.equal(h.stats().writes, 0);
    assert.equal(h.stats().logs, 1);
    assertNoPrivateData(JSON.parse(h.logs[0]));
  }
});
