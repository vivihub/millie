'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'Core.gs'), 'utf8'), sandbox);
const core = sandbox.MillieCore;
const ctx = { now: '2026-11-04T04:00:00.000Z', dateKey: '2026-11-04' };
const fresh = id => core.newUser(id || 'U_TEST', ctx.now);
const json = value => JSON.parse(JSON.stringify(value));
let assertions = 0;
function check(label, fn) {
  try { fn(); assertions++; }
  catch (error) { error.message = label + ': ' + error.message; throw error; }
}
function reply(user, text, context) {
  const result = core.respond(user, text, context || ctx);
  assert.ok(result.messages.length >= 1 && result.messages.length <= 3);
  assert.ok(result.messages.every(message => typeof message === 'string'));
  return result;
}

check('37 columns and no automatic profile collection', () => {
  const user = fresh();
  assert.equal(core.SCHEMA.length, 37);
  assert.equal(Object.keys(user).length, 37);
  assert.equal(user.name, '');
  for (const column of ['location', 'workplace', 'live_alone', 'sleep_time', 'secrets']) assert.equal(user[column], '');
});

for (const [index, count] of [5, 10, 15, 20, 25, 30, 38, 45, 52].entries()) {
  check(`phase boundary ${count}`, () => {
    const user = fresh();
    user.message_count = count - 1;
    user.phase = 99;
    const result = reply(user, 'おはなしのつづきを聞かせて');
    assert.equal(result.user.message_count, count);
    assert.equal(result.user.phase, index + 2);
    assert.equal(result.counted, true);
    assert.equal(result.aiEligible, false);
    assert.equal(user.message_count, count - 1);
  });
}
check('legacy phase is derived only from count', () => {
  const result = reply(Object.assign(fresh(), { phase: 10, message_count: '23' }), '今日のことを話すね');
  assert.equal(result.user.message_count, 24);
  assert.equal(result.user.phase, 5);
  assert.equal(result.user.ending_type, '');
});

for (const [id, topic, score] of [['truth', 'hanako', 0], ['reply', 'ongaku', 0], ['belonging', 'akai', 0], ['listener', '', 3], ['echo', '', 0]]) {
  check(`ending ${id} locks`, () => {
    const user = Object.assign(fresh(), { message_count: 51, topics: JSON.stringify(topic ? [topic] : []), pos_score: score });
    const result = reply(user, 'つづきを話すね');
    assert.equal(result.user.ending_type, id);
    assert.equal(result.user.phase, 10);
    assert.equal(result.user.message_count, 52);
    const after = reply(result.user, 'まだ話してもいい？');
    assert.equal(after.counted, false);
    assert.equal(after.user.message_count, 52);
    assert.equal(after.user.ending_type, id);
    const resume = reply(after.user, '再開');
    assert.equal(resume.user.ending_type, id);
    assert.equal(resume.counted, false);
    const reset = reply(resume.user, 'もう一度');
    assert.equal(reset.user.ending_type, '');
    assert.equal(reset.user.message_count, 0);
  });
}
check('legacy ending is preserved without migration', () => {
  const user = Object.assign(fresh(), { phase: 10, message_count: 23, ending_type: 'legacy_bad_end' });
  const result = reply(user, 'こんにちは');
  assert.equal(result.user.ending_type, 'legacy_bad_end');
  assert.equal(result.user.message_count, 23);
  assert.equal(result.user.phase, 5);
  assert.equal(result.counted, false);
});

for (const command of ['__follow__', '占い', 'こわいはなし', '共有', 'スクショ', '紹介した', '紹介しない', '紹介は後で', '本当に見えてる？', '停止', '再開', 'もう一度']) {
  check(`uncounted command ${command}`, () => {
    const user = Object.assign(fresh(), { message_count: 10, invite_count: 9 });
    const result = reply(user, command);
    assert.equal(result.counted, false);
    assert.equal(result.user.message_count, command === 'もう一度' ? 0 : 10);
    assert.equal(result.user.invite_count, 9);
  });
}
check('referral refusal never causes penalty or ending', () => {
  const user = Object.assign(fresh(), { message_count: 51, invite_count: 2, neg_score: 4 });
  const declined = reply(user, '紹介したくない');
  assert.equal(declined.user.invite_response, 'declined');
  assert.equal(declined.user.invite_count, 2);
  assert.equal(declined.user.neg_score, 4);
  assert.equal(declined.user.ending_type, '');
  const ended = reply(declined.user, 'おはなしをつづける');
  assert.equal(ended.user.ending_type, 'echo');
});
check('self-reported referral is never verified increment', () => {
  const result = reply(Object.assign(fresh(), { invite_count: 0 }), '3人に紹介したよ');
  assert.equal(result.user.invite_response, 'accepted');
  assert.equal(result.user.invite_count, 0);
});
check('ordinary recommendations and self introduction are not referral commands', () => {
  for (const text of ['おすすめの本を紹介して', '本紹介して', '自己紹介したい', '紹介された友達が気になる']) {
    const result = reply(fresh(), text);
    assert.equal(result.counted, true);
    assert.equal(result.aiEligible, true);
    assert.equal(result.user.invite_response, '');
  }
});

