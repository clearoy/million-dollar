'use strict';

const socket = io();
let state = null;
let joinInfo = null; // { playerId } | { spectator: true }
const form = {}; // 保存动态表单的输入值，重绘时恢复
const picked = []; // 准备阶段已点选的身份

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => `${n}万`;
const PHASES = { lobby: '等待开始', planning: '第1阶段：准备', negotiation: '第2阶段：谈判', snitch: '第3阶段：抢劫（告密中）', results: '第4阶段：分赃结果', ended: '游戏结束' };
const OUTCOME = { ok: '✅ 幸存', snitch: '🗣️ 告密', named: '☠️ 被点名', dup: '💥 撞车出局' };

function token() {
  let t = localStorage.getItem('md-token');
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('md-token', t);
  }
  return t;
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add('hidden'), 2500);
}

function act(type, data = {}) {
  socket.emit('action', { type, ...data }, (res) => {
    if (res && res.error) toast(res.error);
  });
}

function join(name) {
  socket.emit('join', { token: token(), name }, (res) => {
    if (res.error) {
      if (name) $('#join-error').textContent = res.error;
      return;
    }
    $('#join-error').textContent = '';
    if (name) localStorage.setItem('md-name', name);
    joinInfo = res;
    render();
  });
}

socket.on('connect', () => {
  joinInfo = null;
  // 自动重连：服务器若认得这个令牌就直接回到座位
  join(localStorage.getItem('md-name') || '');
});

socket.on('state', (s) => {
  state = s;
  if (s.you) joinInfo = { playerId: s.you };
  render();
});

// ---------- 渲染 ----------

const roleName = (r) => (state.roles[r] ? state.roles[r].name : '?');
const tag = (r, extra = '') => `<span class="role role-${r} ${extra}">${esc(roleName(r))}</span>`;
const pname = (id) => {
  const p = state.players.find((x) => x.id === id);
  return p ? esc(p.name) : '?';
};
const me = () => state.players.find((p) => p.id === state.you);

function render() {
  if (!state) return;
  const focus = document.activeElement && document.activeElement.dataset.k ? document.activeElement.dataset.k : null;

  renderStatus();
  renderJoin();
  $('#app').innerHTML = state.phase === 'lobby' ? renderLobby() : renderGame();
  renderLog();
  renderChat();
  renderRules();

  document.querySelectorAll('[data-k]').forEach((el) => {
    if (form[el.dataset.k] !== undefined) el.value = form[el.dataset.k];
  });
  if (focus) {
    const el = document.querySelector(`[data-k="${focus}"]`);
    if (el) el.focus();
  }
}

function renderStatus() {
  const s = state;
  let html = `<span class="pill">${PHASES[s.phase]}</span>`;
  if (s.phase !== 'lobby') {
    html += `<span class="pill">第 ${s.round}/${s.maxRounds} 轮</span>`;
    if (s.loot) {
      html += `<span class="pill loot">赃款 <b>${money(s.loot.amount)}</b> · 保证金 ${money(s.loot.ante)} · 奖励图标 ${s.loot.bonus ? tag(s.loot.bonus) : '无'}</span>`;
    }
    if (s.publicFund) html += `<span class="pill">公共资金 ${money(s.publicFund)}</span>`;
  }
  const mine = me();
  if (mine) {
    html += `<span class="pill">你：<b>${esc(mine.name)}</b> <button class="small ghost" onclick="renameMe()">改名</button></span>`;
    if (s.phase !== 'lobby') {
      html += mine.votedRestart
        ? `<button class="small ghost" onclick="act('voteRestart',{on:false})">撤回重开投票（${s.restartVotes}/${s.restartNeed}）</button>`
        : `<button class="small ghost" onclick="if(confirm('投票重开？在线玩家过半同意后本局作废，回到大厅。'))act('voteRestart',{on:true})">投票重开${s.restartVotes ? `（${s.restartVotes}/${s.restartNeed}）` : ''}</button>`;
    }
  }
  $('#status').innerHTML = html;
}

function renameMe() {
  const name = prompt('新的昵称（最多16个字）', me().name);
  if (name == null || !name.trim()) return;
  socket.emit('action', { type: 'rename', name: name.trim() }, (res) => {
    if (res && res.error) toast(res.error);
    else localStorage.setItem('md-name', name.trim().slice(0, 16));
  });
}

