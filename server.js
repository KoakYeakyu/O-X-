// ===== OX 토큰 베팅 게임 서버 =====
// 모든 점수 계산은 서버에서 해서, 참가자가 조작할 수 없어요.
const express = require('express');
const http = require('http');
const os = require('os');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
app.use(express.static('public')); // public 폴더가 웹사이트 화면이 돼요

const START = 1000;       // 시작 점수
const games = {};         // 게임 목록 (서버 메모리에 저장, 서버를 끄면 사라져요)
const rand = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const clamp = (n, a, b) => Math.max(a, Math.min(b, Math.floor(+n) || a));
const genCode = () => {
  const c = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s;
  do { s = Array.from({ length: 6 }, () => c[Math.floor(Math.random() * c.length)]).join(''); } while (games[s]);
  return s;
};

// 각 사람에게 보내는 화면용 데이터 (다른 사람의 아이디와 베팅 내용은 숨겨요)
function view(g, { host, pid }) {
  return {
    code: g.code, host: !!host, teams: g.teams, rounds: g.rounds, round: g.round, phase: g.phase,
    q: g.q[g.round] || '',
    players: Object.entries(g.players).map(([id, p]) => ({ nick: p.nick, team: p.team, score: p.score, mine: id === pid })),
    myBet: g.bets[pid] || null,
    betCount: Object.keys(g.bets).length,
    last: g.last && { a: g.last.a, O: g.last.O, X: g.last.X, myGain: g.last.gain[pid] },
  };
}
function push(code) {
  const g = games[code];
  const ids = io.sockets.adapter.rooms.get(code) || [];
  for (const id of ids) { const s = io.sockets.sockets.get(id); if (s) s.emit('state', view(g, s.data)); }
}
function attach(socket, code, extra) {
  socket.data = { code, ...extra };
  socket.join(code);
}

io.on('connection', (socket) => {
  const ack = (cb, o) => typeof cb === 'function' && cb(o);
  const host = () => { const g = games[socket.data.code]; return g && socket.data.host ? g : null; };

  // 관리자: 게임 만들기
  socket.on('create', ({ teams, rounds }, cb) => {
    if (!Array.isArray(teams) || !teams.length) return ack(cb, { ok: false });
    const code = genCode(), hostKey = rand();
    games[code] = {
      code, hostKey, rounds: clamp(rounds, 1, 50), round: 0, phase: 'lobby', // lobby → bet → reveal → … → done
      teams: teams.slice(0, 12).map((t, i) => String(t).trim() || `${i + 1}팀`),
      q: {}, players: {}, bets: {}, last: null, t: Date.now(),
    };
    attach(socket, code, { host: true });
    ack(cb, { ok: true, code, hostKey });
    push(code);
  });
  socket.on('host:resume', ({ code, hostKey }, cb) => {
    const g = games[code];
    if (!g || g.hostKey !== hostKey) return ack(cb, { ok: false });
    attach(socket, code, { host: true });
    ack(cb, { ok: true }); push(code);
  });

  // 참가자: 코드 확인 → 팀 선택 → 입장
  socket.on('peek', ({ code, pid }, cb) => {
    const g = games[String(code).toUpperCase()];
    if (!g) return ack(cb, { ok: false });
    ack(cb, { ok: true, teams: g.teams, rejoin: !!g.players[pid] });
  });
  socket.on('join', ({ code, nick, team, pid }, cb) => {
    code = String(code).toUpperCase();
    const g = games[code];
    if (!g || !pid || !g.teams[team]) return ack(cb, { ok: false });
    if (!g.players[pid]) g.players[pid] = { nick: String(nick).trim().slice(0, 20) || '이름없음', team, score: START };
    attach(socket, code, { pid });
    ack(cb, { ok: true, code }); push(code);
  });
  socket.on('player:resume', ({ code, pid }, cb) => {
    const g = games[code];
    if (!g || !g.players[pid]) return ack(cb, { ok: false });
    attach(socket, code, { pid });
    ack(cb, { ok: true }); push(code);
  });

  // 참가자: 베팅 (보유 점수 안에서 O와 X에 나눠서)
  socket.on('bet', ({ o, x }, cb) => {
    const g = games[socket.data.code], p = g && g.players[socket.data.pid];
    if (!p || g.phase !== 'bet') return ack(cb, { ok: false, error: '지금은 베팅할 수 없어요.' });
    o = Math.max(0, Math.floor(+o) || 0); x = Math.max(0, Math.floor(+x) || 0);
    if (o + x > p.score) return ack(cb, { ok: false, error: `보유 점수(${p.score})를 넘을 수 없어요.` });
    g.bets[socket.data.pid] = { o, x };
    ack(cb, { ok: true }); push(g.code);
  });

  // 관리자: 라운드 진행
  socket.on('start', ({ q }) => {
    const g = host();
    if (!g || !['lobby', 'reveal'].includes(g.phase) || g.round >= g.rounds) return;
    g.round++; g.phase = 'bet'; g.bets = {}; g.q[g.round] = String(q || '').slice(0, 200);
    push(g.code);
  });
  socket.on('reveal', ({ a }) => {
    const g = host();
    if (!g || g.phase !== 'bet' || !['O', 'X'].includes(a)) return;
    // 점수 계산: 정답 쪽 베팅액 × (전체 베팅 ÷ 정답 쪽 전체 베팅) 을 돌려받고, 오답 쪽 베팅은 잃어요.
    // 정답 쪽에 아무도 안 걸었으면 전부 환불해요.
    const bs = Object.entries(g.bets);
    const O = bs.reduce((s, [, b]) => s + b.o, 0), X = bs.reduce((s, [, b]) => s + b.x, 0);
    const T = O + X, C = a === 'O' ? O : X, gain = {};
    for (const [id, b] of bs) {
      const bc = a === 'O' ? b.o : b.x, bw = a === 'O' ? b.x : b.o;
      gain[id] = C > 0 ? Math.round(bc * T / C) - bc - bw : 0;
      g.players[id].score += gain[id];
    }
    g.last = { a, O, X, gain }; g.bets = {}; g.phase = 'reveal';
    push(g.code);
  });
  socket.on('finish', () => {
    const g = host();
    if (g && g.phase === 'reveal') { g.phase = 'done'; push(g.code); }
  });
});

// 12시간 지난 게임은 자동 삭제
setInterval(() => { for (const c in games) if (Date.now() - games[c].t > 12 * 3600e3) delete games[c]; }, 600e3);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n게임 서버 시작!\n  이 컴퓨터:  http://localhost:${PORT}`);
  for (const n of Object.values(os.networkInterfaces()).flat())
    if (n.family === 'IPv4' && !n.internal) console.log(`  휴대폰(같은 Wi-Fi):  http://${n.address}:${PORT}`);
});