for (const command of ['終了', '停止', 'やめて', 'ブロック', '通知停止', 'やめてください', 'もうやめて', 'ミリー、もうやめて', '怖いからやめて', 'こわいのやめて']) {
  check(`stop and resume ${command}`, () => {
    const stopped = reply(Object.assign(fresh(), { message_count: 21 }), command);
    assert.equal(stopped.user.is_active, false);
    assert.equal(stopped.counted, false);
    const waiting = reply(stopped.user, 'こんにちは');
    assert.equal(waiting.user.message_count, 21);
    const resumed = reply(waiting.user, '再開');
    assert.equal(resumed.user.is_active, true);
    assert.equal(resumed.user.message_count, 21);
  });
}
for (const text of ['やめないで', '止めてない', '今日は仕事をやめなかった']) {
  check(`non-stop phrase ${text}`, () => {
    const result = reply(fresh(), text);
    assert.equal(result.user.is_active, true);
    assert.equal(result.counted, true);
  });
}
check('reset preserves profiles, referrals, quota and unknown integration fields', () => {
  const user = Object.assign(fresh(), {
    name: '旧プロフィール', location: '旧住所', workplace: '旧職場', secrets: '旧メモ',
    invite_count: 8, referred_by: 'U_REF', source: 'original', last_fortune_date: ctx.dateKey,
    message_count: 39, ending_type: 'legacy', topics: '["akai"]',
    custom: { keep: ['value'] }
  });
  const before = JSON.stringify(user);
  const result = reply(user, '最初から');
  assert.equal(JSON.stringify(user), before);
  for (const field of ['name', 'location', 'workplace', 'secrets', 'invite_count', 'referred_by', 'source', 'last_fortune_date']) assert.equal(result.user[field], user[field]);
  assert.equal(result.user.message_count, 0);
  assert.equal(result.user.phase, 1);
  assert.equal(result.user.ending_type, '');
  assert.deepEqual(json(result.user.custom), user.custom);
  result.user.custom.keep.push('different');
  assert.equal(user.custom.keep.length, 1);
});
check('user isolation and input immutability', () => {
  const a = fresh('U_A');
  const b = fresh('U_B');
  const before = JSON.stringify(a);
  const result = reply(a, '友達とのことを相談したい');
  assert.equal(JSON.stringify(a), before);
  assert.equal(b.message_count, 0);
  assert.equal(b.topics, '[]');
  assert.deepEqual(json(JSON.parse(result.user.topics)), ['hanako']);
});

check('only explicit call-name is stored', () => {
  const unnamed = reply(fresh(), '私は必要？');
  assert.equal(unnamed.user.name, '');
  const named = reply(unnamed.user, '名前はまいです');
  assert.equal(named.user.name, 'まい');
  const address = reply(named.user, '東京都テスト区で一人暮らし、勤務先はテスト社です');
  assert.equal(address.user.location, '');
  assert.equal(address.user.workplace, '');
  assert.equal(address.user.live_alone, '');
});
check('bounded history accepts legacy invalid formats', () => {
  for (const history of ['broken{', '{}', '', [{ role: 'system', content: 'unknown' }]]) {
    const result = reply(Object.assign(fresh(), { history }), 'こんにちは');
    assert.ok(Array.isArray(JSON.parse(result.user.history)));
  }
  let user = fresh();
  for (let i = 0; i < 30; i++) {
    user = reply(user, 'あ'.repeat(600) + String(i)).user;
    const history = JSON.parse(user.history);
    assert.ok(history.length <= 12);
    assert.ok(history.every(item => item.content.length <= 500));
    assert.ok(Buffer.byteLength(user.history, 'utf8') <= 2400);
  }
});
check('emoji history has actual UTF-8 limit', () => {
  const user = Object.assign(fresh(), { history: JSON.stringify(Array.from({ length: 12 }, () => ({ role: 'user', content: '👻'.repeat(250) }))) });
  const result = reply(user, 'こんにちは');
  assert.ok(Buffer.byteLength(result.user.history, 'utf8') <= 2400);
});
check('ordinary responses vary within same phase', () => {
  let user = fresh();
  const outputs = [];
  for (let i = 0; i < 4; i++) {
    const result = reply(user, 'うん');
    outputs.push(JSON.stringify(result.messages));
    user = result.user;
  }
  assert.equal(new Set(outputs).size, 4);
});
check('repeated same early topic has varied helpful responses', () => {
  for (const text of ['友達のことで困ってる', '返事を待ってる', '私は必要？']) {
    let user = fresh();
    const outputs = [];
    for (let i = 0; i < 4; i++) {
      const result = reply(user, text);
      outputs.push(JSON.stringify(result.messages));
      user = result.user;
    }
    assert.equal(new Set(outputs).size, 4);
  }
});

