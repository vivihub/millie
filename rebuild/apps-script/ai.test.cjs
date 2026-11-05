'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(path.join(__dirname, 'AI.gs'), 'utf8');
const SAFE_REPLY = 'うん。今日は、何があったの？';

function fallback(messages = ['固定のおへんじ。']) {
  return {
    aiEligible: true, messages,
    user: {
      message_count: 1,
      history: JSON.stringify([
        { role: 'user', content: 'test' },
        ...messages.map(content => ({ role: 'assistant', content }))
      ])
    }
  };
}

function harness(options = {}) {
  const properties = {
    MILLIE_AI_ENABLED: 'true', GEMINI_MODEL: 'test-model', GEMINI_API_KEY: 'fake-test-key',
    ...options.properties
  };
  const state = { requests: [], prompts: [], logs: [] };
  const content = options.rawOutput ?? JSON.stringify({ messages: options.messages ?? [SAFE_REPLY] });
  const parts = options.parts ?? [{ text: content }];
  const body = options.body ?? { candidates: [{ finishReason: options.finishReason ?? 'STOP', content: { parts } }] };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: name => properties[name] }) },
    Utilities: { newBlob: value => ({ getBytes: () => Buffer.from(value, 'utf8') }) },
    MillieCore: {
      buildPrompt(user, input) {
        state.prompts.push({ user: JSON.parse(JSON.stringify(user)), input });
        return { systemInstruction: { parts: [] }, contents: [{ role: 'user', parts: [{ text: input }] }] };
      }
    },
    UrlFetchApp: {
      fetch(url, args) {
        state.requests.push({ url, args });
        if (options.networkError) throw Error('provider failure containing private test data');
        return {
          getResponseCode: () => options.status ?? 200,
          getContentText: () => typeof body === 'string' ? body : JSON.stringify(body)
        };
      }
    },
    Logger: { log: value => state.logs.push(value) },
    console: { log: value => state.logs.push(value), error: value => state.logs.push(value) }
  };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: 'AI.gs' });
  return {
    state,
    enhance(result = fallback(), before = {}, input = 'test') { return context.MillieAI.enhance(before, input, result, {}); }
  };
}

function assertRejected(options) {
  const h = harness(options);
  const original = fallback();
  const snapshot = JSON.stringify(original);
  const actual = h.enhance(original);
  assert.equal(actual, original, 'the entire original fallback must be returned');
  assert.equal(JSON.stringify(original), snapshot, 'rejection must not change persisted history');
  assert.equal(h.state.logs.length, 0, 'provider content must never be logged');
}

