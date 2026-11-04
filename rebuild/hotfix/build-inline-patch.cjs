'use strict';

// Builds an unapplied paste block. Never reads credentials or contacts services.
// The legacy callGemini() candidate/SAFETY check must remain outside this block.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const source = fs.readFileSync(path.join(__dirname, 'OutputGuard.gs'), 'utf8');
const outputPath = path.join(__dirname, 'legacy-inline-patch.txt');
const fallback = '……ごめんね。もう一度、おはなししてくれる？';

assert.ok(source.includes('function millieExtractDialogue_(candidate)'), 'Expected the reviewed extraction helper');
const patch = 'return (function(candidate) {\n' + source +
  '\n  return millieExtractDialogue_(candidate) || ' + JSON.stringify(fallback) + ';\n})(c);\n';

// A return block is valid only inside the existing callGemini() function.
// Compile and execute an enclosing synthetic function without touching that file.
const wrapped = '(function(c) {\n' + patch + '\n})';
const script = new vm.Script(wrapped, { filename: 'legacy-inline-patch.txt' });
let ioAttempts = 0;
const sandbox = {};
for (const name of ['Logger', 'console', 'UrlFetchApp', 'PropertiesService', 'SpreadsheetApp', 'CacheService', 'LockService']) {
  Object.defineProperty(sandbox, name, { get() { ioAttempts += 1; throw Error('Unexpected patch I/O'); } });
}
vm.createContext(sandbox);
const run = script.runInContext(sandbox);
const candidate = text => ({ finishReason: 'STOP', content: { parts: [{ text }] } });
const checks = [
  [candidate('こんにちは、ミリーだよ。'), 'こんにちは、ミリーだよ。'],
  [candidate('Hello. How was your day?'), 'Hello. How was your day?'],
  [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Synthetic note.' }, { text: 'おへんじ、届いたよ。' }] } }, 'おへんじ、届いたよ。'],
  [candidate('THOUGHTS: Synthetic note.'), fallback],
  [candidate('Now I need to answer briefly.'), fallback],
  [candidate('おへやのまどからだよ🌙'), fallback],
  [candidate('まどから外を見ているよ。'), 'まどから外を見ているよ。'],
  [null, fallback],
  [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'Synthetic note.' }] } }, fallback]
];
for (const [input, expected] of checks) {
  const before = JSON.stringify(input);
  assert.equal(run(input), expected);
  assert.equal(JSON.stringify(input), before, 'Patch must not modify candidate data');
}

// Preserve the observed outer guard exactly; the paste block replaces only the
// following var txt... / return txt || null lines, never these preconditions.
const outerSource = '(function(data) {\n' +
  'var c = data.candidates && data.candidates[0];\n' +
  "if (!c || c.finishReason === 'SAFETY') return null;\n" + patch + '\n})';
const outer = new vm.Script(outerSource, { filename: 'synthetic-legacy-callGemini.js' }).runInContext(sandbox);
assert.equal(outer({ candidates: [] }), null);
assert.equal(outer({ candidates: [{ ...candidate('Synthetic blocked response.'), finishReason: 'SAFETY' }] }), null);
assert.equal(outer({ candidates: [candidate('ANALYSIS: Synthetic note.')] }), fallback);
assert.equal(ioAttempts, 0, 'Patch must not access logging, network, or state services');
assert.ok(patch.includes(source), 'Embed the reviewed helper source verbatim');

fs.writeFileSync(outputPath, patch, 'utf8');
process.stdout.write('PASS: inline patch syntax, 9 dialogue cases, 3 outer-guard cases, no mutation or I/O.\n');
process.stdout.write('Generated hotfix/legacy-inline-patch.txt; no live project was changed.\n');