check('anonymous public cards cannot leak stored PII or raw input', () => {
  const user = Object.assign(fresh(), { name: '秘密の呼び名', location: '個人の所在地', secrets: '個人的な秘密', topics: '["akai"]', history: JSON.stringify([{ role: 'user', content: 'わたしだけの発言' }]) });
  const result = reply(user, '共有');
  assert.equal(result.shareCard.id, 'akai');
  const card = JSON.stringify(result.shareCard);
  for (const forbidden of [user.name, user.location, user.secrets, 'わたしだけの発言', ctx.dateKey, '4時44分']) assert.ok(!card.includes(forbidden));
  assert.equal(core.publicCard('untrusted <script>').id, 'echo');
  assert.equal(core.publicCard('__proto__').id, 'echo');
  assert.equal(core.publicCard('toString').id, 'echo');
  const publicCard = core.publicCard('hanako');
  publicCard.lines[0] = 'override';
  assert.notEqual(core.publicCard('hanako').lines[0], 'override');
  assert.notDeepEqual(json(core.publicCard('hanako')), json(core.publicCard('ongaku')));
});
check('fictional prophecy does not use real location', () => {
  const result = reply(Object.assign(fresh(), { message_count: 19, location: '絶対に使わない住所' }), 'つづき');
  assert.ok(result.messages.join('').includes('おはなしのなか'));
  assert.ok(result.messages.join('').includes('4時44分'));
  assert.ok(!result.messages.join('').includes('絶対に使わない住所'));
});

check('daily fortune is per-user and uncounted', () => {
  const first = reply(fresh('FORTUNE_A'), '占い');
  const repeat = reply(first.user, '占い');
  const tomorrow = reply(repeat.user, '占い', { now: '2026-11-05T04:00:00Z', dateKey: '2026-11-05' });
  assert.equal(first.user.last_fortune_date, ctx.dateKey);
  assert.ok(repeat.messages[0].includes('もう渡した'));
  assert.equal(tomorrow.user.last_fortune_date, '2026-11-05');
  assert.equal(tomorrow.user.message_count, 0);
  assert.ok(!reply(fresh('FORTUNE_B'), '占い').messages[0].includes('もう渡した'));
  assert.ok(reply(Object.assign(fresh(), { message_count: 20 }), '占い').messages.join('').includes('音楽室'));
});
check('three ghost stories unlock at phases 3, 5, 7 without advancing count', () => {
  assert.equal(JSON.parse(reply(fresh(), 'こわいはなし').user.kaidan_told).length, 0);
  let user = Object.assign(fresh(), { message_count: 10 });
  let result = reply(user, 'こわいはなし');
  assert.deepEqual(json(JSON.parse(result.user.kaidan_told)), ['hanako']);
  assert.equal(result.user.message_count, 10);
  user = Object.assign(result.user, { message_count: 20 });
  result = reply(user, '怪談');
  assert.deepEqual(json(JSON.parse(result.user.kaidan_told)), ['hanako', 'ongaku']);
  user = Object.assign(result.user, { message_count: 30 });
  result = reply(user, '怖い話');
  assert.deepEqual(json(JSON.parse(result.user.kaidan_told)), ['hanako', 'ongaku', 'akai']);
  assert.ok(result.messages.join('').includes('ゆまちゃん'));
  const replay = reply(result.user, 'こわいはなし');
  assert.equal(JSON.parse(replay.user.kaidan_told).length, 3);
  assert.equal(replay.user.message_count, 30);
});

