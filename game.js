'use strict';

// 《百万美金》游戏核心逻辑（单房间）。金额单位：万。

const ROLES = {
  snitch: { name: '告密者', desc: '点名淘汰一种公开身份，再正常分赃' },
  brute: { name: '暴徒', desc: '获得1张威胁卡，可偷看别人身份' },
  driver: { name: '司机', desc: '其他分赃角色每人付你100万车费' },
  crook: { name: '恶棍', desc: '从分赃的暴徒手里拿走200万' },
  mastermind: { name: '谋士', desc: '总赃款增加200万再平分' },
};
// 抢劫阶段的判定顺序
const ROLE_ORDER = ['snitch', 'brute', 'driver', 'crook', 'mastermind'];

const START_CASH = 500;
const WIN_CASH = 2000;
const MAX_ROUNDS = 8;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
// 掉线后保留"需要确认开车"资格的时间，避免手机切后台时被直接跳过
const OFFLINE_GRACE_MS = 30000;

// 原规则未给出赃款牌明细。每轮在800万—1200万中独立随机抽取（可能连续出现相同金额）。
// [金额, 权重]
const LOOT_AMOUNTS = [[800, 1], [900, 1], [1000, 1], [1100, 1], [1200, 1]];
const NO_BONUS_CHANCE = 0.2;

function rolesForCount(n) {
  if (n <= 3) return ROLE_ORDER.slice();
  if (n === 4) return ['brute', 'driver', 'crook'];
  if (n <= 6) return ['snitch', 'brute', 'driver', 'crook'];
  return ROLE_ORDER.slice();
}

