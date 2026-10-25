'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game } = require('../game');

function setup(n) {
  const g = new Game();
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(g.join(`token-${i}-xxxx`, `P${i}`).playerId);
  assert.deepStrictEqual(g.start(ids[0]), {});
  return { g, ids };
}

function rig(g, loot) {
  g.loot = { ...loot };
}

test('分赃示例：司机600 恶棍400 谋士200 暴徒100', () => {
  const { g, ids } = setup(7);
  rig(g, { amount: 1200, ante: 100, bonus: 'brute' });
  const picks = ['driver', 'crook', 'mastermind', 'brute', 'snitch', 'snitch', 'driver'];
  ids.forEach((id, i) => assert.deepStrictEqual(g.choose(id, [picks[i]]), {}));
  assert.strictEqual(g.phase, 'negotiation');
  // 后三位退出，只剩四个不同身份
  for (const id of ids.slice(4)) g.withdraw(id, g.slotsOf(id)[0].id);
  g.startHeist(ids[0]);
  assert.strictEqual(g.phase, 'results');
  const share = Object.fromEntries(g.results.slots.map((s) => [s.role, s.share]));
  assert.deepStrictEqual(share, { driver: 600, crook: 400, mastermind: 200, brute: 100 });
  assert.strictEqual(g.publicFund, 200);
  // 现金 = 500 - 100保证金 + 100退还 + 分得
  assert.strictEqual(g.player(ids[0]).cash, 1100);
  assert.strictEqual(g.player(ids[3]).cash, 600);
  assert.strictEqual(g.player(ids[3]).threats.length, 1);
  // 退出者取回保证金
  assert.strictEqual(g.player(ids[5]).cash, 500);
});

test('告密者点名：被点名者淘汰、没收保证金，暴徒例外', () => {
  const { g, ids } = setup(5);
  rig(g, { amount: 1000, ante: 200, bonus: null });
  ['snitch', 'driver', 'driver', 'brute', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  g.startHeist(ids[0]);
  assert.strictEqual(g.phase, 'snitch');
  assert.ok(g.nameRole(ids[1], 'brute').error);
  g.nameRole(ids[0], 'brute');
  assert.strictEqual(g.phase, 'results');
  assert.strictEqual(g.player(ids[0]).cash, 500); // 告密者取回
  assert.strictEqual(g.player(ids[1]).cash, 300); // 司机撞车没收
  assert.strictEqual(g.player(ids[3]).cash, 500); // 被点名的暴徒取回
  assert.strictEqual(g.player(ids[3]).threats.length, 0);
  assert.strictEqual(g.player(ids[4]).cash, 500 + 1000); // 恶棍独得
});

test('多名告密者全部出局；只剩告密者罚300万', () => {
  let { g, ids } = setup(5);
  rig(g, { amount: 1000, ante: 100, bonus: null });
  ['snitch', 'snitch', 'driver', 'driver', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  g.startHeist(ids[0]);
  assert.strictEqual(g.phase, 'results');
  assert.strictEqual(g.player(ids[0]).cash, 400);
  assert.strictEqual(g.player(ids[4]).cash, 1500);

  ({ g, ids } = setup(5));
  rig(g, { amount: 1000, ante: 100, bonus: null });
  ['snitch', 'driver', 'driver', 'crook', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  g.startHeist(ids[0]);
  assert.deepStrictEqual(g.nameRole(ids[0], 'driver'), {});
  assert.strictEqual(g.player(ids[0]).cash, 200);
});

test('交易：先付钱再退出；威胁卡下一轮才能用', () => {
  const { g, ids } = setup(4);
  rig(g, { amount: 800, ante: 100, bonus: null });
  ['brute', 'driver', 'crook', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  g.createOffer(ids[2], { slotId: g.slotsOf(ids[3])[0].id, payerId: ids[2], amount: 150 });
  assert.deepStrictEqual(g.respondOffer(ids[3], g.offers[0].id, true), {});
  assert.strictEqual(g.player(ids[3]).cash, 650);
  assert.ok(g.slotsOf(ids[3])[0].withdrawn);
  g.startHeist(ids[0]);
  // 暴徒、司机、恶棍平分800：266→200每份，余200
  assert.strictEqual(g.player(ids[0]).threats.length, 1);
  assert.ok(g.player(ids[0]).cash >= 0);
  g.nextRound(ids[0]);
  ['brute', 'driver', 'crook', 'brute'].forEach((r, i) => g.choose(ids[i], [r]));
  assert.deepStrictEqual(g.useThreat(ids[0], ids[1]), {});
  assert.match(g.player(ids[0]).private[0].text, /司机/);
  assert.ok(g.useThreat(ids[0], ids[1]).error);
});

test('三人玩法与连续不重复变体，打满8轮', () => {
  const g = new Game();
  const ids = [0, 1, 2].map((i) => g.join(`tok-${i}-yyyy`, `Q${i}`).playerId);
  g.setSettings(ids[0], { noRepeat: true });
  g.start(ids[0]);
  assert.strictEqual(g.slots.length, 6);
  assert.strictEqual(g.center, null);
  while (g.phase !== 'ended') {
    assert.strictEqual(g.phase, 'planning');
    for (const id of ids) {
      const allowed = g.allowedRoles(id);
      if (g.round > 1) assert.ok(!allowed.includes(g.player(id).lastRoles[0]));
      g.choose(id, allowed.slice(0, 2));
    }
    assert.strictEqual(g.center.revealed.length, 5);
    g.startHeist(ids[0]);
    if (g.phase === 'snitch') g.nameRole(g.snitch.playerId, g.snitch.options[0]);
    for (const p of g.players) assert.ok(p.cash >= 0);
    if (g.phase === 'results') g.nextRound(ids[0]);
  }
  assert.ok(g.winners.length >= 1);
  assert.ok(g.round <= 8);
});

test('视图不泄露他人身份', () => {
  const { g, ids } = setup(4);
  ['brute', 'driver', 'crook', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  const v = g.viewFor(ids[0]);
  assert.strictEqual(v.players[0].slots[0].role, 'brute');
  assert.strictEqual(v.players[1].slots[0].role, null);
  assert.strictEqual(g.viewFor(null).players[0].slots[0].role, null);
});