test('valid ordinary replies use the configured API header and persist the actual answer', () => {
  const h = harness();
  const original = fallback();
  const before = { history: JSON.stringify([{ role: 'assistant', content: '前の返事。' }]) };
  const actual = h.enhance(original, before);
  assert.equal(actual.messages[0], SAFE_REPLY);
  assert.equal(JSON.parse(actual.user.history).at(-1).content, SAFE_REPLY);
  assert.equal(original.messages[0], '固定のおへんじ。');
  assert.equal(h.state.prompts[0].user.history, before.history);
  assert.equal(h.state.requests[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
  assert.equal(h.state.requests[0].args.headers['x-goog-api-key'], 'fake-test-key');
  assert.equal(h.state.logs.length, 0);
});

test('Gemini 2.5 Flash variants disable thinking while preserving the v10 response settings', () => {
  for (const model of ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-preview-test']) {
    const h = harness({ properties: { GEMINI_MODEL: model } });
    assert.equal(h.enhance().messages[0], SAFE_REPLY);
    const request = h.state.requests[0];
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent');
    assert.deepEqual(JSON.parse(request.args.payload).generationConfig, {
      temperature: 0.65, maxOutputTokens: 400, responseMimeType: 'application/json',
      thinkingConfig: { thinkingBudget: 0, includeThoughts: false }
    });
    assert.equal(request.args.headers['x-goog-api-key'], 'fake-test-key');
    assert.equal(h.state.logs.length, 0);
  }
});

test('other model families keep the original v10 generation configuration', () => {
  for (const model of ['test-model', 'gemini-2.0-flash-lite', 'gemini-2.5-pro', 'gemini-2.5-flashish']) {
    const h = harness({ properties: { GEMINI_MODEL: model } });
    assert.equal(h.enhance().messages[0], SAFE_REPLY);
    assert.deepEqual(JSON.parse(h.state.requests[0].args.payload).generationConfig, {
      temperature: 0.65, maxOutputTokens: 400, responseMimeType: 'application/json'
    });
    assert.equal(h.state.logs.length, 0);
  }
});

test('disabled AI, story milestones, share responses, and invalid credentials never call the provider', () => {
  for (const options of [
    { properties: { MILLIE_AI_ENABLED: 'false' } },
    { properties: { GEMINI_API_KEY: '' } },
    { properties: { GEMINI_MODEL: '../invalid' } }
  ]) {
    const h = harness(options), result = fallback();
    assert.equal(h.enhance(result), result);
    assert.equal(h.state.requests.length, 0);
  }
  for (const extra of [{ aiEligible: false }, { shareCard: { id: 'echo' } }]) {
    const h = harness(), result = { ...fallback(), ...extra };
    assert.equal(h.enhance(result), result);
    assert.equal(h.state.requests.length, 0);
  }
});

test('provider errors, incomplete candidates, and invalid JSON preserve the fallback', () => {
  for (const options of [
    { networkError: true }, { status: 503 }, { body: 'not JSON' }, { body: {} },
    { finishReason: 'MAX_TOKENS' }, { rawOutput: 'not JSON' }
  ]) assertRejected(options);
});

test('the generated message array is nonempty, short, and limited to three bubbles', () => {
  for (const messages of [[], ['a', 'b', 'c', 'd'], [''], ['   '], [null], ['あ'.repeat(101)]]) {
    assertRejected({ messages });
  }
});

test('URLs, internal settings, unsolicited invitation counts, and existing surveillance markers are rejected', () => {
  for (const message of [
    'https://example.test', '```json', 'GEMINI_API_KEYを見てね', '３人に紹介してね',
    'カメラで見ているよ', '実際に監視しているよ'
  ]) assertRejected({ messages: [message] });
});

test('Gemini API thought:true parts are excluded before decoding the ordinary answer', () => {
  const h = harness({ parts: [
    { thought: true, text: 'API構造で思考と分類されたテスト用部品。', thoughtSignature: 'private-test-signature' },
    { text: '{"messages":[' }, { text: JSON.stringify(SAFE_REPLY) + ']}' }
  ] });
  const actual = h.enhance();
  assert.equal(actual.messages[0], SAFE_REPLY);
  assert.ok(!JSON.stringify(actual).includes('private-test-signature'));
  assert.ok(!JSON.stringify(actual).includes('API構造'));
  assert.equal(h.state.logs.length, 0);
  assertRejected({ parts: [{ thought: true, text: JSON.stringify({ messages: [SAFE_REPLY] }) }] });
});

test('meta headings in ordinary JSON message text reject the complete candidate', () => {
  for (const message of [
    'THOUGHTS: The user replied. I should respond in character.',
    'analysis: respond in character.', 'Internal reasoning: choose a reply.',
    '## ANALYSIS:\nChoose a reply.', '**THOUGHTS:** Choose a reply.',
    '- THOUGHTS: Choose a reply.',
    'THOUGHTS\nChoose a reply.', '## Analysis\nChoose a reply.',
    'ユーザー分析：相手は驚いている。', '【ユーザー分析】相手は驚いている。',
    '【ユーザーの分析】相手は驚いている。',
    '思考過程: 返事を考える。', '内部推論：短く返す。', '応答方針: 短くする。',
    'ふつうのおへんじ。\nTHOUGHTS: choose the next reply.',
    '[analysis] choose a reply.', 'The user responded with a short reply.', 'Now I need to answer briefly.'
  ]) assertRejected({ messages: [message] });
});

test('think tags and analysis channel markers in generated text reject all bubbles without salvage', () => {
  for (const message of [
    '<think>テスト用メタ文。</think>おへんじ。', '<thinking>テスト用メタ文。</thinking>',
    '<analysis>テスト用メタ文。</analysis>', '<|analysis|>テスト用メタ文。'
  ]) assertRejected({ messages: [SAFE_REPLY, message] });
});

test('ordinary explanations and quoted marker names remain valid conversation', () => {
  for (const message of [
    '「THOUGHTS:」は英語の見出しだよ。', 'analysisは「分析」っていう意味だよ。',
    '「<think>」はタグの書き方の例だよ。', 'ユーザー分析という言葉は、相手の傾向を考えることだよ。',
    'Thoughts about this song? って、曲の感想をきいてるんだよ。',
    '「The user responded with」は「利用者が返答した」という意味だよ。',
    '「おへやのまどから」というせりふは、こわいね。',
    '「部屋の窓から見ている」は物語の演出で、実際には見えないよ。',
    '窓を開けて、空気を入れかえてみてね。', 'カメラや位置情報は見られないよ。'
  ]) {
    const h = harness({ messages: [message] });
    assert.equal(h.enhance().messages[0], message);
    assert.equal(h.state.logs.length, 0);
  }
});

test('the reported window fragment and direct physical surveillance claims fall back', () => {
  for (const message of [
    'おへやのまどから', 'おへやのまどから。', 'おへやのまどからだよ🌙', 'あなたの部屋の窓からだよ。',
    '部屋の窓から見ているよ。', '部屋窓から見ているよ。', 'おへやのまどから、ずっとあなたをみてるよ。',
    'I am watching you through your window.', 'I can see you from your bedroom window.'
  ]) assertRejected({ messages: [message] });
});

test('one contaminated bubble keeps every original fallback bubble and history entry', () => {
  const h = harness({ messages: [SAFE_REPLY, 'THOUGHTS: choose the next reply.', 'おへやのまどから'] });
  const original = fallback(['固定の一文目。', '固定の二文目。']);
  const snapshot = JSON.stringify(original);
  assert.equal(h.enhance(original), original);
  assert.equal(JSON.stringify(original), snapshot);
  assert.equal(h.state.logs.length, 0);
});

test('known meta assistant history is excluded while user quotations and the current question remain', () => {
  const h = harness();
  const quotation = '「THOUGHTS:」と表示されたけど、どういう意味？';
  const previous = [
    { role: 'assistant', content: 'THOUGHTS: Choose a short reply.' },
    { role: 'model', content: 'ANALYSIS: Choose a short reply.' },
    { role: 'user', content: quotation },
    { role: 'assistant', content: 'ふつうの前の返事。' }
  ];
  const result = fallback();
  result.user.history = JSON.stringify([
    ...previous, { role: 'user', content: quotation },
    { role: 'assistant', content: result.messages[0] }
  ]);
  const actual = h.enhance(result, { history: JSON.stringify(previous) }, quotation);
  const promptHistory = JSON.parse(h.state.prompts[0].user.history);
  assert.equal(promptHistory.filter(entry => /^(assistant|model)$/.test(entry.role)).length, 1);
  assert.ok(promptHistory.some(entry => entry.role === 'user' && entry.content === quotation));
  assert.equal(h.state.prompts[0].input, quotation);
  const savedHistory = JSON.parse(actual.user.history);
  assert.ok(!savedHistory.some(entry => /^(assistant|model)$/.test(entry.role) && /THOUGHTS:|ANALYSIS:/.test(entry.content)));
  assert.ok(savedHistory.some(entry => entry.role === 'user' && entry.content === quotation));
  assert.equal(h.state.logs.length, 0);
});

test('legacy text and mixed-field meta assistant history are excluded while legacy user quotations stay', () => {
  const h = harness();
  const quotation = '「THOUGHTS:」という表示について説明して。';
  const previous = [
    { role: 'model', text: 'THOUGHTS: Synthetic legacy note.' },
    { role: 'assistant', text: 'ANALYSIS: Synthetic legacy note.' },
    { role: 'assistant', content: 'ふつうの文。', text: 'THOUGHTS: Synthetic mixed-field note.' },
    { role: 'user', text: quotation },
    { role: 'model', text: 'ふつうの旧形式の返事。' },
    { role: 'assistant', content: 'ふつうの新形式の返事。' }
  ];
  const before = { history: JSON.stringify(previous) };
  const originalBefore = before.history;
  const result = fallback();
  result.user.history = JSON.stringify([
    ...previous, { role: 'user', content: quotation },
    { role: 'assistant', content: result.messages[0] }
  ]);
  const actual = h.enhance(result, before, quotation);
  const promptHistory = JSON.parse(h.state.prompts[0].user.history);
  assert.equal(promptHistory.filter(entry => /^(assistant|model)$/.test(entry.role)).length, 2);
  assert.ok(promptHistory.some(entry => entry.role === 'user' && entry.text === quotation));
  assert.equal(h.state.prompts[0].input, quotation);
  assert.ok(promptHistory.some(entry => entry.role === 'model' && entry.text === 'ふつうの旧形式の返事。'));
  const savedHistory = JSON.parse(actual.user.history);
  assert.ok(!savedHistory.some(entry => /^(assistant|model)$/.test(entry.role) &&
    [entry.content, entry.text].some(text => typeof text === 'string' && /THOUGHTS:|ANALYSIS:/.test(text))));
  assert.ok(savedHistory.some(entry => entry.role === 'user' && entry.text === quotation));
  assert.ok(savedHistory.some(entry => entry.role === 'user' && entry.content === quotation));
  assert.equal(before.history, originalBefore);
  assert.equal(h.state.logs.length, 0);
});

test('accepted answers replace every fallback bubble and keep the UTF-8 history budget', () => {
  const h = harness({ messages: ['短い返答。'] });
  const original = fallback(['固定の一文目。', '固定の二文目。']);
  original.user.history = JSON.stringify([
    ...Array.from({ length: 8 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: '長'.repeat(100) })),
    ...JSON.parse(original.user.history)
  ]);
  const actual = h.enhance(original);
  const history = JSON.parse(actual.user.history);
  assert.equal(history.at(-1).content, '短い返答。');
  assert.ok(!actual.user.history.includes('固定の'));
  assert.ok(Buffer.byteLength(actual.user.history, 'utf8') <= 2400);
  assert.equal(h.state.logs.length, 0);
});
