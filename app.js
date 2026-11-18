// ===== 화면(브라우저) 코드 =====
const socket = io(); // 서버와 실시간 연결
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} },
  del: k => { try { localStorage.removeItem(k); } catch (e) {} },
};
// 내 기기를 구분하는 아이디 (http 접속에서는 randomUUID가 없을 수 있어서 대체 방식 사용)
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const pid = ls.get('ox_pid') || newId();
ls.set('ox_pid', pid);

let S = null;        // 서버가 보내준 현재 게임 상태
let role = null;     // 'admin' 또는 'player'
let lastKey = '';    // 입력칸이 지워지지 않게, 단계가 바뀔 때만 화면을 새로 그려요
let joining = null;

// 새로고침·재접속해도 이어서 하기
socket.on('connect', () => {
  const r = ls.get('ox_role'), c = ls.get('ox_code');
  const fail = () => { ls.del('ox_role'); ls.del('ox_code'); home(); };
  if (r === 'admin' && c) socket.emit('host:resume', { code: c, hostKey: ls.get('ox_hostKey') }, res => res.ok ? (role = 'admin') : fail());
  else if (r === 'player' && c) socket.emit('player:resume', { code: c, pid }, res => res.ok ? (role = 'player') : fail());
  else if (!S) home();
});
socket.on('state', s => { S = s; render(); });

// ---------- 시작 화면 ----------
function home() {
  S = null; role = null; lastKey = ''; $('#live').innerHTML = '';
  $('#main').innerHTML = `<div class="card">
    <button onclick="adminSetup()">👑 관리자로 시작 (코드 받기)</button>
    <button class="ghost" onclick="joinForm()">🙋 참가자로 입장 (코드 입력)</button></div>`;
}
function leave() { ls.del('ox_role'); ls.del('ox_code'); home(); }

// ---------- 관리자: 게임 설정 ----------
function adminSetup() {
  $('#main').innerHTML = `<div class="card"><h3>게임 설정</h3>
    <div class="row"><div>팀 개수<input id="tc" type="number" min="1" max="12" value="3" oninput="teamInputs()"></div>
    <div>게임(라운드) 수<input id="rc" type="number" min="1" max="50" value="5"></div></div>
    <div id="tn"></div>
    <button onclick="create()">게임 만들기</button><button class="ghost" onclick="home()">뒤로</button></div>`;
  teamInputs();
}
function teamInputs() {
  const n = Math.max(1, Math.min(12, +$('#tc').value || 1));
  const old = [...document.querySelectorAll('.tn')].map(e => e.value);
  $('#tn').innerHTML = Array.from({ length: n }, (_, i) =>
    `<input class="tn" placeholder="${i + 1}팀 이름 (글자 수 제한 없음)" value="${esc(old[i] || '')}">`).join('');
}
function create() {
  const teams = [...document.querySelectorAll('.tn')].map(e => e.value);
  socket.emit('create', { teams, rounds: +$('#rc').value }, res => {
    if (!res.ok) return alert('게임을 만들지 못했어요.');
    role = 'admin'; ls.set('ox_role', 'admin'); ls.set('ox_code', res.code); ls.set('ox_hostKey', res.hostKey);
  });
}

// ---------- 참가자: 입장 ----------
function joinForm() {
  $('#main').innerHTML = `<div class="card"><h3>참가하기</h3>
    <input id="jc" placeholder="관리자가 알려준 코드" maxlength="6" style="text-transform:uppercase">
    <input id="jn" placeholder="닉네임" value="${esc(ls.get('ox_nick') || '')}">
    <div id="jm" class="neg"></div>
    <button onclick="joinNext()">다음</button><button class="ghost" onclick="home()">뒤로</button></div>`;
}
function joinNext() {
  const code = $('#jc').value.trim().toUpperCase(), nick = $('#jn').value.trim();
  if (!code || !nick) return ($('#jm').textContent = '코드와 닉네임을 입력해 주세요.');
  ls.set('ox_nick', nick);
  socket.emit('peek', { code, pid }, res => {
    if (!res.ok) return ($('#jm').textContent = '해당 코드의 게임이 없어요.');
    joining = { code, nick };
    if (res.rejoin) return pickTeam(0); // 이미 참가한 기기면 팀 선택 없이 다시 입장
    $('#main').innerHTML = `<div class="card"><h3>팀을 선택하세요</h3>
      ${res.teams.map((t, i) => `<button class="ghost" onclick="pickTeam(${i})">${esc(t)}</button>`).join('')}</div>`;
  });
}
function pickTeam(team) {
  socket.emit('join', { ...joining, team, pid }, res => {
    if (!res.ok) return alert('입장하지 못했어요.');
    role = 'player'; ls.set('ox_role', 'player'); ls.set('ox_code', res.code);
  });
}