function renderJoin() {
  const show = !state.you;
  $('#join').classList.toggle('hidden', !show);
  if (!show) return;
  const playing = state.phase !== 'lobby';
  $('#join-hint').textContent = playing
    ? '游戏正在进行中，你目前是旁观者。本局结束、房主回到大厅后即可加入。'
    : `输入昵称加入唯一的游戏房间（${state.players.length}/8 人）。`;
  $('#join-form').classList.toggle('hidden', playing);
  if (!$('#join-name').value) $('#join-name').value = localStorage.getItem('md-name') || '';
}

function renderLobby() {
  const s = state;
  const players = s.players.map((p) => `
    <li>
      <span class="dot ${p.connected ? 'on' : ''}"></span>
      ${esc(p.name)} ${p.isHost ? '<span class="badge">房主</span>' : ''} ${p.id === s.you ? '<span class="badge me">你</span>' : ''}
      ${s.isHost && p.id !== s.you ? `<button class="small ghost" onclick="act('kick',{playerId:'${p.id}'})">移出</button>` : ''}
    </li>`).join('');
  const dis = s.isHost ? '' : 'disabled';
  return `
    <section class="card">
      <h2>大厅（${s.players.length}/8）</h2>
      <ul class="lobby-list">${players || '<li class="muted">还没有人</li>'}</ul>
      <h3>设置</h3>
      <label><input type="checkbox" ${s.settings.noRepeat ? 'checked' : ''} ${dis}
        onchange="act('settings',{settings:{noRepeat:this.checked}})"> 变体：同一玩家连续两轮不能选择同一角色</label>
      <label><input type="checkbox" ${s.settings.bruteShares ? 'checked' : ''} ${dis}
        onchange="act('settings',{settings:{bruteShares:this.checked}})"> 唯一的暴徒也参与分赃（与规则中的分赃示例一致；关闭则暴徒拿威胁卡后退出分赃）</label>
      <p class="muted">人数与角色：3人（特殊玩法，每人两个角色，5种全用）· 4人：司机/暴徒/恶棍 · 5–6人：加告密者 · 7–8人：再加谋士</p>
      ${renderRoleIntro()}
      ${s.isHost
        ? `<button ${s.players.length < 3 ? 'disabled' : ''} onclick="act('start')">开始游戏</button>`
        : '<p class="muted">等待房主开始游戏……</p>'}
    </section>`;
}

function renderGame() {
  return `
    <div class="grid2">
      <section class="card">
        <h3>👥 玩家</h3>
        ${renderPlayers()}
        ${renderCenter()}
        ${renderRoleIntro()}
      </section>
      <section class="card">
        ${renderActions()}
      </section>
    </div>`;
}

