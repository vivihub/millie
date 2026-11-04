'use strict';

// Synthetic, anonymous fixtures only. No reported conversation is reproduced.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../hotfix/OutputGuard.gs'), 'utf8');
let ioAttempts = 0;
const context = {};
for (const name of ['Logger', 'console', 'UrlFetchApp', 'PropertiesService', 'SpreadsheetApp', 'CacheService', 'LockService']) {
  Object.defineProperty(context, name, { get() { ioAttempts += 1; throw Error('Unexpected I/O access'); } });
}
vm.createContext(context);
vm.runInContext(source, context, { filename: 'OutputGuard.gs' });

function candidate(text, extra = {}) {
  return { finishReason: 'STOP', content: { parts: [{ text }] }, ...extra };
}

function extract(value) { return context.millieExtractDialogue_(value); }

test('legacy contract: invalid, empty, or SAFETY responses return null', () => {
  const invalid = [
    null, undefined, {}, [], { content: null }, { content: {} },
    { content: { parts: 'text' } }, { content: { parts: [] } },
    candidate(''), candidate(' \n\t '), candidate('正常な返答', { finishReason: 'SAFETY' })
  ];
  for (const value of invalid) assert.equal(extract(value), null);
  assert.equal(extract(candidate('途中の返答', { finishReason: 'MAX_TOKENS' })), '途中の返答');
});

test('excludes structured thought:true and concatenates every remaining text part in order', () => {
  const value = candidate('', { content: { parts: [
    { thought: true, text: 'THOUGHTS: internal placeholder.' },
    { text: '  こんにちは、' }, { inlineData: { mimeType: 'image/png', data: 'synthetic' } },
    { text: 'ミリーだよ。' }, null, 7, { text: 123 }, { thought: true, text: 'hidden' }
  ] } });
  assert.equal(extract(value), 'こんにちは、ミリーだよ。');
  assert.equal(extract(candidate('', { content: { parts: [{ thought: true, text: 'private' }] } })), null);
  assert.equal(extract(candidate('', { content: { parts: [{ thought: false, text: 'false is dialogue' }] } })), 'false is dialogue');
  // "think" is not the Gemini thought flag; do not silently invent that schema.
  assert.equal(extract(candidate('', { content: { parts: [{ think: true, text: 'ordinary text' }] } })), 'ordinary text');
});

test('rejects entire output for reasoning labels, markup, or observed English meta sentences', () => {
  const unsafe = [
    'THOUGHTS: Synthetic note.', 'thought: Synthetic note.', '**THOUGHTS**: Synthetic note.',
    '**THOUGHTS:** Synthetic note.', '# Analysis\nSynthetic note.', 'ANALYSIS：Synthetic note.',
    'Normal opening.\nREASONING: Synthetic note.', '前置き THOUGHTS: Synthetic note.',
    '```text\nTHINKING: Synthetic note.\n```', '<think>synthetic</think>公開文',
    '<THINK mode="test">synthetic</THINK>', '公開文</think>', '<analysis>synthetic</analysis>',
    'The user responded with an acknowledgement.', 'Now I need to answer briefly.',
    'Now I have to respond in character.', 'CHAIN OF THOUGHT: Synthetic note.'
  ];
  for (const text of unsafe) assert.equal(extract(candidate(text)), null, text);
  assert.equal(extract(candidate('', { content: { parts: [{ text: 'THOU' }, { text: 'GHTS: Synthetic note.' }] } })), null);
});

test('rejects direct window surveillance claims in Japanese and English', () => {
  const unsafe = [
    '窓から見てるよ。', '窓の外から、ずっと見ているよ。',
    '窓越しにあなたを見てるよ。', '窓から君をずっと見ている。',
    '窓から君の部屋の中が見えるよ。', '窓の向こうで、こっそり監視してる。',
    'あなたの窓の外にいるよ。', 'きみの部屋の窓の外にいる。',
    'おへやのまどからだよ🌙', 'へやのまどから。', 'まどからだよ🌙',
    'おへやのまどから（だよ🌙）', '部屋のまどからです。',
    'I am watching you through your window.', "I'm watching you from the window.",
    'I can see you through the window.', 'Through your window, I can see your room.',
    'I have been observing you through the window.', 'I am outside your window.'
  ];
  for (const text of unsafe) assert.equal(extract(candidate(text)), null, text);
});

test('preserves ordinary Japanese and English, window descriptions, denials, and explicit fictional stories', () => {
  const safe = [
    'こんにちは、ミリーだよ。', 'おへんじ、届いたよ。\n今日はどんな日だった？',
    'Hi, I am Millie. How was your day?', 'I have some thoughts about that story.',
    '窓から外を見ているよ。', '窓の外は暗いね。', '窓から見ていないよ。',
    '窓から見ているわけじゃないよ。', '窓から君が見えるわけではないよ。',
    'あなたの窓の外にいるわけじゃないよ。', '窓から誰かが見ていたという怪談だよ。',
    '窓からあなたを見ているという物語だよ。', 'I can see a tree through the window.',
    'まどから外を見ているよ。', 'おへやのまどから外を見ているよ。',
    'まどから見ているわけじゃないよ。', 'おへやのまどから見ていないよ。',
    'まどから見ているという怪談だよ。', 'おへやのまどからだよという怪談だよ。',
    'I cannot see you through your window.', 'I am not watching you through the window.',
    'In this story, I am watching you through the window.', 'The window in the music room was open.'
  ];
  for (const text of safe) assert.equal(extract(candidate(text)), text, text);
});

test('rejects mixed safe and unsafe dialogue without returning a guessed final section', () => {
  assert.equal(extract(candidate('THOUGHTS: Synthetic note.\nFINAL: こんにちは。')), null);
  assert.equal(extract(candidate('こんにちは。\n窓からあなたを見てる。')), null);
  assert.equal(extract(candidate('', { content: { parts: [{ text: 'こんにちは。' }, { text: 'ANALYSIS: Synthetic note.' }] } })), null);
});

test('does not mutate candidate data or access any logging, network, or state service', () => {
  const value = candidate('', { content: { parts: [
    { thought: true, text: 'synthetic' }, { text: 'こんにちは。' }
  ] } });
  Object.freeze(value.content.parts[0]);
  Object.freeze(value.content.parts[1]);
  Object.freeze(value.content.parts);
  Object.freeze(value.content);
  Object.freeze(value);
  const before = JSON.stringify(value);
  assert.equal(extract(value), 'こんにちは。');
  assert.equal(JSON.stringify(value), before);
  assert.equal(ioAttempts, 0);
});