// ---------- 공통: 순위·결과 ----------
const me = () => S.players.find(p => p.mine);
function board() {
  const T = S.teams.map((n, i) => {
    const m = S.players.filter(p => p.team === i);
    return { n, cnt: m.length, s: m.reduce((a, p) => a + p.score, 0) };
  }).sort((a, b) => b.s - a.s);
  const P = [...S.players].sort((a, b) => b.score - a.score);
  return `<div class="card"><h3>🏆 팀 순위 (팀원 점수 합계)</h3>
    ${T.map((t, k) => `<div class="li"><span>${k + 1}. ${esc(t.n)} <span class="mut">${t.cnt}명</span></span><b>${t.s}</b></div>`).join('')}</div>
    <div class="card"><h3>개인 순위</h3>
    ${P.length ? P.slice(0, 10).map((p, k) => `<div class="li"><span>${k + 1}. ${esc(p.nick)} <span class="mut">${esc(S.teams[p.team])}</span></span><b>${p.score}</b></div>`).join('') : '<span class="mut">아직 참가자가 없어요.</span>'}</div>`;
}
function resultBox() {
  const R = S.last, T = R.O + R.X, pct = v => (T ? Math.round(v / T * 100) : 0), g = R.myGain;
  return `<div class="card"><h3>정답 공개</h3><div class="big ${R.a === 'O' ? 'lo' : 'lx'}">${R.a}</div>
    <div class="mut">전체 베팅: O ${R.O} (${pct(R.O)}%) · X ${R.X} (${pct(R.X)}%)${(R.a === 'O' ? R.O : R.X) === 0 ? ' · 정답 베팅이 없어 환불' : ''}</div>
    ${!S.host ? `<div style="margin-top:8px">내 이번 라운드 변동: <b class="${(g || 0) >= 0 ? 'pos' : 'neg'}">${(g || 0) > 0 ? '+' : ''}${g || 0}</b></div>` : ''}</div>`;
}
function podium() {
  const P = [...S.players].sort((a, b) => b.score - a.score).slice(0, 3);
  return `<div class="card"><h3>🎉 최종 시상</h3>${P.map((p, k) => `<div class="li"><span>${['🥇', '🥈', '🥉'][k]} ${esc(p.nick)} <span class="mut">${esc(S.teams[p.team])}</span></span><b>${p.score}</b></div>`).join('') || '참가자 없음'}</div>`;
}

// ---------- 화면 그리기 ----------
function render() {
  if (!S) return;
  const key = [role, S.phase, S.round, me() ? 1 : 0].join('|');
  if (key !== lastKey) { lastKey = key; $('#main').innerHTML = S.host ? adminMain() : playerMain(); }
  $('#live').innerHTML = S.host ? adminLive() : playerLive();
}

// 관리자
const qBox = () => `<input id="q" placeholder="이번 문제 (선택, 참가자 화면에 표시)">`;
function adminMain() {
  if (S.phase === 'lobby') return `<div class="card">${qBox()}<button onclick="startRound()">라운드 1 시작</button></div>`;
  if (S.phase === 'bet') return `<div class="card"><h3>라운드 ${S.round}/${S.rounds} · 정답을 누르면 베팅이 마감돼요</h3>
    <div class="row"><button class="o" onclick="socket.emit('reveal',{a:'O'})">정답 O</button><button class="x" onclick="socket.emit('reveal',{a:'X'})">정답 X</button></div></div>`;
  if (S.phase === 'reveal') return S.round < S.rounds
    ? `<div class="card">${qBox()}<button onclick="startRound()">라운드 ${S.round + 1} 시작</button></div>`
    : `<div class="card"><button onclick="socket.emit('finish')">최종 결과 보기</button></div>`;
  return `<div class="card"><button class="ghost" onclick="leave()">새 게임 만들기</button></div>`;
}
function startRound() { socket.emit('start', { q: $('#q') ? $('#q').value : '' }); }
function adminLive() {
  const st = { lobby: '참가자 대기 중', bet: `라운드 ${S.round} 베팅 중 · 제출 ${S.betCount}/${S.players.length}명`, reveal: `라운드 ${S.round} 결과 공개됨`, done: '게임 종료' }[S.phase];
  return `<div class="card"><h3>참가 코드 (참가자에게 알려주세요)</h3><div class="code">${esc(S.code)}</div><div class="mut" style="text-align:center">${st}</div></div>
    ${S.phase === 'reveal' ? resultBox() : ''}${S.phase === 'done' ? podium() : ''}
    <div class="card"><h3>참가자 ${S.players.length}명</h3>${S.teams.map((t, i) => `<div><b>${esc(t)}</b> ${S.players.filter(p => p.team === i).map(p => `<span class="pill">${esc(p.nick)}</span>`).join('') || '<span class="mut">없음</span>'}</div>`).join('')}</div>
    ${board()}`;
}

// 참가자
function playerMain() {
  const m = me();
  if (!m) return `<div class="card">참가 정보가 없어요.<button onclick="leave()">처음으로</button></div>`;
  if (S.phase === 'lobby') return `<div class="card">관리자가 게임을 시작하기를 기다리는 중…</div>`;
  if (S.phase === 'bet') {
    const b = S.myBet || { o: 0, x: 0 };
    return `<div class="card"><h3>라운드 ${S.round}/${S.rounds}</h3>
      <div style="font-size:19px;margin-bottom:8px">${esc(S.q) || 'O 또는 X에 베팅하세요'}</div>
      <div class="mut">보유 ${m.score}점 안에서 O, X에 나눠 베팅할 수 있어요. 마감 전까지 수정 가능.</div>
      <div class="row"><div class="lo">O 베팅<input id="bo" class="bo" type="number" inputmode="numeric" min="0" value="${b.o}"></div>
      <div class="lx">X 베팅<input id="bx" class="bx" type="number" inputmode="numeric" min="0" value="${b.x}"></div></div>
      <div id="bm"></div><button onclick="placeBet()">베팅 확정</button></div>`;
  }
  return '';
}
function placeBet() {
  socket.emit('bet', { o: $('#bo').value, x: $('#bx').value }, res => {
    $('#bm').innerHTML = res.ok ? '<span class="pos">저장됨 ✓ 마감 전까지 수정할 수 있어요</span>' : `<span class="neg">${esc(res.error)}</span>`;
  });
}
function playerLive() {
  const m = me();
  if (!m) return '';
  return `<div class="card"><div class="mut">${esc(m.nick)} · ${esc(S.teams[m.team])} · 코드 ${esc(S.code)}</div><div class="big">내 점수 ${m.score}</div></div>
    ${S.phase === 'reveal' ? resultBox() : ''}${S.phase === 'done' ? podium() : ''}${board()}`;
}