check('capability disclosure is honest and uncounted', () => {
  const result = reply(Object.assign(fresh(), { message_count: 30 }), '本当に見えてる？カメラで？');
  assert.equal(result.counted, false);
  assert.ok(result.messages.join('').includes('カメラや位置情報'));
  assert.ok(result.messages.join('').includes('見られない'));
});
for (const text of ['死にたい', '今から飛び降りる', '死にたいわけじゃないけど、今から飛び降りる']) {
  check(`crisis stops horror: ${text}`, () => {
    const result = reply(Object.assign(fresh(), { message_count: 30 }), text);
    assert.equal(result.user.is_active, false);
    assert.equal(result.counted, false);
    assert.equal(result.user.message_count, 30);
    assert.ok(result.messages.join('').includes('119'));
    assert.ok(!result.messages.join('').includes('赤い女'));
  });
}
check('clear negation alone is not a crisis', () => {
  const result = reply(fresh(), '死にたいわけじゃない、仕事に疲れた');
  assert.equal(result.user.is_active, true);
  assert.equal(result.counted, true);
});

for (const [time, expected] of [['2026-11-03T17:17:00Z', '2時17分'], ['2026-11-03T18:33:00Z', '3時33分'], ['2026-11-03T19:44:00Z', '4時44分']]) {
  check(`JST clock event once: ${expected}`, () => {
    const context = { now: time, dateKey: '2026-11-04' };
    const first = reply(Object.assign(fresh(), { message_count: 10 }), 'うん', context);
    assert.ok(first.messages[0].includes(expected));
    assert.equal(first.aiEligible, false);
    assert.equal(JSON.parse(first.user.anniversaries_sent).length, 1);
    const second = reply(first.user, 'うん', context);
    assert.equal(JSON.parse(second.user.anniversaries_sent).length, 1);
    assert.ok(!second.messages[0].includes(expected));
  });
}
check('clock log bound does not grow indefinitely', () => {
  const user = Object.assign(fresh(), { message_count: 10, anniversaries_sent: JSON.stringify(Array.from({ length: 35 }, (_, i) => 'clock:legacy:' + i)) });
  const result = reply(user, 'うん', { now: '2026-11-03T17:17:00Z', dateKey: '2026-11-04' });
  assert.equal(JSON.parse(result.user.anniversaries_sent).length, 35);
});
check('clock cap preserves all legacy anniversary achievements', () => {
  const records = [3, 7, 'anniversary:30'].concat(Array.from({ length: 35 }, (_, i) => 'clock:legacy:' + i));
  const user = Object.assign(fresh(), { message_count: 10, anniversaries_sent: JSON.stringify(records) });
  const result = reply(user, 'うん', { now: '2026-11-03T17:17:00Z', dateKey: '2026-11-04' });
  const stored = JSON.parse(result.user.anniversaries_sent);
  for (const legacy of [3, 7, 'anniversary:30']) assert.ok(stored.includes(legacy));
  assert.equal(stored.filter(item => typeof item === 'string' && item.startsWith('clock:')).length, 35);
  assert.equal(stored.length, 38);
});
check('clock events skip unfamiliar legacy anniversary cell formats', () => {
  for (const value of ['broken[', '{"day":3}', { day: 3 }, 3, '']) {
    const user = Object.assign(fresh(), { message_count: 10, anniversaries_sent: value });
    const result = reply(user, 'うん', { now: '2026-11-03T17:17:00Z', dateKey: '2026-11-04' });
    assert.deepEqual(json(result.user.anniversaries_sent), value);
    assert.ok(!result.messages[0].includes('2時17分'));
  }
});

check('Gemini prompt preserves previous response and same-text consecutive turns', () => {
  const user = Object.assign(fresh(), { history: JSON.stringify([{ role: 'user', content: '同じことば' }, { role: 'assistant', content: '前回の返事' }]) });
  const prompt = core.buildPrompt(user, '同じことば');
  assert.equal(prompt.contents.length, 3);
  assert.deepEqual(json(prompt.contents.map(item => item.role)), ['user', 'model', 'user']);
  assert.equal(prompt.contents[1].parts[0].text, '前回の返事');
  assert.equal(prompt.contents[2].parts[0].text, '同じことば');
  assert.ok(prompt.systemInstruction.parts[0].text.includes('カメラ'));
  assert.ok(!JSON.stringify(prompt).includes('undefined'));
});
check('Gemini prompt omits imported sensitive profile cells', () => {
  const prompt = core.buildPrompt(Object.assign(fresh(), { location: 'IMPORTED_PRIVATE_LOCATION', secrets: 'IMPORTED_PRIVATE_SECRET', workplace: 'IMPORTED_WORK' }), 'こんにちは');
  for (const forbidden of ['IMPORTED_PRIVATE_LOCATION', 'IMPORTED_PRIVATE_SECRET', 'IMPORTED_WORK']) assert.ok(!JSON.stringify(prompt).includes(forbidden));
});

console.log(`Core: ${assertions} checks passed`);
