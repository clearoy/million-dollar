'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Game, OFFLINE_GRACE_MS } = require('../game');

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
  g.center.revealed = ['snitch', 'brute', 'driver', 'driver']; // 固定藏起恶棍，保证暴徒可被点名
  g.startHeist(ids[0]);
  assert.strictEqual(g.phase, 'snitch');
  assert.ok(g.nameRole(ids[1], 'brute').error);
  g.nameRole(ids[0], 'brute');
  assert.strictEqual(g.phase, 'results');
  assert.strictEqual(g.player(ids[0]).cash, 500 + 500); // 告密者取回保证金，与恶棍平分
  assert.strictEqual(g.player(ids[1]).cash, 300); // 司机撞车没收
  assert.strictEqual(g.player(ids[3]).cash, 500); // 被点名的暴徒取回
  assert.strictEqual(g.player(ids[3]).threats.length, 0);
  assert.strictEqual(g.player(ids[4]).cash, 500 + 500); // 恶棍与告密者平分
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

test('三人局截图复现：唯一的告密者与恶棍平分赃款', () => {
  const g = new Game();
  const ids = ['tyy', 'roy', 'zym'].map((n, i) => g.join(`tok-${n}-zzzz`, n).playerId);
  g.start(ids[0]);
  rig(g, { amount: 1000, ante: 100, bonus: 'mastermind' });
  g.choose(ids[0], ['brute', 'driver']);
  g.choose(ids[1], ['snitch', 'driver']);
  g.choose(ids[2], ['brute', 'crook']);
  g.startHeist(ids[0]);
  if (g.phase === 'snitch') g.nameRole(ids[1], 'brute');
  else g.resolve('brute'); // 恶棍被藏时也能确定性地复现
  const share = Object.fromEntries(g.results.slots.filter((s) => s.share != null).map((s) => [s.role, s.share]));
  assert.deepStrictEqual(share, { snitch: 500, crook: 500 });
  assert.strictEqual(g.player(ids[0]).cash, 400); // 500 - 200 + 暴徒退100
  assert.strictEqual(g.player(ids[1]).cash, 900); // 500 - 200 + 告密者退100 + 500
  assert.strictEqual(g.player(ids[2]).cash, 1000); // 500 - 200 + 200 + 500
});

test('改名与投票重开', () => {
  const { g, ids } = setup(5);
  assert.ok(g.rename(ids[0], 'P1').error);
  assert.deepStrictEqual(g.rename(ids[0], '新名字'), {});
  assert.strictEqual(g.player(ids[0]).name, '新名字');
  // 断线玩家不计入：4人在线，需要3票
  g.disconnect(ids[4]);
  assert.strictEqual(g.restartNeed(), 3);
  g.voteRestart(ids[0], true);
  g.voteRestart(ids[1], true);
  g.voteRestart(ids[1], false);
  g.voteRestart(ids[2], true);
  assert.strictEqual(g.phase, 'planning');
  g.voteRestart(ids[3], true);
  assert.strictEqual(g.phase, 'lobby');
  assert.strictEqual(g.players.length, 4);
  assert.deepStrictEqual(g.restartVotes, []);
  assert.ok(g.player(ids[0]).cash === 500);
});

test('开车需要所有仍在本轮的在线玩家确认', () => {
  const { g, ids } = setup(5);
  rig(g, { amount: 1000, ante: 100, bonus: null });
  ['brute', 'driver', 'crook', 'crook', 'driver'].forEach((r, i) => g.choose(ids[i], [r]));
  assert.ok(g.startHeist(ids[1]).error); // 非房主不能强制开车
  g.readyHeist(ids[0], true);
  g.readyHeist(ids[1], true);
  g.readyHeist(ids[1], false);
  g.readyHeist(ids[1], true);
  g.withdraw(ids[3], g.slotsOf(ids[3])[0].id); // 退出者不需要确认
  assert.ok(g.readyHeist(ids[3], true).error);
  g.readyHeist(ids[2], true);
  assert.strictEqual(g.phase, 'negotiation');
  g.disconnect(ids[4]); // 最后一人刚掉线：宽限期内继续等他
  assert.strictEqual(g.phase, 'negotiation');
  g.join('token-4-xxxx', ''); // 重连后仍需要他确认
  g.checkHeistReady();
  assert.strictEqual(g.phase, 'negotiation');
  g.disconnect(ids[4]);
  g.player(ids[4]).offlineSince -= OFFLINE_GRACE_MS; // 掉线超过宽限期，不再等他
  g.checkHeistReady();
  assert.strictEqual(g.phase, 'results');
});

