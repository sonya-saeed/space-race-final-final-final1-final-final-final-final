
/* ---------------- questions ---------------- */
const QUESTIONS = [
  ["Which planet is known as the Red Planet?",["Venus","Mars","Jupiter","Mercury"],1],
  ["What is the closest star to Earth?",["Sirius","Proxima Centauri","The Sun","Betelgeuse"],2],
  ["Who was the first human in space?",["Neil Armstrong","Buzz Aldrin","Yuri Gagarin","Alan Shepard"],2],
  ["Which planet has the most prominent rings?",["Saturn","Neptune","Mars","Earth"],0],
  ["What year did humans first land on the Moon?",["1965","1969","1972","1975"],1],
  ["What is the largest planet in our solar system?",["Saturn","Earth","Jupiter","Uranus"],2],
  ["Our galaxy is called the…",["Andromeda","Milky Way","Triangulum","Whirlpool"],1],
  ["How many planets are in our solar system?",["7","8","9","10"],1],
  ["What force keeps planets orbiting the Sun?",["Magnetism","Friction","Gravity","Inertia only"],2],
  ["Which planet is closest to the Sun?",["Mercury","Venus","Earth","Mars"],0],
  ["What is the Moon's approximate distance from Earth?",["38,400 km","384,000 km","3,840,000 km","38,400,000 km"],1],
  ["What is a light-year a measure of?",["Time","Speed","Distance","Brightness"],2],
  ["Which planet spins on its side?",["Uranus","Mars","Mercury","Jupiter"],0],
  ["What is the hottest planet in the solar system?",["Mercury","Venus","Mars","Jupiter"],1],
  ["What is the name of NASA's Mars rover that landed in 2021?",["Curiosity","Opportunity","Perseverance","Spirit"],2]
];
const PER_FLIGHT = 10;

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
const show = (id, on=true) => $(id).classList.toggle('hidden', !on);
function mulberry(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
function seededOrder(seed){
  const r=mulberry(seed), idx=QUESTIONS.map((_,i)=>i);
  for(let i=idx.length-1;i>0;i--){const j=Math.floor(r()*(i+1));[idx[i],idx[j]]=[idx[j],idx[i]]}
  return idx.slice(0,PER_FLIGHT);
}
const fmt = ms => (ms/1000).toFixed(1)+'s';
const uid = () => Math.random().toString(36).slice(2,10);
const genCode = () => { const a='ABCDEFGHJKMNPQRSTUVWXYZ23456789'; let s=''; for(let i=0;i<5;i++) s+=a[Math.floor(Math.random()*a.length)]; return s; };

/* ---------------- backends ---------------- */
function makeFirebaseBackend(){
  firebase.initializeApp(FIREBASE_CONFIG);
  const db = firebase.database();
  let ref, offs = [];
  return {
    name:'Online (Firebase)',
    async exists(code){ return (await db.ref('rooms/'+code+'/meta').get()).exists(); },
    async create(code, meta){ await db.ref('rooms/'+code+'/meta').set(meta); },
    open(code, onMeta, onPlayers){
      ref = db.ref('rooms/'+code);
      const m = ref.child('meta'), p = ref.child('players');
      m.on('value', s => onMeta(s.val()));
      p.on('value', s => onPlayers(s.val() || {}));
      offs = [()=>m.off(), ()=>p.off()];
    },
    setMeta(patch){ return ref.child('meta').update(patch); },
    setPlayer(id, data){ return ref.child('players/'+id).update(data); },
    async resetPlayers(ids){ const u={}; ids.forEach(i=>{u[i+'/correct']=0;u[i+'/answered']=0;u[i+'/time']=0;u[i+'/finished']=false}); return ref.child('players').update(u); },
    removePlayer(id){ return ref.child('players/'+id).remove(); },
    onLeaveRemove(id){ ref.child('players/'+id).onDisconnect().remove(); },
    close(){ offs.forEach(f=>f()); }
  };
}
function makeLocalBackend(){
  // Same-browser multi-tab testing only.
  let key, onM, onP;
  const read = () => JSON.parse(localStorage.getItem(key) || '{"meta":null,"players":{}}');
  const write = d => { localStorage.setItem(key, JSON.stringify(d)); fire(); };
  const fire = () => { const d = read(); onM && onM(d.meta); onP && onP(d.players||{}); };
  const handler = e => { if(e.key===key) fire(); };
  return {
    name:'Local test mode (same browser tabs only) — add Firebase config for real online play',
    async exists(code){ return !!JSON.parse(localStorage.getItem('sr_room_'+code)||'null')?.meta; },
    async create(code, meta){ localStorage.setItem('sr_room_'+code, JSON.stringify({meta,players:{}})); },
    open(code, m, p){ key='sr_room_'+code; onM=m; onP=p; window.addEventListener('storage', handler); fire(); },
    setMeta(patch){ const d=read(); d.meta={...d.meta,...patch}; write(d); },
    setPlayer(id, data){ const d=read(); d.players=d.players||{}; d.players[id]={...(d.players[id]||{}),...data}; write(d); },
    resetPlayers(ids){ const d=read(); ids.forEach(i=>{ if(d.players[i]) Object.assign(d.players[i],{correct:0,answered:0,time:0,finished:false}) }); write(d); },
    removePlayer(id){ const d=read(); delete d.players[id]; write(d); },
    onLeaveRemove(id){ window.addEventListener('beforeunload',()=>{ const d=read(); delete d.players[id]; localStorage.setItem(key,JSON.stringify(d)); }); },
    close(){ window.removeEventListener('storage', handler); onM=onP=null; }
  };
}

function makePeerBackend(){
  // Peer-to-peer: the host's browser holds the party; friends connect straight to it.
  const PREFIX='spacerace-v1-';
  let peer=null, conns=[], hostConn=null, isHost=false;
  let state={meta:null,players:{}}, onM=null, onP=null, queue=[];
  const fire=()=>{ if(onM && state.meta) onM(state.meta); if(onP) onP(state.players||{}); };
  const commit=()=>{ conns.forEach(c=>{ if(c.open) c.send({t:'s',state}); }); fire(); };
  const newPeer=id=>new Promise((res,rej)=>{
    const p=id?new Peer(id):new Peer();
    p.on('open',()=>{ p.on('error',()=>{}); res(p); });
    p.on('error',rej);
  });
  const toHost=msg=>{ if(hostConn && hostConn.open) hostConn.send(msg); else queue.push(msg); };
  return {
    name:'peer',
    async exists(code){
      let p; try{ p=await newPeer(); }catch(e){ return false; }
      return new Promise(res=>{
        let done=false;
        const end=v=>{ if(done) return; done=true; try{p.destroy()}catch(e){} res(v); };
        const c=p.connect(PREFIX+code);
        c.on('open',()=>end(true));
        p.on('error',()=>end(false));
        setTimeout(()=>end(false),8000);
      });
    },
    async create(code, meta){
      peer=await newPeer(PREFIX+code);
      isHost=true; state={meta,players:{}};
      peer.on('connection',c=>{
        conns.push(c);
        c.on('open',()=>c.send({t:'s',state}));
        c.on('data',m=>{
          if(m.t==='p'){ c.pid=m.id; state.players[m.id]={...(state.players[m.id]||{}),...m.data}; commit(); }
          else if(m.t==='r'){ delete state.players[m.id]; commit(); }
        });
        c.on('close',()=>{
          conns=conns.filter(x=>x!==c);
          if(c.pid && state.players[c.pid]){ delete state.players[c.pid]; commit(); }
        });
      });
    },
    open(code, m, p){
      onM=m; onP=p;
      if(isHost){ fire(); return; }
      newPeer().then(pr=>{
        peer=pr;
        hostConn=peer.connect(PREFIX+code,{reliable:true});
        hostConn.on('open',()=>{ queue.forEach(x=>hostConn.send(x)); queue=[]; });
        hostConn.on('data',d=>{ if(d.t==='s'){ state=d.state; state.players=state.players||{}; fire(); } });
        hostConn.on('close',()=>{ if(onM) onM({...(state.meta||{}),state:'closed'}); });
      });
    },
    setMeta(patch){ state.meta={...state.meta,...patch}; commit(); },
    setPlayer(id,data){
      if(isHost){ state.players[id]={...(state.players[id]||{}),...data}; commit(); }
      else toHost({t:'p',id,data});
    },
    resetPlayers(ids){
      ids.forEach(i=>{ if(state.players[i]) Object.assign(state.players[i],{correct:0,answered:0,time:0,finished:false}); });
      commit();
    },
    removePlayer(id){
      if(isHost){ delete state.players[id]; commit(); } else toHost({t:'r',id});
    },
    onLeaveRemove(){},
    close(){
      onM=onP=null;
      try{ conns.forEach(c=>c.close()); }catch(e){}
      try{ peer && peer.destroy(); }catch(e){}
      peer=null; conns=[]; hostConn=null; isHost=false; queue=[]; state={meta:null,players:{}};
    }
  };
}

let backend = null;
async function initBackend(){
  const load = src => new Promise((res,rej)=>{const s=document.createElement('script');s.src=src;s.onload=res;s.onerror=rej;document.head.appendChild(s)});
  if(FIREBASE_CONFIG.apiKey){
    try{
      await load('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
      await load('https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js');
      backend = makeFirebaseBackend(); return;
    }catch(e){ console.error(e); }
  }
  try{
    await load('https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js');
    backend = makePeerBackend();
  }catch(e){ console.error(e); backend = makeLocalBackend(); }
}

/* ---------------- state ---------------- */
let me = { id: uid(), name:'' };
let room = null;        // {code, isHost}
let meta = null, players = {};
let run = null;         // current flight {order, i, correct, t0, tick}
let solo = false;

/* ---------------- party flow ---------------- */
function getName(){
  const n = $('name').value.trim();
  if(!n){ $('homeErr').textContent='Enter a display name first.'; return null; }
  me.name = n; localStorage.setItem('sr_name', n); $('homeErr').textContent=''; return n;
}
function inviteUrl(code){ return location.origin + location.pathname + '?room=' + code; }

async function createParty(){
  if(!getName()) return;
  let code; do { code = genCode(); } while(await backend.exists(code));
  await backend.create(code, { host: me.id, state:'lobby', seed: 0, created: Date.now() });
  await enterRoom(code, true);
}
async function joinParty(){
  if(!getName()) return;
  const code = $('joinCode').value.trim().toUpperCase();
  if(code.length!==5){ $('homeErr').textContent='Room codes are 5 characters.'; return; }
  if(!(await backend.exists(code))){ $('homeErr').textContent='No party found with that code.'; return; }
  await enterRoom(code, false);
}
async function enterRoom(code, isHost){
  solo = false;
  room = { code, isHost };
  show('home', false); show('party');
  show('lobby'); show('game', false); show('results', false);
  $('roomCode').textContent = code;
  $('inviteLink').textContent = inviteUrl(code);
  backend.open(code, onMeta, onPlayers);
  await backend.setPlayer(me.id, { name: me.name, correct:0, answered:0, time:0, finished:false, joined: Date.now() });
  backend.onLeaveRemove(me.id);
  history.replaceState(null,'','?room='+code);
}

function onMeta(m){
  if(!m) return;
  if(m.state==='closed'){ leaveRoom(); $('homeErr').style.color='var(--bad)'; $('homeErr').textContent='The host left, so the party has ended.'; return; }
  meta = m;
  room.isHost = (m.host === me.id);
  if(m.state === 'racing' && !run && $('results').classList.contains('hidden')){
    startCountdown(m.seed);
  }
  if(m.state === 'lobby' && !$('results').classList.contains('hidden')){
    show('results', false); show('lobby');
    backend.setPlayer(me.id, { correct:0, answered:0, time:0, finished:false });
  }
  renderLobby();
}
function onPlayers(p){ players = p; renderBoard(); renderLobby(); checkEnd(); }

function renderLobby(){
  const n = Object.keys(players).length;
  const host = room && room.isHost;
  $('btnStart').classList.toggle('hidden', !host || meta?.state!=='lobby');
  $('lobbyHint').textContent = host
    ? `${n} pilot${n===1?'':'s'} in the crew. Share the link, then start when everyone is in.`
    : `${n} pilot${n===1?'':'s'} in the crew. Waiting for the host to start the race…`;
  $('btnAgain').classList.toggle('hidden', !host);
}

$('btnStart').onclick = () => backend.setMeta({ state:'racing', seed: Math.floor(Math.random()*1e9), startedAt: Date.now() });
$('btnAgain').onclick = async () => { await backend.resetPlayers(Object.keys(players)); await backend.setMeta({ state:'lobby' }); };
$('btnCopy').onclick = async () => {
  const url = inviteUrl(room.code);
  try { await navigator.clipboard.writeText(url); }
  catch(e){ const ta=document.createElement('textarea'); ta.value=url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  $('btnCopy').textContent='COPIED ✓'; setTimeout(()=>$('btnCopy').textContent='COPY INVITE LINK',1500);
};
$('btnLeave').onclick = leaveRoom;
$('btnHome').onclick = leaveRoom;
function leaveRoom(){
  if(room){ backend.removePlayer(me.id); backend.close(); }
  room=null; meta=null; players={}; run=null; solo=false;
  history.replaceState(null,'',location.pathname);
  show('party', false); show('home');
}

/* ---------------- flight ---------------- */
function startCountdown(seed){
  show('lobby', false); show('results', false); show('game');
  $('opts').innerHTML=''; $('qText').textContent='Get ready…'; $('qNum').textContent='';
  let n=3; $('timer').textContent='';
  run = { counting:true };
  const iv = setInterval(()=>{
    $('qText').textContent = n>0 ? `Launch in ${n}…` : 'LIFTOFF! 🚀';
    if(n<0){ clearInterval(iv); beginFlight(seed); }
    n--;
  }, 800);
}
function beginFlight(seed){
  run = { order: seededOrder(seed), i:0, correct:0, t0: performance.now(), done:false };
  run.tick = setInterval(()=>{ $('timer').textContent = '⏱ '+fmt(performance.now()-run.t0); }, 100);
  showQuestion();
}
function showQuestion(){
  const [q, opts, ans] = QUESTIONS[run.order[run.i]];
  $('qNum').textContent = `Question ${run.i+1} / ${PER_FLIGHT}`;
  $('qText').textContent = q;
  $('opts').innerHTML = '';
  opts.forEach((o,k)=>{
    const b = document.createElement('button');
    b.className='opt'; b.textContent=o;
    b.onclick = () => answer(k, ans, b);
    $('opts').appendChild(b);
  });
}
function answer(k, ans, btn){
  if(run.locked) return; run.locked = true;
  const ok = k===ans;
  btn.classList.add(ok?'good':'bad');
  if(!ok) [...$('opts').children][ans].classList.add('good');
  if(ok) run.correct++;
  run.i++;
  const finished = run.i >= PER_FLIGHT;
  const time = Math.round(performance.now()-run.t0);
  const upd = { correct: run.correct, answered: run.i, time, finished };
  if(solo) players[me.id] = { ...(players[me.id]||{name:me.name}), ...upd }, renderBoard();
  else backend.setPlayer(me.id, upd);
  setTimeout(()=>{
    run.locked = false;
    if(finished){ finishFlight(time); } else showQuestion();
  }, 700);
}
function finishFlight(time){
  clearInterval(run.tick);
  run.done = true;
  show('game', false); show('results');
  $('resScore').textContent = `${run.correct} / ${PER_FLIGHT}`;
  $('resSub').textContent = `Flight time ${fmt(time)} · accuracy ${Math.round(run.correct/PER_FLIGHT*100)}%`;
  $('btnAgain').classList.toggle('hidden', solo ? false : !(room && room.isHost));
  checkEnd();
}
function checkEnd(){
  if(!run?.done || solo) return;
  const all = Object.values(players);
  const waiting = all.filter(p=>!p.finished).length;
  if(waiting>0) $('resSub').textContent += ` · waiting for ${waiting} pilot${waiting===1?'':'s'}…`;
}

/* ---------------- leaderboard ---------------- */
function sorted(){
  return Object.entries(players).sort((a,b)=>{
    const A=a[1],B=b[1];
    if((B.correct||0)!==(A.correct||0)) return (B.correct||0)-(A.correct||0);
    // ties: finished runs rank by time, unfinished by progress
    if(!!B.finished!==!!A.finished) return B.finished?1:-1;
    return (A.time||0)-(B.time||0);
  });
}
function renderBoard(){
  const list = sorted();
  const body = $('board'); body.innerHTML='';
  const tracks = $('tracks'); tracks.innerHTML='';
  list.forEach(([id,p],i)=>{
    const tr = document.createElement('tr'); if(id===me.id) tr.className='me';
    const cells = [i+1, p.name||'?', `${p.correct||0}/${p.answered||0}`, p.answered ? fmt(p.time||0) : '–'];
    cells.forEach((c,ci)=>{ const td=document.createElement('td'); td.textContent=c;
      if(ci===1 && p.finished){ const t=document.createElement('span'); t.className='tag'; t.textContent='DONE'; td.appendChild(t); }
      if(ci===1 && meta && meta.host===id){ const t=document.createElement('span'); t.className='tag'; t.textContent='HOST'; td.appendChild(t); }
      tr.appendChild(td); });
    body.appendChild(tr);
    const tk = document.createElement('div'); tk.className='track';
    const pct = Math.min(100, ((p.answered||0)/PER_FLIGHT)*92);
    tk.innerHTML = `<span class="rocket" style="left:${pct}%">🚀</span><span class="tname"></span>`;
    tk.querySelector('.tname').textContent = p.name||'?';
    tracks.appendChild(tk);
  });
}

/* ---------------- solo ---------------- */
$('btnSolo').onclick = () => {
  if(!getName()) return;
  solo = true; room = null; meta = null;
  players = { [me.id]: { name: me.name, correct:0, answered:0, time:0, finished:false } };
  show('home', false); show('party'); show('lobby', false); show('results', false);
  renderBoard();
  startCountdown(Math.floor(Math.random()*1e9));
};
$('btnAgain').addEventListener('click', () => {
  if(solo){
    players[me.id] = { name: me.name, correct:0, answered:0, time:0, finished:false };
    run=null; show('results', false); renderBoard();
    startCountdown(Math.floor(Math.random()*1e9));
  }
}, true);
const safe = fn => async () => {
  $('homeErr').style.color='var(--bad)';
  try{ await fn(); }
  catch(e){ console.error(e); $('homeErr').textContent="Couldn't connect. Check your internet and try again."; }
};
$('btnCreate').onclick = safe(createParty);
$('btnJoin').onclick = safe(joinParty);

/* ---------------- boot ---------------- */
(async function(){
  $('name').value = localStorage.getItem('sr_name') || '';
  await initBackend();
  const r = new URLSearchParams(location.search).get('room');
  if(r){ $('joinCode').value = r.toUpperCase(); $('homeErr').textContent='You were invited! Enter your name and press JOIN.'; $('homeErr').style.color='var(--good)'; }
})();

/* ---------------- starfield ---------------- */
(function(){
  const c=$('stars'), x=c.getContext('2d'); let S=[];
  function size(){ c.width=innerWidth; c.height=innerHeight; S=Array.from({length:120},()=>({x:Math.random()*c.width,y:Math.random()*c.height,r:Math.random()*1.5+.3,v:Math.random()*.4+.1})); }
  size(); addEventListener('resize',size);
  (function f(){ x.clearRect(0,0,c.width,c.height); x.fillStyle='#fff'; S.forEach(s=>{ s.y+=s.v; if(s.y>c.height){s.y=0;s.x=Math.random()*c.width} x.globalAlpha=.4+s.r/3; x.beginPath(); x.arc(s.x,s.y,s.r,0,7); x.fill(); }); requestAnimationFrame(f); })();
})();
