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
  $('#status').innerHTML = html;
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
  if (el.dataset.done) return;
  el.dataset.done = '1';
  const roles = state.roleOrder.map((r) => `<li>${tag(r)} ${esc(state.roles[r].desc)}</li>`).join('');
  el.innerHTML = `
    <p><b>目标：</b>赚最多的钱。每人初始500万。每轮分赃后，参与分赃的玩家达到2000万即触发胜利（多人则钱最多者胜）；否则第8轮结束时钱最多者获胜，平局共同获胜。</p>
    <p><b>每轮流程：</b>①翻赃款牌，秘密选身份并缴保证金 → 角色牌混洗、藏1张、其余公开；②自由谈判（可撒谎、付钱换别人退出、主动退出；退出取回保证金、不参与分赃）；③抢劫判定，顺序：告密者（唯一时点名一种身份，之后正常分赃）→ 被点名者 → 暴徒 → 司机 → 恶棍 → 谋士，同一身份有2人以上则全部出局；④分赃：谋士+200万 → 幸存角色平分（余数进公共资金） → 司机收车费 → 恶棍拿暴徒200万 → 奖励图标+100万。</p>
    <ul>${roles}</ul>
    <p><b>保证金：</b>告密者（唯一）、暴徒（含撞车/被点名）、唯一的司机/恶棍/谋士取回；撞车的司机/恶棍/谋士/告密者和被点名者没收。若最后只剩告密者，告密者罚300万且不分赃。</p>
    <p><b>威胁卡：</b>唯一的暴徒获得，之后的轮次在谈判中使用，偷看一名玩家身份。</p>`;
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