function shuffle(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const byOrder = (a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b);
const roleName = (r) => (ROLES[r] ? ROLES[r].name : r);

class Game {
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.players = [];
    this.hostId = null;
    this.settings = { noRepeat: false, bruteShares: true };
    this.chat = [];
    this.nextId = 1;
    this.toLobby();
  }

  // ---------- 工具 ----------

  genId(prefix) {
    return `${prefix}${this.nextId++}`;
  }

  player(id) {
    return this.players.find((p) => p.id === id);
  }

  effectiveHostId() {
    const host = this.player(this.hostId);
    if (host && host.connected) return host.id;
    const first = this.players.find((p) => p.connected);
    return first ? first.id : this.hostId;
  }

  isHost(id) {
    return id != null && this.effectiveHostId() === id;
  }

  leaderId() {
    const p = this.players[this.leaderIdx];
    return p ? p.id : null;
  }

  canLead(id) {
    return id === this.leaderId() || this.isHost(id);
  }

  addLog(text) {
    this.log.push({ t: Date.now(), text });
    if (this.log.length > 300) this.log.shift();
  }

  addPrivate(pid, text) {
    const p = this.player(pid);
    if (!p) return;
    p.private.push({ t: Date.now(), round: this.round, text });
  }

  slotsOf(pid) {
    return this.slots.filter((s) => s.playerId === pid);
  }

  activeSlots() {
    return this.slots.filter((s) => !s.withdrawn);
  }

  // ---------- 大厅 ----------

  toLobby() {
    this.phase = 'lobby';
    this.round = 0;
    this.leaderIdx = 0;
    this.loot = null;
    this.history = [];
    this.slots = [];
    this.center = null;
    this.offers = [];
    this.snitch = null;
    this.results = null;
    this.winners = null;
    this.publicFund = 0;
    this.activeRoles = [];
    this.restartVotes = [];
    this.heistReady = [];
    this.log = [];
    for (const p of this.players) this.resetPlayer(p);
  }

  resetPlayer(p) {
    p.cash = START_CASH;
    p.threats = [];
    p.lastRoles = [];
    p.private = [];
  }

  join(token, name) {
    name = String(name || '').trim().slice(0, 16);
    const existing = this.players.find((p) => p.token === token);
    if (existing) {
      existing.connected = true;
      if (name && !this.players.some((p) => p !== existing && p.name === name)) existing.name = name;
      return { playerId: existing.id };
    }
    if (!name) return { error: '请输入昵称' };
    if (this.phase !== 'lobby') return { spectator: true };
    if (this.players.length >= MAX_PLAYERS) return { error: `房间已满（最多${MAX_PLAYERS}人）` };
    if (this.players.some((p) => p.name === name)) return { error: '昵称已被使用' };
    const p = { id: this.genId('p'), token, name, connected: true };
    this.resetPlayer(p);
    this.players.push(p);
    if (!this.player(this.hostId)) this.hostId = p.id;
    return { playerId: p.id };
  }

  disconnect(pid) {
    const p = this.player(pid);
    if (p) {
      p.connected = false;
      p.offlineSince = Date.now();
    }
    this.checkHeistReady();
  }

  rename(pid, name) {
    const p = this.player(pid);
    name = String(name || '').trim().slice(0, 16);
    if (!p) return { error: '你不在游戏中' };
    if (!name) return { error: '请输入昵称' };
    if (name === p.name) return {};
    if (this.players.some((x) => x !== p && x.name === name)) return { error: '昵称已被使用' };
    if (this.phase !== 'lobby') this.addLog(`${p.name} 改名为 ${name}。`);
    p.name = name;
    return {};
  }

  // 投票重开：在线玩家过半同意即回到大厅
  restartNeed() {
    return Math.floor(this.players.filter((p) => p.connected).length / 2) + 1;
  }

  voteRestart(pid, on) {
    const p = this.player(pid);
    if (!p) return { error: '你不在游戏中' };
    if (this.phase === 'lobby') return { error: '游戏还没开始' };
    const had = this.restartVotes.includes(pid);
    if (on && !had) this.restartVotes.push(pid);
    if (!on && had) this.restartVotes = this.restartVotes.filter((id) => id !== pid);
    if (on === had) return {};
    const votes = this.restartVotes.filter((id) => this.player(id) && this.player(id).connected).length;
    const need = this.restartNeed();
    this.addLog(on ? `${p.name} 投票重开（${votes}/${need}）。` : `${p.name} 撤回了重开投票（${votes}/${need}）。`);
    if (votes >= need) {
      this.backToLobby();
      this.addLog('投票通过，已回到大厅，房主可以重新开始游戏。');
    }
    return {};
  }

  remove(pid) {
    if (this.phase !== 'lobby') return;
    this.players = this.players.filter((p) => p.id !== pid);
    if (this.hostId === pid) this.hostId = this.players[0] ? this.players[0].id : null;
  }

  kick(by, pid) {
    if (!this.isHost(by)) return { error: '只有房主可以操作' };
    if (this.phase !== 'lobby') return { error: '游戏进行中不能踢人' };
    if (by === pid) return { error: '不能踢自己' };
    this.remove(pid);
    return {};
  }

  setSettings(by, s) {
    if (!this.isHost(by)) return { error: '只有房主可以修改设置' };
    if (this.phase !== 'lobby') return { error: '游戏开始后不能修改设置' };
    if (typeof s.noRepeat === 'boolean') this.settings.noRepeat = s.noRepeat;
    if (typeof s.bruteShares === 'boolean') this.settings.bruteShares = s.bruteShares;
    return {};
  }

  start(by) {
    if (!this.isHost(by)) return { error: '只有房主可以开始游戏' };
    if (this.phase !== 'lobby') return { error: '游戏已经开始' };
    const n = this.players.length;
    if (n < MIN_PLAYERS) return { error: `至少需要${MIN_PLAYERS}名玩家` };
    this.toLobby();
    this.activeRoles = rolesForCount(n);
    this.leaderIdx = Math.floor(this.rng() * n);
    this.addLog(`游戏开始！${n}名玩家，使用角色：${this.activeRoles.map(roleName).join('、')}。`);
    if (n === 3) this.addLog('三人玩法：每人每轮秘密选择两个不同角色，分别缴纳保证金。');
    this.startRound();
    return {};
  }

  reset(by) {
    if (!this.isHost(by)) return { error: '只有房主可以操作' };
    this.backToLobby();
    return {};
  }

  backToLobby() {
    this.toLobby();
    this.players = this.players.filter((p) => p.connected);
    if (!this.player(this.hostId)) this.hostId = this.players[0] ? this.players[0].id : null;
  }

  // ---------- 第1阶段：准备 ----------

  slotsPerPlayer() {
    return this.players.length === 3 ? 2 : 1;
  }

  startRound() {
    this.round += 1;
    this.loot = this.drawLoot();
    this.phase = 'planning';
    // 本轮资金流水，用于结算时展示整轮的钱数变化
    this.roundStart = new Map(this.players.map((p) => [p.id, p.cash]));
    this.ledger = Object.fromEntries(this.players.map((p) => [p.id, { ante: 0, refund: 0, deal: 0, split: 0, penalty: 0 }]));
    this.slots = [];
    for (const p of this.players) {
      for (let k = 0; k < this.slotsPerPlayer(); k++) {
        this.slots.push({ id: this.genId('s'), playerId: p.id, role: null, antePaid: 0, withdrawn: false });
      }
    }
    this.center = null;
    this.offers = [];
    this.snitch = null;
    this.results = null;
    const bonus = this.loot.bonus ? `，奖励图标：${roleName(this.loot.bonus)}` : '，无奖励图标';
    this.addLog(`—— 第${this.round}轮 —— 带头人：${this.player(this.leaderId()).name}。赃款${this.loot.amount}万，保证金${this.loot.ante}万${bonus}。`);
  }

  drawLoot() {
    const total = LOOT_AMOUNTS.reduce((sum, [, w]) => sum + w, 0);
    let r = this.rng() * total;
    let amount = LOOT_AMOUNTS[LOOT_AMOUNTS.length - 1][0];
    for (const [a, w] of LOOT_AMOUNTS) {
      if ((r -= w) < 0) {
        amount = a;
        break;
      }
    }
    // 大单保证金高，小单保证金低，中间随机
    const ante = amount >= 1200 ? 200 : amount <= 800 ? 100 : this.rng() < 0.5 ? 100 : 200;
    const bonus = this.rng() < NO_BONUS_CHANCE ? null : this.activeRoles[Math.floor(this.rng() * this.activeRoles.length)];
    return { amount, ante, bonus };
  }

  book(pid, key, amount) {
    if (this.ledger && this.ledger[pid]) this.ledger[pid][key] += amount;
  }

  allowedRoles(pid) {
    const p = this.player(pid);
    if (!p) return [];
    if (!this.settings.noRepeat) return this.activeRoles.slice();
    return this.activeRoles.filter((r) => !p.lastRoles.includes(r));
  }

  choose(pid, roles) {
    if (this.phase !== 'planning') return { error: '现在不是选择身份的阶段' };
    const p = this.player(pid);
    if (!p) return { error: '你不在游戏中' };
    const mine = this.slotsOf(pid);
    if (mine.some((s) => s.role)) return { error: '你已经选定身份，本轮不能更换' };
    if (!Array.isArray(roles) || roles.length !== mine.length) return { error: `请选择${mine.length}个身份` };
    if (new Set(roles).size !== roles.length) return { error: '两个身份必须不同' };
    const allowed = this.allowedRoles(pid);
    for (const r of roles) {
      if (!this.activeRoles.includes(r)) return { error: '本局没有这个身份' };
      if (!allowed.includes(r)) return { error: `变体规则：不能连续两轮选择${roleName(r)}` };
    }
    mine.forEach((s, i) => {
      s.role = roles[i];
      // 现金不足时由储备现金补足，退还时只退玩家自己实际缴纳的部分
      s.antePaid = Math.min(p.cash, this.loot.ante);
      p.cash -= s.antePaid;
      this.book(pid, 'ante', -s.antePaid);
    });
    this.addLog(`${p.name} 已秘密选定身份并缴纳保证金。`);
    if (this.slots.every((s) => s.role)) this.beginNegotiation();
    return {};
  }

  forceChoose(by) {
    if (!this.isHost(by)) return { error: '只有房主可以操作' };
    if (this.phase !== 'planning') return { error: '现在不是选择身份的阶段' };
    for (const p of this.players) {
      if (this.slotsOf(p.id).some((s) => s.role)) continue;
      const roles = shuffle(this.allowedRoles(p.id), this.rng).slice(0, this.slotsPerPlayer());
      this.addLog(`房主为 ${p.name} 随机选择了身份。`);
      this.choose(p.id, roles);
    }
    return {};
  }

  beginNegotiation() {
    const cards = shuffle(this.slots.map((s) => s.role), this.rng);
    cards.pop(); // 随机藏起1张
    this.center = { revealed: cards.sort(byOrder), hidden: 1 };
    this.phase = 'negotiation';
    this.heistReady = [];
    this.addLog(`角色牌已混洗，藏起1张，公开：${this.center.revealed.map(roleName).join('、')}。开始谈判！`);
  }

  // ---------- 第2阶段：谈判 ----------

  transfer(pid, toPid, amount) {
    if (this.phase !== 'negotiation') return { error: '只能在谈判阶段转账' };
    const from = this.player(pid);
    const to = this.player(toPid);
    amount = Math.floor(Number(amount));
    if (!from || !to || from === to) return { error: '转账对象无效' };
    if (!(amount > 0)) return { error: '金额必须大于0' };
    if (from.cash < amount) return { error: '现金不足' };
    from.cash -= amount;
    to.cash += amount;
    this.book(from.id, 'deal', -amount);
    this.book(to.id, 'deal', amount);
    this.addLog(`${from.name} 付给 ${to.name} ${amount}万。`);
    return {};
  }

  // 有条件交易："付款方付X万，槽位所属玩家退出"。可由任意一方发起，另一方接受后自动先付钱再退出。
  createOffer(pid, { slotId, payerId, amount }) {
    if (this.phase !== 'negotiation') return { error: '只能在谈判阶段提出交易' };
    const slot = this.slots.find((s) => s.id === slotId);
    amount = Math.floor(Number(amount));
    if (!slot || slot.withdrawn) return { error: '对方已退出或不存在' };
    if (!this.player(payerId) || payerId === slot.playerId) return { error: '交易双方无效' };
    if (pid !== payerId && pid !== slot.playerId) return { error: '你不是交易的一方' };
    if (!(amount > 0)) return { error: '金额必须大于0' };
    const offer = { id: this.genId('o'), slotId, payerId, amount, proposer: pid };
    this.offers.push(offer);
    const payer = this.player(payerId).name;
    const quitter = this.player(slot.playerId).name;
    this.addLog(pid === payerId
      ? `${payer} 提议：付给 ${quitter} ${amount}万，换取对方退出。`
      : `${quitter} 提议：${payer} 付${amount}万，自己就退出。`);
    return {};
  }

  respondOffer(pid, offerId, accept) {
    if (this.phase !== 'negotiation') return { error: '谈判已结束' };
    const offer = this.offers.find((o) => o.id === offerId);
    if (!offer) return { error: '交易不存在' };
    const slot = this.slots.find((s) => s.id === offer.slotId);
    const responder = offer.proposer === offer.payerId ? slot.playerId : offer.payerId;
    const payer = this.player(offer.payerId);
    const quitter = this.player(slot.playerId);
    if (pid === offer.proposer && !accept) {
      this.offers = this.offers.filter((o) => o !== offer);
      this.addLog(`${this.player(pid).name} 撤回了交易提议。`);
      return {};
    }
    if (pid !== responder) return { error: '你不能回应这个交易' };
    if (!accept) {
      this.offers = this.offers.filter((o) => o !== offer);
      this.addLog(`${this.player(pid).name} 拒绝了交易。`);
      return {};
    }
    if (payer.cash < offer.amount) return { error: `${payer.name} 现金不足` };
    payer.cash -= offer.amount;
    quitter.cash += offer.amount;
    this.book(payer.id, 'deal', -offer.amount);
    this.book(quitter.id, 'deal', offer.amount);
    this.addLog(`成交！${payer.name} 付给 ${quitter.name} ${offer.amount}万。`);
    this.doWithdraw(slot);
    return {};
  }

  withdraw(pid, slotId) {
    if (this.phase !== 'negotiation') return { error: '只能在谈判阶段退出' };
    const slot = this.slots.find((s) => s.id === slotId && s.playerId === pid);
    if (!slot || slot.withdrawn) return { error: '无法退出' };
    this.doWithdraw(slot);
    return {};
  }

  doWithdraw(slot) {
    const p = this.player(slot.playerId);
    slot.withdrawn = true;
    p.cash += slot.antePaid;
    this.book(p.id, 'refund', slot.antePaid);
    this.offers = this.offers.filter((o) => o.slotId !== slot.id);
    const extra = this.slotsPerPlayer() > 1 ? '的一个角色' : '';
    this.addLog(`${p.name}${extra} 退出本轮，取回保证金${slot.antePaid}万（身份保密）。`);
    this.checkHeistReady();
  }

  useThreat(pid, targetId) {
    if (this.phase !== 'negotiation') return { error: '只能在谈判阶段使用威胁卡' };
    const p = this.player(pid);
    const target = this.player(targetId);
    if (!p || !target || p === target) return { error: '目标无效' };
    const idx = p.threats.findIndex((r) => r < this.round);
    if (idx < 0) return { error: '没有可用的威胁卡（本轮刚获得的不能立即使用）' };
    p.threats.splice(idx, 1);
    const roles = this.slotsOf(targetId).map((s) => roleName(s.role) + (s.withdrawn ? '（已退出）' : ''));
    this.addPrivate(pid, `威胁卡：${target.name} 本轮的身份是【${roles.join('、')}】`);
    this.addLog(`${p.name} 对 ${target.name} 使用了威胁卡，偷看了其身份。`);
    return {};
  }

  // ---------- 第3阶段：抢劫 ----------

  // 开车：所有仍留在本轮（有未退出角色）且在线的玩家都确认后，自动开始抢劫
  heistNeeded(now = Date.now()) {
    return this.players
      .filter((p) => (p.connected || now - p.offlineSince < OFFLINE_GRACE_MS) && this.slotsOf(p.id).some((s) => !s.withdrawn))
      .map((p) => p.id);
  }

  readyHeist(pid, on) {
    if (this.phase !== 'negotiation') return { error: '现在不是谈判阶段' };
    const p = this.player(pid);
    if (!this.heistNeeded().includes(pid)) return { error: '你已退出本轮，不需要确认' };
    const had = this.heistReady.includes(pid);
    if (on === had) return {};
    if (on) this.heistReady.push(pid);
    else this.heistReady = this.heistReady.filter((id) => id !== pid);
    const need = this.heistNeeded();
    const count = need.filter((id) => this.heistReady.includes(id)).length;
    this.addLog(on ? `${p.name} 确认开车（${count}/${need.length}）。` : `${p.name} 取消了开车确认（${count}/${need.length}）。`);
    this.checkHeistReady();
    return {};
  }

  checkHeistReady() {
    if (this.phase !== 'negotiation') return;
    const need = this.heistNeeded();
    const allOut = this.activeSlots().length === 0;
    if (allOut || (need.length && need.every((id) => this.heistReady.includes(id)))) {
      this.beginHeist(allOut ? '所有人都退出了，本轮无人抢劫。' : '所有人都确认了，开车！');
    }
  }

  startHeist(pid) {
    if (this.phase !== 'negotiation') return { error: '现在不能开始抢劫' };
    if (!this.isHost(pid)) return { error: '只有房主可以强制开车' };
    this.beginHeist('房主强制开车！');
    return {};
  }

  beginHeist(msg) {
    this.offers = [];
    this.addLog(msg);
    const snitches = this.activeSlots().filter((s) => s.role === 'snitch');
    if (snitches.length === 1) {
      const options = [...new Set(this.center.revealed)].filter((r) => r !== 'snitch').sort(byOrder);
      if (options.length) {
        this.phase = 'snitch';
        this.snitch = { slotId: snitches[0].id, playerId: snitches[0].playerId, options };
        this.addLog(`${this.player(snitches[0].playerId).name} 是唯一的告密者，正在点名……`);
        return;
      }
    }
    this.resolve(null);
  }

  forceSnitch(by) {
    if (!this.isHost(by)) return { error: '只有房主可以操作' };
    if (this.phase !== 'snitch') return { error: '现在不是告密阶段' };
    const role = this.snitch.options[Math.floor(this.rng() * this.snitch.options.length)];
    this.addLog(`房主为告密者 ${this.player(this.snitch.playerId).name} 随机点名。`);
    this.resolve(role);
    return {};
  }

  nameRole(pid, role) {
    if (this.phase !== 'snitch') return { error: '现在不是告密阶段' };
    if (pid !== this.snitch.playerId) return { error: '你不是告密者' };
    if (!this.snitch.options.includes(role)) return { error: '只能点名中央已公开的身份' };
    this.resolve(role);
    return {};
  }

  resolve(named) {
    const active = this.activeSlots();
    const out = new Map(); // slotId -> { outcome, refund, shares, text }
    const set = (s, outcome, refund, shares, text) => out.set(s.id, { outcome, refund, shares, text });
    const pending = (r) => active.filter((s) => s.role === r && !out.has(s.id));
    const details = [];

    // 1. 告密者
    const snitches = pending('snitch');
    let loneSnitch = null;
    if (snitches.length === 1) {
      loneSnitch = snitches[0];
      set(loneSnitch, 'snitch', true, true, named ? `告密，点名了${roleName(named)}` : '告密者（无可点名身份）');
      if (named) details.push(`告密者 ${this.player(loneSnitch.playerId).name} 点名了【${roleName(named)}】。`);
    } else if (snitches.length >= 2) {
      snitches.forEach((s) => set(s, 'dup', false, false, '多名告密者，全部出局'));
      details.push(`${snitches.length}名告密者撞车，全部出局，没收保证金。`);
      named = null;
    }

    // 2. 被点名者：淘汰，没收保证金（暴徒例外）
    if (named) {
      const victims = active.filter((s) => s.role === named && !out.has(s.id));
      victims.forEach((s) => set(s, 'named', named === 'brute', false, '被告密者点名淘汰'));
      details.push(victims.length ? `${victims.length}名【${roleName(named)}】被点名淘汰。` : `没有人是【${roleName(named)}】，点名落空。`);
    }

    // 3. 暴徒
    const brutes = pending('brute');
    if (brutes.length === 1) {
      const s = brutes[0];
      set(s, 'ok', true, this.settings.bruteShares, '唯一的暴徒，获得1张威胁卡');
      this.player(s.playerId).threats.push(this.round);
    } else if (brutes.length >= 2) {
      brutes.forEach((s) => set(s, 'dup', true, false, '多名暴徒，全部出局（取回保证金）'));
      details.push(`${brutes.length}名暴徒撞车，全部出局，但取回保证金。`);
    }

    // 4. 司机、恶棍、谋士
    for (const r of ['driver', 'crook', 'mastermind']) {
      const list = pending(r);
      if (list.length === 1) set(list[0], 'ok', true, true, `唯一的${roleName(r)}，参与分赃`);
      else if (list.length >= 2) {
        list.forEach((s) => set(s, 'dup', false, false, `多名${roleName(r)}，全部出局`));
        details.push(`${list.length}名${roleName(r)}撞车，全部出局，没收保证金。`);
      }
    }

    for (const s of active) {
      const o = out.get(s.id);
      if (o.refund) {
        this.player(s.playerId).cash += s.antePaid;
        this.book(s.playerId, 'refund', s.antePaid);
      }
    }

    // 5. 特殊处罚：只剩告密者时不分赃并罚300万，否则告密者正常分赃
    const survivors = active.filter((s) => out.get(s.id).outcome === 'ok');
    if (loneSnitch && survivors.length === 0) {
      const p = this.player(loneSnitch.playerId);
      const loss = Math.min(300, p.cash);
      p.cash -= loss;
      this.book(p.id, 'penalty', -loss);
      out.get(loneSnitch.id).shares = false;
      out.get(loneSnitch.id).text = '只剩告密者自己：损失300万，不分赃';
      details.push(`只剩下告密者 ${p.name}，罚款${loss}万。`);
    }

    // ---------- 第4阶段：分赃 ----------
    const sharers = active.filter((s) => out.get(s.id).shares);
    const share = {};
    if (sharers.length) {
      const hasMM = sharers.some((s) => s.role === 'mastermind');
      const pool = this.loot.amount + (hasMM ? 200 : 0);
      if (hasMM) details.push(`谋士让赃款增加200万：${this.loot.amount} + 200 = ${pool}万。`);
      const each = Math.floor(pool / sharers.length / 100) * 100;
      const rest = pool - each * sharers.length;
      this.publicFund += rest;
      sharers.forEach((s) => {
        this.player(s.playerId).cash += each;
        share[s.id] = each;
      });
      details.push(`${sharers.length}个角色平分${pool}万，每份${each}万${rest ? `，余${rest}万进入公共资金` : ''}。`);

      const driver = sharers.find((s) => s.role === 'driver');
      if (driver) {
        const dp = this.player(driver.playerId);
        let fare = 0;
        for (const s of sharers) {
          if (s === driver) continue;
          const pay = s.playerId === dp.id ? 100 : Math.min(100, this.player(s.playerId).cash);
          if (s.playerId !== dp.id) {
            this.player(s.playerId).cash -= pay;
            dp.cash += pay;
          }
          share[s.id] -= pay;
          share[driver.id] += pay;
          fare += pay;
        }
        if (fare) details.push(`司机 ${dp.name} 收取车费共${fare}万。`);
      }

      const crook = sharers.find((s) => s.role === 'crook');
      const brute = sharers.find((s) => s.role === 'brute');
      if (crook && brute) {
        const bp = this.player(brute.playerId);
        const cp = this.player(crook.playerId);
        const take = bp === cp ? 200 : Math.min(200, bp.cash);
        if (bp !== cp) {
          bp.cash -= take;
          cp.cash += take;
        }
        share[brute.id] -= take;
        share[crook.id] += take;
        details.push(`恶棍 ${cp.name} 从暴徒 ${bp.name} 手里拿走${take}万。`);
      }

      const bonusSlot = this.loot.bonus && sharers.find((s) => s.role === this.loot.bonus);
      if (bonusSlot) {
        this.player(bonusSlot.playerId).cash += 100;
        share[bonusSlot.id] += 100;
        details.push(`${roleName(this.loot.bonus)} 匹配奖励图标，获得100万奖励。`);
      }
    } else {
      details.push('没有角色有分赃资格，本轮赃款作废。');
    }
    // 每份分赃已含车费、恶棍拿钱和奖励
    for (const s of sharers) this.book(s.playerId, 'split', share[s.id]);

    const deltas = Object.fromEntries(this.players.map((p) => [p.id, p.cash - this.roundStart.get(p.id)]));
    this.results = {
      named,
      details,
      slots: active.map((s) => ({ slotId: s.id, playerId: s.playerId, role: s.role, ...out.get(s.id), share: share[s.id] ?? null })),
      deltas,
    };
    this.history.push({
      round: this.round,
      loot: { ...this.loot },
      named,
      slots: this.slots.map((s) => {
        const o = out.get(s.id);
        return { playerId: s.playerId, role: s.role, withdrawn: s.withdrawn, outcome: o ? o.outcome : null, share: share[s.id] ?? null };
      }),
      players: this.players.map((p) => ({ id: p.id, delta: deltas[p.id], cash: p.cash, ledger: { ...this.ledger[p.id] } })),
    });
    for (const d of details) this.addLog(d);

    // 胜利判定：只检查本轮参与分赃的玩家
    const sharingPlayers = [...new Set(sharers.map((s) => s.playerId))].map((id) => this.player(id));
    const reached = sharingPlayers.filter((p) => p.cash >= WIN_CASH);
    let winners = null;
    if (reached.length) {
      const top = Math.max(...reached.map((p) => p.cash));
      winners = reached.filter((p) => p.cash === top);
    } else if (this.round >= MAX_ROUNDS) {
      const top = Math.max(...this.players.map((p) => p.cash));
      winners = this.players.filter((p) => p.cash === top);
    }
    if (winners) {
      this.winners = winners.map((p) => p.id);
      this.phase = 'ended';
      this.addLog(`游戏结束！获胜者：${winners.map((p) => `${p.name}（${p.cash}万）`).join('、')}`);
    } else {
      this.phase = 'results';
    }
  }

  nextRound(pid) {
    if (this.phase !== 'results') return { error: '现在不能进入下一轮' };
    if (!this.canLead(pid)) return { error: '只有带头人（或房主）可以开始下一轮' };
    for (const p of this.players) p.lastRoles = this.slotsOf(p.id).map((s) => s.role);
    this.leaderIdx = (this.leaderIdx + 1) % this.players.length;
    this.startRound();
    return {};
  }

  addChat(pid, text) {
    const p = this.player(pid);
    text = String(text || '').trim().slice(0, 300);
    if (!p || !text) return { error: '消息为空' };
    this.chat.push({ t: Date.now(), name: p.name, text });
    if (this.chat.length > 200) this.chat.shift();
    return {};
  }

  // ---------- 视图（对每个玩家隐藏他人身份） ----------

  viewFor(pid) {
    const me = this.player(pid);
    const reveal = this.phase === 'results' || this.phase === 'ended';
    const resultBySlot = new Map((this.results ? this.results.slots : []).map((r) => [r.slotId, r]));
    const players = this.players.map((p) => ({
      id: p.id,
      name: p.name,
      cash: p.cash,
      threats: p.threats.length,
      connected: p.connected,
      votedRestart: this.restartVotes.includes(p.id),
      isHost: this.effectiveHostId() === p.id,
      isLeader: this.phase !== 'lobby' && this.leaderId() === p.id,
      lastRoles: this.settings.noRepeat || reveal ? p.lastRoles : [],
      chosen: this.slotsOf(p.id).length > 0 && this.slotsOf(p.id).every((s) => s.role),
      slots: this.slotsOf(p.id).map((s) => {
        const r = resultBySlot.get(s.id);
        const visible = p.id === pid || (reveal && !s.withdrawn);
        return {
          id: s.id,
          role: visible ? s.role : null,
          withdrawn: s.withdrawn,
          outcome: r ? r.outcome : null,
          text: r ? r.text : null,
          share: r ? r.share : null,
        };
      }),
      delta: this.results ? this.results.deltas[p.id] ?? 0 : 0,
      ledger: this.results && this.ledger ? this.ledger[p.id] : null,
    }));
    // 回顾里退出者的身份在游戏结束后才公开（自己的始终可见）
    const history = this.history.map((h) => ({
      ...h,
      slots: h.slots.map((s) => ({
        ...s,
        role: !s.withdrawn || this.phase === 'ended' || s.playerId === pid ? s.role : null,
      })),
    }));
    return {
      you: me ? me.id : null,
      isHost: this.isHost(pid),
      canLead: me ? this.canLead(pid) : false,
      phase: this.phase,
      round: this.round,
      maxRounds: MAX_ROUNDS,
      winCash: WIN_CASH,
      settings: this.settings,
      roles: ROLES,
      roleOrder: ROLE_ORDER,
      activeRoles: this.activeRoles,
      allowedRoles: me ? this.allowedRoles(pid) : [],
      slotsPerPlayer: this.phase === 'lobby' ? 1 : this.slotsPerPlayer(),
      loot: this.loot,
      center: this.center,
      publicFund: this.publicFund,
      players,
      offers: this.offers.map((o) => {
        const slot = this.slots.find((s) => s.id === o.slotId);
        return { ...o, quitterId: slot.playerId };
      }),
      snitch: this.snitch && this.phase === 'snitch' ? this.snitch : null,
      results: this.results ? { named: this.results.named, details: this.results.details } : null,
      winners: this.winners,
      history,
      restartVotes: this.restartVotes.filter((id) => this.player(id) && this.player(id).connected).length,
      restartNeed: this.restartNeed(),
      heistReady: this.heistReady,
      heistNeeded: this.phase === 'negotiation' ? this.heistNeeded() : [],
      myThreatsUsable: me ? me.threats.filter((r) => r < this.round).length : 0,
      private: me ? me.private.slice(-20) : [],
      log: this.log.slice(-120),
      chat: this.chat.slice(-100),
    };
  }
}

module.exports = { Game, ROLES, ROLE_ORDER, rolesForCount, LOOT_AMOUNTS, OFFLINE_GRACE_MS };