test('所有人都退出时自动结束谈判', () => {
  const { g, ids } = setup(4);
  ['brute', 'driver', 'crook', 'crook'].forEach((r, i) => g.choose(ids[i], [r]));
  for (const id of ids) g.withdraw(id, g.slotsOf(id)[0].id);
  assert.strictEqual(g.phase, 'results');
});

test('告密者掉线时房主可随机点名', () => {
  const { g, ids } = setup(5);
  ['snitch', 'driver', 'crook', 'brute', 'driver'].forEach((r, i) => g.choose(ids[i], [r]));
  g.center.revealed = ['snitch', 'brute', 'driver', 'driver'];
  g.startHeist(ids[0]);
  assert.strictEqual(g.phase, 'snitch');
  assert.ok(g.forceSnitch(ids[1]).error);
  assert.deepStrictEqual(g.forceSnitch(ids[0]), {});
  assert.strictEqual(g.phase, 'results');
  assert.ok(['brute', 'driver'].includes(g.results.named));
});

test('每轮流水加总等于整轮钱数变化（随机打满整局）', () => {
  for (const n of [3, 4, 5, 7]) {
    const { g, ids } = setup(n);
    while (g.phase !== 'ended') {
      const start = new Map(g.players.map((p) => [p.id, p.cash]));
      for (const id of ids) {
        const roles = g.allowedRoles(id).sort(() => Math.random() - 0.5).slice(0, g.slotsPerPlayer());
        g.choose(id, roles);
      }
      // 随机谈判：转账、交易、退出
      g.transfer(ids[0], ids[1], 50);
      const target = g.slots.find((s) => s.playerId === ids[2] && !s.withdrawn);
      if (target) {
        g.createOffer(ids[0], { slotId: target.id, payerId: ids[0], amount: 100 });
        if (g.offers.length) g.respondOffer(ids[2], g.offers[0].id, true);
      }
      if (g.phase === 'negotiation') g.startHeist(ids[0]);
      if (g.phase === 'snitch') g.nameRole(g.snitch.playerId, g.snitch.options[0]);
      for (const p of g.players) {
        const l = g.ledger[p.id];
        const sum = l.ante + l.refund + l.deal + l.split + l.penalty;
        assert.strictEqual(sum, p.cash - start.get(p.id), `${n}人 第${g.round}轮 ${p.name}`);
        assert.strictEqual(g.results.deltas[p.id], sum);
      }
      if (g.phase === 'results') g.nextRound(ids[0]);
    }
    assert.strictEqual(g.history.length, g.round);
  }
});

test('每轮回顾：退出者身份在游戏结束前保密', () => {
  const { g, ids } = setup(4);
  rig(g, { amount: 1000, ante: 100, bonus: null });
  ['brute', 'driver', 'crook', 'driver'].forEach((r, i) => g.choose(ids[i], [r]));
  g.withdraw(ids[3], g.slotsOf(ids[3])[0].id);
  g.startHeist(ids[0]);
  const row = (v) => v.history[0].slots.find((s) => s.playerId === ids[3]);
  assert.strictEqual(row(g.viewFor(ids[0])).role, null);
  assert.strictEqual(row(g.viewFor(ids[3])).role, 'driver'); // 自己能看到
  assert.strictEqual(g.viewFor(ids[0]).history[0].slots.find((s) => s.playerId === ids[1]).role, 'driver');
  g.phase = 'ended';
  assert.strictEqual(row(g.viewFor(ids[0])).role, 'driver');
});

test('赃款有波动且保证金与金额相关', () => {
  const g = new Game();
  g.activeRoles = ['brute', 'driver', 'crook'];
  const seen = new Set();
  let bonusNone = 0;
  for (let i = 0; i < 2000; i++) {
    const l = g.drawLoot();
    seen.add(l.amount);
    if (l.amount >= 1200) assert.strictEqual(l.ante, 200);
    if (l.amount <= 800) assert.strictEqual(l.ante, 100);
    if (l.bonus === null) bonusNone++;
    else assert.ok(g.activeRoles.includes(l.bonus));
  }
  assert.deepStrictEqual([...seen].sort((a, b) => a - b), [800, 900, 1000, 1100, 1200]);
  assert.ok(bonusNone > 200 && bonusNone < 600);
});