function renderPlayers() {
  const s = state;
  const showResult = s.phase === 'results' || s.phase === 'ended';
  const rows = s.players.map((p) => {
    const slots = p.slots.map((sl) => {
      let html;
      if (sl.role) html = tag(sl.role, sl.withdrawn ? 'faded' : '');
      else if (s.phase === 'planning') html = `<span class="role hidden-role">${p.chosen ? '已选定' : '选择中…'}</span>`;
      else html = '<span class="role hidden-role">？</span>';
      if (sl.withdrawn) html += ' <span class="muted">已退出</span>';
      if (showResult && sl.outcome) {
        html += ` <span class="outcome" title="${esc(sl.text)}">${OUTCOME[sl.outcome]}</span>`;
        if (sl.share != null) html += ` <span class="muted">分得${money(sl.share)}</span>`;
      }
      return `<div>${html}</div>`;
    }).join('');
    const last = p.lastRoles && p.lastRoles.length && s.settings.noRepeat
      ? `<div class="muted small">上轮：${p.lastRoles.map((r) => esc(roleName(r))).join('、')}</div>` : '';
    const delta = showResult && p.delta ? `<span class="${p.delta > 0 ? 'up' : 'down'}">${p.delta > 0 ? '+' : ''}${p.delta}</span>` : '';
    const win = s.winners && s.winners.includes(p.id) ? '🏆 ' : '';
    return `
      <tr class="${p.id === s.you ? 'mine' : ''}">
        <td>
          <span class="dot ${p.connected ? 'on' : ''}"></span>${win}${esc(p.name)}
          ${p.isLeader ? '<span class="badge lead" title="带头人">👑带头人</span>' : ''}
          ${p.isHost ? '<span class="badge">房主</span>' : ''}
        </td>
        <td class="num"><b>${money(p.cash)}</b> ${delta}</td>
        <td>${p.threats ? `🔪×${p.threats}` : ''}</td>
        <td>${slots}${last}</td>
      </tr>`;
  }).join('');
  return `<table class="players"><thead><tr><th>玩家</th><th>现金</th><th>威胁</th><th>身份</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderCenter() {
  const c = state.center;
  if (!c) return '<p class="muted">所有人选定身份后，角色牌会混洗、藏起1张，其余公开。</p>';
  return `<div class="center"><span class="muted">公共区角色牌：</span> ${c.revealed.map((r) => tag(r)).join(' ')} <span class="role hidden-role">🂠 藏起1张</span></div>`;
}

let roleIntroOpen = false;

function renderRoleIntro() {
  // 大厅里介绍全部角色，开局后只介绍本局用到的
  const roles = state.phase === 'lobby' ? state.roleOrder : state.activeRoles;
  const items = roles.map((r) => `<li>${tag(r)} ${esc(state.roles[r].desc)}</li>`).join('');
  return `<details class="role-intro" ${roleIntroOpen ? 'open' : ''} ontoggle="roleIntroOpen=this.open">
    <summary>🎭 ${state.phase === 'lobby' ? '角色介绍' : '本局角色介绍'}</summary>
    <ul>${items}</ul>
    <p class="muted small">能力只在该身份恰好1人幸存时生效；同一身份2人以上则全部出局。</p>
  </details>`;
}

function renderActions() {
  const s = state;
  if (!s.you) return '<h3>旁观中</h3><p class="muted">你可以看到公开信息和聊天。</p>';
  const parts = [];
  const mine = me();
  if (s.phase === 'planning') parts.push(renderPlanning(mine));
  if (s.phase === 'negotiation') parts.push(renderNegotiation(mine));
  if (s.phase === 'snitch') {
    if (s.snitch.playerId === s.you) {
      parts.push(`<h3>🗣️ 你是唯一的告密者</h3><p>点名中央已公开的一种身份，所有该身份且仍在场的玩家被淘汰。之后你正常参与分赃（如果只剩你自己，则罚300万、不分赃）：</p>
        <div class="btns">${s.snitch.options.map((r) => `<button onclick="act('name',{role:'${r}'})">${esc(roleName(r))}</button>`).join('')}</div>`);
    } else {
      parts.push(`<h3>抢劫中</h3><p>等待唯一的告密者 ${pname(s.snitch.playerId)} 点名……</p>`);
    }
  }
  if (s.phase === 'results' || s.phase === 'ended') parts.push(renderResults());
  if (s.private.length) {
    parts.push(`<h3>🔒 只有你能看到</h3><ul class="private">${s.private.slice().reverse().map((m) => `<li>第${m.round}轮：${esc(m.text)}</li>`).join('')}</ul>`);
  }
  if (s.isHost) {
    parts.push(`<details class="host"><summary>房主工具</summary>
      ${s.phase === 'planning' ? `<button class="ghost" onclick="act('forceChoose')">为未选择的玩家随机选身份</button>` : ''}
      <button class="ghost danger" onclick="if(confirm('确定结束本局并回到大厅？'))act('reset')">结束本局，回到大厅</button>
    </details>`);
  }
  return parts.join('');
}

function renderPlanning(mine) {
  const s = state;
  const chosenCount = s.players.filter((p) => p.chosen).length;
  if (mine.chosen) {
    return `<h3>已选定身份</h3>
      <p>你的身份：${mine.slots.map((sl) => tag(sl.role)).join(' ')}（已缴纳保证金）</p>
      <p class="muted">等待其他玩家……（${chosenCount}/${s.players.length}）</p>`;
  }
  const need = s.slotsPerPlayer;
  for (let i = picked.length - 1; i >= 0; i--) if (!s.allowedRoles.includes(picked[i])) picked.splice(i, 1);
  const btns = s.activeRoles.map((r) => {
    const allowed = s.allowedRoles.includes(r);
    const on = picked.includes(r);
    return `<button class="role-btn role-${r} ${on ? 'on' : ''}" ${allowed ? '' : 'disabled'} onclick="togglePick('${r}')">
      <b>${esc(roleName(r))}</b><small>${esc(s.roles[r].desc)}</small>${allowed ? '' : '<small>（上轮已选）</small>'}</button>`;
  }).join('');
  return `<h3>秘密选择身份${need > 1 ? `（选择${need}个不同角色）` : ''}</h3>
    <p class="muted">选定后不能更换。将缴纳保证金 ${money(s.loot.ante)}${need > 1 ? ' × 2' : ''}（现金不足时由储备现金补足）。</p>
    <div class="role-grid">${btns}</div>
    <button ${picked.length === need ? '' : 'disabled'} onclick="confirmPick()">确认身份</button>
    <p class="muted">已选定：${chosenCount}/${s.players.length}</p>`;
}

function togglePick(r) {
  const i = picked.indexOf(r);
  if (i >= 0) picked.splice(i, 1);
  else {
    picked.push(r);
    while (picked.length > state.slotsPerPlayer) picked.shift();
  }
  render();
}

function confirmPick() {
  act('choose', { roles: picked.slice() });
  picked.length = 0;
}

function renderNegotiation(mine) {
  const s = state;
  const others = s.players.filter((p) => p.id !== s.you);
  const opt = (list) => list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  const activeMine = mine.slots.filter((sl) => !sl.withdrawn);
  const parts = [];

  parts.push(`<h3>你的身份</h3><div class="btns">${mine.slots.map((sl) => `
    <span>${tag(sl.role, sl.withdrawn ? 'faded' : '')} ${sl.withdrawn ? '<span class="muted">已退出</span>'
      : `<button class="small ghost" onclick="if(confirm('退出后不能反悔，取回保证金且不参与本轮分赃。确定？'))act('withdraw',{slotId:'${sl.id}'})">退出本轮</button>`}</span>`).join('')}</div>`);
  if (activeMine.length === 0) parts.push('<p class="muted">你已退出本轮：保持沉默，隐藏身份。</p>');

  // 交易提议
  const offers = s.offers.map((o) => {
    const text = o.proposer === o.payerId
      ? `${pname(o.payerId)} 出 ${money(o.amount)} 换 ${pname(o.quitterId)} 退出`
      : `${pname(o.quitterId)}：${pname(o.payerId)} 给我 ${money(o.amount)} 我就退出`;
    const responder = o.proposer === o.payerId ? o.quitterId : o.payerId;
    let btn = '';
    if (responder === s.you) {
      btn = `<button class="small" onclick="act('respondOffer',{offerId:'${o.id}',accept:true})">接受</button>
             <button class="small ghost" onclick="act('respondOffer',{offerId:'${o.id}',accept:false})">拒绝</button>`;
    } else if (o.proposer === s.you) {
      btn = `<button class="small ghost" onclick="act('respondOffer',{offerId:'${o.id}',accept:false})">撤回</button>`;
    }
    return `<li>${text} ${btn}</li>`;
  }).join('');
  parts.push(`<h3>🤝 交易提议</h3>${offers ? `<ul class="offers">${offers}</ul>` : '<p class="muted">暂无。接受后系统自动"先付钱 → 再退出"。</p>'}`);

  // 发起交易
  const targetSlots = [];
  for (const p of others) {
    const live = p.slots.filter((sl) => !sl.withdrawn);
    live.forEach((sl, i) => targetSlots.push(`<option value="${sl.id}">${esc(p.name)}${live.length > 1 ? ` 的第${i + 1}个角色` : ''}</option>`));
  }
  const mySlotOpts = activeMine.map((sl) => `<option value="${sl.id}">${esc(roleName(sl.role))}</option>`).join('');
  parts.push(`<div class="forms">
    ${targetSlots.length ? `<div class="row">我出 <input data-k="payAmt" type="number" min="1" step="100" placeholder="万"> 万，让
      <select data-k="paySlot">${targetSlots.join('')}</select> 退出
      <button class="small" onclick="sendOffer('pay')">提议</button></div>` : ''}
    ${activeMine.length && others.length ? `<div class="row"><select data-k="askPayer">${opt(others)}</select> 给我
      <input data-k="askAmt" type="number" min="1" step="100" placeholder="万"> 万，我就退出
      ${activeMine.length > 1 ? `<select data-k="askSlot">${mySlotOpts}</select>` : ''}
      <button class="small" onclick="sendOffer('ask')">提议</button></div>` : ''}
    <div class="row">直接付给 <select data-k="tfTo">${opt(others)}</select>
      <input data-k="tfAmt" type="number" min="1" step="100" placeholder="万"> 万
      <button class="small" onclick="sendTransfer()">付款</button></div>
    ${s.myThreatsUsable ? `<div class="row">🔪 使用威胁卡（剩${s.myThreatsUsable}张可用）查看 <select data-k="thTarget">${opt(others)}</select> 的身份
      <button class="small" onclick="act('threat',{target:val('thTarget')})">使用</button></div>` : ''}
  </div>`);

  if (s.canLead) {
    parts.push(`<button class="big" onclick="if(confirm('谈判结束，开始抢劫？'))act('heist')">🚨 谈判结束，开始抢劫</button>`);
  } else {
    parts.push(`<p class="muted">由带头人 ${pname(s.players.find((p) => p.isLeader).id)} 宣布谈判结束。</p>`);
  }
  return parts.join('');
}

function val(k) {
  const el = document.querySelector(`[data-k="${k}"]`);
  return el ? el.value : '';
}

function clearForm(...keys) {
  keys.forEach((k) => delete form[k]);
}

function sendOffer(kind) {
  if (kind === 'pay') {
    act('offer', { slotId: val('paySlot'), payerId: state.you, amount: Number(val('payAmt')) });
    clearForm('payAmt');
  } else {
    const mine = me().slots.filter((sl) => !sl.withdrawn);
    const slotId = mine.length > 1 ? val('askSlot') : mine[0].id;
    act('offer', { slotId, payerId: val('askPayer'), amount: Number(val('askAmt')) });
    clearForm('askAmt');
  }
}

function sendTransfer() {
  const to = val('tfTo');
  const amount = Number(val('tfAmt'));
  const name = pname(to);
  if (!confirm(`确定直接付给 ${name} ${amount}万？`)) return;
  act('transfer', { to, amount });
  clearForm('tfAmt');
}

function renderResults() {
  const s = state;
  let html = `<h3>📊 第${s.round}轮结算</h3><ol class="details">${s.results.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ol>`;
  html += '<p class="muted">鼠标悬停 / 点按玩家列表中的结果可看说明；退出的玩家身份保密。</p>';
  if (s.phase === 'ended') {
    html += `<div class="winner">🏆 获胜者：${s.winners.map(pname).join('、')}</div>`;
    if (s.isHost) html += `<button class="big" onclick="act('reset')">回到大厅，再来一局</button>`;
  } else if (s.canLead) {
    html += `<button class="big" onclick="act('next')">进入第${s.round + 1}轮</button>`;
  } else {
    html += `<p class="muted">等待带头人开始下一轮……</p>`;
  }
  return html;
}

function renderLog() {
  const el = $('#log');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = state.log.map((l) => `<div>${esc(l.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function renderChat() {
  const el = $('#chat');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  el.innerHTML = state.chat.map((m) => `<div><b>${esc(m.name)}：</b>${esc(m.text)}</div>`).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
  $('#chat-form').classList.toggle('hidden', !state.you);
}

function renderRules() {
  const el = $('#rules');
  const key = String(state.settings.bruteShares);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const T = (r) => tag(r);
  const bruteLine = state.settings.bruteShares
    ? '取回保证金，获得1张威胁卡，并正常参与分赃。'
    : '取回保证金，获得1张威胁卡，然后退出本轮分赃（房主已关闭"暴徒参与分赃"）。';
  el.innerHTML = `
    <h4>一、目标与胜利</h4>
    <ul>
      <li>每人初始 500 万，目标是赚到最多的钱。</li>
      <li>每轮分赃后，<b>本轮参与分赃</b>的玩家累计达到 2000 万即提前获胜；多人同时达到时钱最多者胜。单靠谈判收到的钱不会触发胜利。</li>
      <li>没人提前获胜则最多 8 轮，第 8 轮结束时钱最多者获胜；最高金额相同则共同获胜。</li>
    </ul>

    <h4>二、人数与角色</h4>
    <ul>
      <li>4人：司机、暴徒、恶棍；5–6人：再加告密者；7–8人：再加谋士。</li>
      <li>3人：特殊玩法，见第八条。</li>
      <li>第一轮带头人随机，之后每轮顺时针交接。带头人负责宣布谈判结束、进入下一轮（掉线时房主可代劳）。</li>
    </ul>

    <h4>三、第1阶段：准备</h4>
    <ol>
      <li>翻开一张赃款牌：金额 800万—1200万，保证金 100万或200万，可能带一个角色奖励图标。</li>
      <li>每人<b>秘密</b>选择一个身份并缴纳保证金（现金不足由储备现金补足，退还时只退自己实际交的部分）。不同玩家可以选同一身份；选定后本轮不能更换。</li>
      <li>所有人的角色牌混洗，随机藏起1张，其余公开。大家只知道本轮有哪些身份，不知道谁是谁。</li>
    </ol>

    <h4>四、第2阶段：谈判</h4>
    <ul>
      <li>可以说真话、撒谎、假装其他身份、劝别人退出，也可以付钱换别人退出，或自己主动退出。</li>
      <li>交易顺序固定为：谈妥条件 → 先付钱 → 再退出。系统中接受交易后自动执行。</li>
      <li>退出后取回全部保证金，可保留谈判得到的钱，不能反悔，身份保密，不参与抢劫和分赃，本轮应保持沉默。</li>
      <li>威胁卡：谈判中使用，指定一名玩家偷看其身份，用后丢弃；可累积多张；本轮刚得到的不能本轮使用。</li>
    </ul>

    <h4>五、第3阶段：抢劫判定</h4>
    <p>只有没退出的玩家参加，按以下顺序判定：</p>
    <ol>
      <li>${T('snitch')} <b>恰好1人：</b>取回保证金，点名一种公开的身份，所有该身份且在场的玩家被淘汰；之后告密者正常参与分赃。<b>2人以上：</b>全部出局，没收保证金，不能点名。</li>
      <li><b>被点名者：</b>直接淘汰，不发动能力、不分赃，没收保证金（被点名的暴徒例外，取回保证金）。</li>
      <li>${T('brute')} <b>恰好1人且未被点名：</b>${bruteLine}<b>2人以上：</b>全部出局，但都取回保证金。</li>
      <li>${T('driver')} ${T('crook')} ${T('mastermind')} 依次判定：<b>恰好1人：</b>取回保证金，参与分赃；<b>2人以上：</b>该身份全部出局，没收保证金。</li>
      <li><b>只剩告密者：</b>如果除唯一的告密者外没有任何角色幸存，告密者罚 300 万且不分赃。</li>
    </ol>

    <h4>六、第4阶段：分赃（固定顺序）</h4>
    <ol>
      <li>${T('mastermind')} 幸存：总赃款 +200 万。</li>
      <li>所有分赃角色平分，每份按 100 万向下取整，零头进入公共资金。</li>
      <li>${T('driver')} 幸存：其他每个分赃角色付给司机 100 万。</li>
      <li>${T('crook')} 和 ${T('brute')} 都参与分赃：恶棍从暴徒手里拿走 200 万（可以动用暴徒原有的钱）。</li>
      <li>赃款牌的奖励图标与某个分赃角色相同：该角色从储备领 100 万。</li>
    </ol>
    <p class="muted">例：赃款1200万，司机、恶棍、谋士、暴徒分赃，奖励图标为暴徒。1200+200=1400，每人300（余200进公共资金）→ 司机收车费后 600/200/200/200 → 恶棍拿钱后 恶棍400、暴徒0 → 暴徒奖励后 100。最终：司机600、恶棍400、谋士200、暴徒100。</p>

    <h4>七、保证金速查</h4>
    <ul>
      <li><b>取回：</b>主动退出者、唯一的告密者、所有暴徒（包括撞车和被点名）、唯一的司机/恶棍/谋士。</li>
      <li><b>没收：</b>撞车的告密者/司机/恶棍/谋士、被点名的非暴徒角色。</li>
    </ul>

    <h4>八、三人玩法</h4>
    <ul>
      <li>5种角色全部使用，每人每轮秘密选两个不同角色，分别缴纳保证金。</li>
      <li>公共区共6张角色牌：藏1张，公开5张。每个角色可以单独退出。</li>
      <li>两个角色都幸存的玩家拿两份分赃；自己两个角色之间的车费、恶棍拿钱等互相抵消。</li>
    </ul>

    <h4>九、可选变体（大厅中由房主开启）</h4>
    <ul>
      <li>同一玩家连续两轮不能选择同一角色（隔一轮可以）。开启后每人上一轮的角色公开显示。</li>
    </ul>

    <h4>十、本版补充说明</h4>
    <ul>
      <li>赃款牌为自设的10张（800—1200万），官方牌组明细未知。</li>
      <li>付车费或被恶棍拿钱时现金不足的，最多付到0，不欠款。</li>
    </ul>`;
}

// ---------- 事件 ----------

document.addEventListener('input', (e) => {
  if (e.target.dataset.k) form[e.target.dataset.k] = e.target.value;
});
document.addEventListener('change', (e) => {
  if (e.target.dataset.k) form[e.target.dataset.k] = e.target.value;
});

$('#join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#join-name').value.trim();
  if (name) join(name);
});

$('#chat-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  if (!input.value.trim()) return;
  act('chat', { text: input.value });
  input.value = '';
});
