'use strict';
// ======================================================================
//  net.js —— Cloudflare Durable Objects 云端实时联机（6 位房间码 · 64Hz 快照）
//    房主的浏览器跑权威对局（机器人、伤害、经济、C4、比分全在这里算），
//    加入者本机预测自己的移动（地图碰撞两边一致），开火/购买/拾取等操作发给房主判定；
//    其他角色按房主快照插值显示，射击命中由房主按加入者看到的画面做延迟补偿。
//    传输：/api/arena/ws?room=XXXXXX&proto=sandstorm（Durable Objects WebSocket 中继）
// ======================================================================
const NET_SNAP_EVERY = 2;        // 每 2 个 tick（64Hz）发一次快照
const NET_INTERP = 0.05;         // 加入者看其他角色的插值延迟（秒）
const NET_REWIND_MAX = 0.25;     // 延迟补偿最多回溯 250ms
const NET_SLOTS = ['primary', 'secondary', 'knife', 'nade', 'c4'];
// 自己身上的这些声音由本机模拟产生，房主转发回来的同名声音要跳过
const NET_SELF_LOCAL = /^(step_|jump$|land$|slidemove$|magout$|magin$)/;

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const nv = (v) => [r3(v.x), r3(v.y), r3(v.z)];
const vn = (a, out = new THREE.Vector3()) => out.set(a[0], a[1], a[2]);
// Effects 调用参数的序列化：Vector3 → {V:[x,y,z]}
const fxEnc = (x) => (x && x.isVector3 ? { V: nv(x) } : x);
const fxDec = (x) => (x && x.V ? vn(x.V) : x);

// ======================================================================
//  连接（房主发出 `目标|json`，收到的都是 `来源|json`，来源 0 = 服务器）
// ======================================================================
class NetConn {
  constructor(url) { this.url = url; this.ws = null; this.id = 0; this.role = null; this.archiveToken = ''; this.onmsg = null; this.onclose = null; }
  open(role, name) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(this.url); } catch (e) { reject(new Error('无法连接：' + e.message)); return; }
      this.ws = ws;
      let done = false;
      const fail = (msg) => { if (!done) { done = true; reject(new Error(msg)); } };
      const timer = setTimeout(() => { fail('连接云端房间超时，请检查网络后重试'); try { ws.close(); } catch (e) { /* ignore */ } }, 8000);
      ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', role, name }));
      ws.onerror = () => fail('无法连接云端房间，请确认房间号有效或稍后重试');
      ws.onclose = () => { clearTimeout(timer); fail('与云端房间的连接已断开'); if (done && this.onclose) this.onclose(); };
      ws.onmessage = (e) => {
        const s = e.data, i = s.indexOf('|');
        const from = Number(s.slice(0, i));
        let m; try { m = JSON.parse(s.slice(i + 1)); } catch (err) { return; }
        if (!done) {
          if (from === 0 && m.t === 'welcome') { done = true; clearTimeout(timer); this.id = m.id; this.role = m.role; this.archiveToken = typeof m.archiveToken === 'string' ? m.archiveToken : ''; resolve(m); }
          else if (from === 0 && m.t === 'error') { fail(m.msg); ws.close(); }
          return;
        }
        if (this.onmsg) this.onmsg(from, m);
      };
    });
  }
  get ok() { return this.ws && this.ws.readyState === 1; }
  send(obj) { if (this.ok) this.ws.send(JSON.stringify(obj)); }                 // 加入者 → 房主
  sendTo(to, obj) { if (this.ok) this.ws.send(to + '|' + JSON.stringify(obj)); }  // 房主 → 某人 / '*'
  sendRaw(to, json) { if (this.ok) this.ws.send(to + '|' + json); }               // 已经序列化好的 json
  close() { this.onclose = null; if (this.ws) try { this.ws.close(); } catch (e) { /* ignore */ } this.ws = null; }
}

// ======================================================================
//  房主端：把远端玩家接进对局，向所有人广播快照和事件
// ======================================================================
class NetHost {
  constructor(conn) {
    this.conn = conn; this.host = true; this.client = false;
    this.g = null; this.evq = []; this.n = 0;
  }
  attach(g) { this.g = g; }
  detach() { this.g = null; }
  remotes() { return this.g ? this.g.actors.filter((a) => a.remote) : []; }
  byPid(pid) { return this.g && this.g.actors.find((a) => a.remote && a.pid === pid); }

  emit(ev) { if (!this.g) return; ev.ht = r3(this.g.time); this.evq.push(ev); }
  tell(a, msg) { if (a && a.remote) this.conn.sendTo(a.pid, msg); }

  // ---------------- 收到加入者的消息 ----------------
  onMessage(pid, m) {
    const g = this.g, a = this.byPid(pid);
    if (!g || !a) return;
    if (m.t === 'in') {
      a.inq.push(m);
      if (a.inq.length > 3) {   // 两边时钟漂移/网络抖动导致积压：丢最旧的，按键沿并入下一包（积压越多操作越“肉”）
        const old = a.inq.shift(), nx = a.inq[0];
        nx.e |= old.e; if (!nx.sr && old.sr) nx.sr = old.sr;
      }
      if (m.rtt != null) a.ping = m.rtt;
    } else if (m.t === 'buy') g.buy(a, String(m.id), false);
    else if (m.t === 'fall') g.applyDamage(a, null, clamp(Number(m.d) || 0, 0, 200), 'fall', null, null);
    else if (m.t === 'pi') this.conn.sendTo(pid, { t: 'po', c: m.c });
  }

  // ---------------- 每 tick：先把远端输入写进角色 ----------------
  preTick() {
    for (const a of this.remotes()) {
      const c = a.cmd;
      c.attackPressed = c.attack2Pressed = c.usePressed = c.reload = c.jumpPressed = c.duckPressed = false;
      const m = a.inq.shift();
      if (!m) continue;
      if (m.ss !== a.spawnSeq) continue;   // 出生/传送之前发出的包：位置已经作废
      const b = m.b, e = m.e;
      c.fwd = m.c[0]; c.side = m.c[1];
      c.attack = !!(b & 1); c.attack2 = !!(b & 2); c.use = !!(b & 4); c.walk = !!(b & 8); c.duck = !!(b & 16); c.jump = !!(b & 32); c.sprint = !!(b & 64);
      c.attackPressed = !!(e & 1); c.attack2Pressed = !!(e & 2); c.usePressed = !!(e & 4); c.reload = !!(e & 8);
      c.jumpPressed = !!(e & 16); c.duckPressed = !!(e & 32);
      if (e & 64) c.drop = true;
      if (e & 128) c.inspect = true;
      if (m.sr && NET_SLOTS.concat('last').includes(m.sr)) c.slotReq = m.sr;
      if (!a.alive) continue;
      a.prevPos.copy(a.pos);
      a.netApply(m);
      a.viewT = typeof m.rt === 'number' ? m.rt : this.g.time;
    }
  }

  // ---------------- 每 tick：记录位置历史，按频率发快照 ----------------
  postTick() {
    const g = this.g;
    for (const a of g.actors) {
      if (!a.hist) a.hist = [];
      a.hist.push(g.time, a.pos.x, a.pos.y, a.pos.z, a.yaw);
      if (a.hist.length > 5 * 48) a.hist.splice(0, 5 * 8);
    }
    if (++this.n % NET_SNAP_EVERY) return;
    const rem = this.remotes();
    if (this.n % 64 === 0 || this.rosterDirty) this.sendRoster();
    if (!rem.length) { this.evq.length = 0; return; }
    const md = g.mode, B = md.bomb;
    const M = {};
    for (const a of rem) {
      M[a.pid] = {
        rp: r2(a.recoilP), ry: r2(a.recoilY), pp: r2(a.punchP), py: r2(a.punchY), ap: r2(a.aimPunchP), ay: r2(a.aimPunchY),
        vm: r2(a.velMod), pt: r2(a.plantT), dt: r2(a.defuseT || 0), ri: r2(a.recoilIdx), fi: r2(a.fireInacc), zt: r2(Math.min(a.zoomT, 9)),
        cb: md.canBuy && md.canBuy(a) ? 1 : 0, bt: md.buyTimeLeft ? Math.ceil(md.buyTimeLeft()) : 0, ev: a.events.splice(0),
      };
    }
    const common = {
      t: 's',
      ht: r3(g.time),
      m: { ph: md.phase, sc: [md.score.CT, md.score.T], tl: md.timeLeft ? md.timeLeft() : null, fr: g.frozen ? 1 : 0, ov: g.over ? 1 : 0, ia: g.infiniteAmmo ? 1 : 0,
        b: B ? { d: B.dropped ? 1 : 0, p: B.planted ? 1 : 0, x: nv(B.pos), y: r3(B.yaw || 0), e: B.exploded ? 1 : 0, f: B.defused ? 1 : 0 } : null },
      A: g.actors.map((a) => this.encode(a)),
      ev: this.evq,
      M,
    };
    this.conn.sendRaw('*', JSON.stringify(common));
    this.evq = [];
  }
  encode(a) {
    const I = a.inv, p = I.primary, s = I.secondary, w = a.weapon;
    const fl = (a.ducked ? 1 : 0) | (a.sliding ? 2 : 0) | (a.onGround ? 4 : 0) | (a.sprinting ? 8 : 0) | (a.reloading ? 16 : 0) | (a.planting ? 32 : 0) |
      (a.defusing ? 64 : 0) | (a.helmet ? 128 : 0) | ((a.scoped & 3) << 8);
    return [a.id, a.team === 'CT' ? 0 : 1, a.alive ? 1 : 0, r3(a.pos.x), r3(a.pos.y), r3(a.pos.z), r2(a.vel.x), r2(a.vel.y), r2(a.vel.z),
      r3(a.yaw), r3(a.pitch), fl, r2(a.duckAmt), r2(a.slideAmt), Math.max(0, Math.ceil(a.hp)), Math.ceil(a.armor), a.money, a.kills, a.deaths, a.assists, a.mvp,
      w ? w.id : '', NET_SLOTS.indexOf(a.slot),
      [p ? p.id : '', p ? p.mag : 0, p ? p.reserve : 0, s ? s.id : '', s ? s.mag : 0, s ? s.reserve : 0, I.knife.id, I.nades.he, I.nades.flash, I.nades.smoke, I.c4 ? 1 : 0, I.defuser ? 1 : 0],
      a.spawnSeq, this.g.time - (a.spottedT || -9) < 0.6 ? 1 : 0,
      typeof Skins !== 'undefined' ? Skins.indexOf(a.skinOf(w ? w.id : '')) : 0];
  }
  roster() {
    return this.g.actors.map((a) => ({ n: a.id, name: a.name, team: a.team, bot: a.isBot ? 1 : 0, pid: a.isPlayer ? this.conn.id : a.remote ? a.pid : 0, ping: a.ping == null ? null : a.ping }));
  }
  sendRoster() { this.rosterDirty = false; if (this.g) this.conn.sendTo('*', { t: 'ro', list: this.roster() }); }

  // ---------------- 延迟补偿：把其他角色临时挪回射手当时看到的位置 ----------------
  rewind(shooter, fn) {
    const g = this.g, t = clamp(shooter.viewT == null ? g.time : shooter.viewT, g.time - NET_REWIND_MAX, g.time);
    if (g.time - t < 0.004) return fn();
    const saved = [];
    for (const a of g.actors) {
      if (a === shooter || !a.alive || !a.hist || !a.model || a.model.ragdoll) continue;
      const H = a.hist;
      let i = H.length - 5;
      while (i > 0 && H[i] > t) i -= 5;
      let x = H[i + 1], y = H[i + 2], z = H[i + 3], yaw = H[i + 4];
      if (H[i] <= t && i + 5 < H.length) {
        const k = clamp((t - H[i]) / Math.max(1e-6, H[i + 5] - H[i]), 0, 1);
        x = lerp(x, H[i + 6], k); y = lerp(y, H[i + 7], k); z = lerp(z, H[i + 8], k); yaw = H[i + 4] + wrapAngle(H[i + 9] - H[i + 4]) * k;
      }
      const r = a.model.root;
      saved.push([a, a.pos.clone(), r.position.clone(), r.rotation.y]);
      a.pos.set(x, y, z); r.position.set(x, y, z); r.rotation.y = yaw; r.updateMatrixWorld(true);
    }
    try { return fn(); } finally {
      for (const [a, p, rp, ry] of saved) {
        a.pos.copy(p);
        if (a.alive && !a.model.ragdoll) { const r = a.model.root; r.position.copy(rp); r.rotation.y = ry; r.updateMatrixWorld(true); }
      }
    }
  }
}

// ======================================================================
//  加入端：自己的角色本机模拟，其他一切照房主的快照显示
// ======================================================================
class NetClient {
  constructor(conn) {
    this.conn = conn; this.host = false; this.client = true;
    this.g = null; this.snaps = []; this.evq = []; this.pending = []; this.latest = null; this.off = null; this.rtt = null; this.pingT = 0;
    this.byId = new Map(); this.me = null; this.drops = new Map(); this.n = 0; this.lastPh = null;
  }
  attach(g) {
    this.g = g; this.byId.clear(); this.drops.clear();
    if (this.pending.length) {
      const q = this.pending.splice(0);
      for (const [f, msg] of q) this.onMessage(f, msg);
    }
  }
  detach() { this.g = null; }
  get myId() { return this.me ? this.me.id : -1; }
  now() { return performance.now() / 1000; }
  renderT() { return this.off == null ? 0 : this.now() + this.off - NET_INTERP; }

  onMessage(from, m) {
    if (!this.g) { if (this.pending.length < 180) this.pending.push([from, m]); return; }
    if (m.t === 's') {
      const o = m.ht - this.now();
      // 时钟偏移：只在“包来得更早”时立刻跟上，晚到的包慢慢跟（抗 WiFi 抖动）
      if (this.off == null || o > this.off || Math.abs(o - this.off) > 0.5) this.off = o; else this.off += (o - this.off) * 0.02;
      this.latest = m; this.snaps.push(m);
      while (this.snaps.length > 40) this.snaps.shift();
      const myId = this.myId;
      for (const ev of m.ev) {
        // 和自己有关的事件立刻处理（开枪反馈、受伤、阵亡），其余跟随插值延迟，与模型动作对齐
        if (ev.a === myId || ev.v === myId || ev.k === myId || ev.s === myId || ev.t === 'clr') this.event(ev); else this.evq.push(ev);
      }
      this.applySelf(m);
    } else if (m.t === 'ro') this.roster(m.list);
    else if (m.t === 'ctr') HUD.center(...m.a);
    else if (m.t === 's2') Sound.play(m.n, { vol: m.v });
    else if (m.t === 'ob') { if (this.g.player.alive) HUD.openBuy(this.g); }
    else if (m.t === 'po') this.rtt = Math.round(performance.now() - m.c);
  }

  // ---------------- 名单：建 / 删镜像角色 ----------------
  roster(list) {
    const g = this.g, seen = new Set();
    for (const r of list) {
      seen.add(r.n);
      let a = this.byId.get(r.n);
      if (r.pid === this.conn.id) {
        a = g.player;
        if (this.me !== a || a.id !== r.n) {
          // 本地 id 可能和房主那边别人的 id 撞号，只删自己名下的映射
          if (this.byId.get(a.id) === a) this.byId.delete(a.id);
          a.id = r.n; this.me = a; this.byId.set(r.n, a);
        }
        a.name = r.name;
      } else if (!a) {
        a = g.createMirror(r);
        a.id = r.n; this.byId.set(r.n, a);
      }
      a.name = r.name; a.isBot = !!r.bot; a.ping = r.ping;
    }
    for (const [id, a] of this.byId) if (!seen.has(id) && a !== g.player) { g.removeActor(a); this.byId.delete(id); }
  }

  // ---------------- 自己：状态以最新快照为准，位置本机预测 ----------------
  applySelf(m) {
    const g = this.g, P = g.player, M = m.m;
    const me = m.me || (m.M && m.M[this.conn.id]) || null;
    g.frozen = !!M.fr; g.over = !!M.ov; g.infiniteAmmo = !!M.ia;
    const md = g.mode;
    md.phase = M.ph; md.score.CT = M.sc[0]; md.score.T = M.sc[1]; md.tl = M.tl; md.cb = !!(me && me.cb); md.bt = me ? me.bt : 0;
    md.syncBomb(M.b);
    const row = this.me && m.A.find((x) => x[0] === P.id);
    if (!row) return;
    const wasAlive = P.alive, moneyBefore = P.money;
    if (row[1] !== (P.team === 'CT' ? 0 : 1)) { P.team = row[1] ? 'T' : 'CT'; g.resetModel(P, true); g.vm.setTeam(P.team); }
    this.applyStats(P, row);
    if (P.money > moneyBefore && !md.infiniteMoney) HUD.moneyFlash();
    if (row[24] !== P.spawnSeq) {     // 出生 / 回合开始：传送到房主给的位置
      if (row[2]) {
        P.spawnAt(new THREE.Vector3(row[3], row[4], row[5]), row[9]);   // spawnAt 会自增序号，所以序号放在后面写
        P.spawnTime = g.time;
        HUD.hideDeath(); g.flashAmt = 0; g.deathT = 0;
      }
      P.spawnSeq = row[24];
    }
    P.alive = !!row[2];
    if (wasAlive && !P.alive) { P.sliding = false; P.scoped = 0; }
    this.syncInv(P, row);
    const fl = row[11];
    P.reloading = !!(fl & 16); P.planting = !!(fl & 32); P.defusing = !!(fl & 64); P.scoped = (fl >> 8) & 3;
    if (me) {
      this.recoil = me;
      P.velMod = me.vm; P.plantT = me.pt; P.defuseT = me.dt; P.recoilIdx = me.ri; P.fireInacc = me.fi; P.zoomT = me.zt;
      for (const ev of me.ev || []) {
        if (ev.t === 's2') { Sound.play(ev.n, { vol: ev.v, rate: ev.r || 1 }); continue; }
        P.events.push(ev);
      }
    }
    // 爆破模式每回合冻结期自动打开购买菜单
    if (M.ph === 'freeze' && this.lastPh !== 'freeze' && P.alive && md.cb) HUD.openBuy(g);
    this.lastPh = M.ph;
  }
  applyStats(a, row) {
    a.hp = row[14]; a.armor = row[15]; a.money = row[16]; a.kills = row[17]; a.deaths = row[18]; a.assists = row[19]; a.mvp = row[20];
    a.helmet = !!(row[11] & 128);
    a.spottedT = row[25] ? this.g.time : -9;
  }
  syncInv(a, row) {
    const I = a.inv, v = row[23];
    const slotInst = (cur, id, mag, res) => { if (!id) return null; const w = cur && cur.id === id ? cur : new WeaponInst(id); w.mag = mag; w.reserve = res; return w; };
    I.primary = slotInst(I.primary, v[0], v[1], v[2]);
    I.secondary = slotInst(I.secondary, v[3], v[4], v[5]);
    if (I.knife.id !== v[6]) I.knife = new WeaponInst(v[6]);
    I.nades.he = v[7]; I.nades.flash = v[8]; I.nades.smoke = v[9]; I.c4 = !!v[10]; I.defuser = !!v[11];
    const slot = NET_SLOTS[row[22]] || 'knife', wid = row[21];
    const skinId = (typeof Skins !== 'undefined' && row.length > 26) ? Skins.byIndex(row[26] || 0) : 'default';
    let w = a.weapon;
    if (!w || w.id !== wid) {
      if (!wid) w = I.knife;
      else if (slot === 'primary' && I.primary && I.primary.id === wid) w = I.primary;
      else if (slot === 'secondary' && I.secondary && I.secondary.id === wid) w = I.secondary;
      else if (slot === 'knife' && I.knife.id === wid) w = I.knife;
      else w = new WeaponInst(wid);
      a.weapon = w;
    }
    if (a.model && w) a.model.setWeapon(w.id, skinId);
    if (slot === 'nade') a.nadeId = wid;
    a.slot = slot;
  }

  // ---------------- 每帧：处理延迟事件，插值其他角色 ----------------
  update(dt) {
    const g = this.g; if (!g || !this.latest) return;
    const P = g.player, t = this.renderT();
    while (this.evq.length && this.evq[0].ht <= t) this.event(this.evq.shift());
    if (this.evq.length > 400) this.evq.splice(0, this.evq.length - 400);
    // 找包住渲染时刻的两帧快照
    const S = this.snaps;
    let s0 = S[0], s1 = S[S.length - 1];
    for (let i = S.length - 1; i > 0; i--) if (S[i - 1].ht <= t) { s0 = S[i - 1]; s1 = S[i]; break; }
    const k = s1 === s0 ? 1 : clamp((t - s0.ht) / Math.max(1e-6, s1.ht - s0.ht), 0, 1);
    const rows0 = new Map(s0.A.map((r) => [r[0], r]));
    for (const r1 of s1.A) {
      const a = this.byId.get(r1[0]);
      if (!a || a === P) continue;
      let r0 = rows0.get(r1[0]);
      if (!r0 || r0[24] !== r1[24]) r0 = r1;      // 中间重生过：不跨越插值
      this.applyMirror(a, r0, r1, k);
    }
    // 最新快照里的数值（计分板 / 观战 HUD 用）
    for (const r of this.latest.A) { const a = this.byId.get(r[0]); if (a && a !== P) { this.applyStats(a, r); this.syncInv(a, r); } }
    // 镜头后坐：快照 64Hz，平滑到本地帧率
    const R = this.recoil;
    if (R) {
      const f = 1 - Math.exp(-dt * 50);
      P.recoilP += (R.rp - P.recoilP) * f; P.recoilY += (R.ry - P.recoilY) * f; P.punchP += (R.pp - P.punchP) * f;
      P.punchY += (R.py - P.punchY) * f; P.aimPunchP += (R.ap - P.aimPunchP) * f; P.aimPunchY += (R.ay - P.aimPunchY) * f;
    }
    this.pingT -= dt;
    if (this.pingT <= 0) { this.pingT = 2; this.conn.send({ t: 'pi', c: performance.now() }); }
    P.ping = this.rtt;
  }
  applyMirror(a, r0, r1, k) {
    const g = this.g;
    const team = r1[1] ? 'T' : 'CT';
    if (team !== a.team) { a.team = team; g.resetModel(a, true); a.model.root.visible = !!r1[2]; }
    a.spawnSeq = r0[24];
    const alive = !!r0[2] && a.killedSq !== r0[24];
    if (alive && !a.alive) { a.alive = true; g.resetModel(a); }
    else if (!alive && a.alive) { a.alive = false; if (a.model && !a.model.ragdoll) a.model.root.visible = false; }
    a.pos.set(lerp(r0[3], r1[3], k), lerp(r0[4], r1[4], k), lerp(r0[5], r1[5], k));
    a.prevPos.copy(a.pos);
    a.vel.set(r1[6], r1[7], r1[8]);
    a.yaw = r0[9] + wrapAngle(r1[9] - r0[9]) * k;
    a.pitch = lerp(r0[10], r1[10], k);
    const fl = r1[11];
    a.ducked = !!(fl & 1); a.sliding = !!(fl & 2); a.onGround = !!(fl & 4); a.sprinting = !!(fl & 8); a.reloading = !!(fl & 16);
    a.planting = !!(fl & 32); a.defusing = !!(fl & 64); a.scoped = (fl >> 8) & 3;
    a.duckAmt = lerp(r0[12], r1[12], k); a.slideAmt = lerp(r0[13], r1[13], k);
  }

  // ---------------- 房主事件 → 本机表现 ----------------
  event(ev) {
    const g = this.g, P = g.player, A = (id) => this.byId.get(id);
    switch (ev.t) {
      case 'shot': {
        const a = A(ev.a), def = WEAPONS[ev.w];
        if (!a || !def) break;
        g.weaponFired(a, def);
        if (Array.isArray(ev.ds)) { for (const dv of ev.ds) g.fireBullet(a, vn(ev.o), vn(dv), def); }
        else g.fireBullet(a, vn(ev.o), vn(ev.d), def);
        break;
      }
      case 'snd': {
        if (ev.s != null && ev.s === this.myId) {
          if (!NET_SELF_LOCAL.test(ev.n)) Sound.play(ev.n, { vol: ev.o.pv != null ? ev.o.pv : 0.5 });
          break;
        }
        g.playAt(ev.n, vn(ev.p), ev.o);
        break;
      }
      case 'fx': if (Effects[ev.f]) Effects[ev.f](...ev.a.map(fxDec)); break;
      case 'dmg': {
        if (ev.v === this.myId) {
          g.dmgFlash = Math.min(1, g.dmgFlash + ev.d / 60 + 0.25);
          Sound.play('hurt', { vol: 0.55 });
          const k = A(ev.k);
          if (k && k !== P) HUD.damageFrom(-wrapAngle(yawOf(k.pos.x - P.pos.x, k.pos.z - P.pos.z) - P.yaw));
          if (ev.g === 'head') Sound.play(P.helmet && ev.ar ? 'hs_helmet' : 'hs_flesh', { vol: 0.4 });
        }
        if (ev.k === this.myId && ev.v !== this.myId && ev.e) {
          if (ev.g === 'head') { Sound.play(ev.ar ? 'hs_helmet' : 'hs_flesh', { vol: 0.75 }); Sound.play('hs_dink', { vol: 0.42 }); }
          else Sound.play('hit_body', { vol: 0.5 });
          HUD.hitmarker(ev.kl, ev.g === 'head');
        }
        break;
      }
      case 'kill': {
        const v = A(ev.v), k = A(ev.k);
        if (!v) break;
        HUD.killfeed({ killer: k && k !== v ? k : null, victim: v, weapon: ev.w, hs: ev.hs, wallbang: ev.wb, mine: ev.k === this.myId || ev.v === this.myId });
        if (ev.k === this.myId && ev.v !== this.myId) Sound.play('kill_confirm', { vol: 0.48 });
        v.alive = false; v.hp = 0; v.killedSq = v.spawnSeq;
        g.makeRagdoll(v, ev.dir ? vn(ev.dir) : null, ev.g, ev.hs);
        if (v === P) {
          g.playerDied(k && k !== v ? k : null, ev.w, ev.hs, ev.wb);
          if (g.mode.id === 'tdm') HUD.showDeath(document.getElementById('deathinfo').innerHTML.split('<small>')[0], '3 秒后复活');
        }
        break;
      }
      case 'drop': {
        const mdl = Models.thirdPerson(ev.c4 ? 'c4' : ev.w, (!ev.c4 && typeof Skins !== 'undefined' && ev.sk != null) ? Skins.byIndex(ev.sk) : 'default');
        g.scene.add(mdl.group);
        const d = { inst: ev.c4 ? null : new WeaponInst(ev.w), c4: !!ev.c4, mesh: mdl.group, pos: vn(ev.p), vel: vn(ev.v), ry: ev.ry, spin: ev.sp, rest: false, t: 0, owner: null, nid: ev.n };
        g.drops.push(d); this.drops.set(ev.n, d);
        break;
      }
      case 'undrop': {
        const d = this.drops.get(ev.n);
        if (d) { this.drops.delete(ev.n); g.scene.remove(d.mesh); const i = g.drops.indexOf(d); if (i >= 0) g.drops.splice(i, 1); }
        break;
      }
      case 'nade': { const a = A(ev.a); if (a) g.spawnGrenade(ev.id, vn(ev.p), vn(ev.v), a); break; }
      case 'clr': g.clearRoundFx(); this.drops.clear(); break;
      case 'c4x': g.c4Fx(vn(ev.p)); break;
      default: break;
    }
  }

  // ---------------- 每 tick：把本机输入和预测位置发给房主 ----------------
  sendInput() {
    const g = this.g, P = g.player, c = P.cmd;
    const b = (c.attack ? 1 : 0) | (c.attack2 ? 2 : 0) | (c.use ? 4 : 0) | (c.walk ? 8 : 0) | (c.duck ? 16 : 0) | (c.jump ? 32 : 0) | (c.sprint ? 64 : 0);
    const e = (c.attackPressed ? 1 : 0) | (c.attack2Pressed ? 2 : 0) | (c.usePressed ? 4 : 0) | (c.reload ? 8 : 0) | (c.jumpPressed ? 16 : 0) |
      (c.duckPressed ? 32 : 0) | (c.drop ? 64 : 0) | (c.inspect ? 128 : 0);
    const m = { t: 'in', ss: P.spawnSeq, rt: r3(this.renderT()), p: nv(P.pos), v: nv(P.vel), yw: r3(P.yaw), pt: r3(P.pitch),
      f: (P.ducked ? 1 : 0) | (P.sliding ? 2 : 0) | (P.onGround ? 4 : 0) | (P.sprinting ? 8 : 0) | (P.sprintRecover > 0 ? 16 : 0),
      da: r2(P.duckAmt), sa: r2(P.slideAmt), li: r2(P.landInacc), c: [c.fwd, c.side], b, e };
    if (c.slotReq) m.sr = c.slotReq;
    if (++this.n % 256 === 0) m.rtt = this.rtt;
    c.slotReq = null; c.drop = false; c.inspect = false;
    this.conn.send(m);
  }
  send(obj) { this.conn.send(obj); }
}

// ======================================================================
//  加入端的模式：比分 / 阶段 / 炸弹都照房主的快照
// ======================================================================
class ModeMirror {
  constructor(g, id) {
    this.g = g; this.id = id; this.title = id === 'comp' ? '爆破竞技' : '团队死斗';
    this.infiniteMoney = id !== 'comp'; this.spectateAllowed = id === 'comp';
    this.score = { CT: 0, T: 0 }; this.phase = 'live'; this.bomb = null; this.tl = null; this.cb = false; this.bt = 0;
    this.bombMesh = null;
  }
  setup() {}
  tick() {}
  onKill() {}
  canBuy(a) { return a === this.g.player && a.alive && this.cb; }
  buyTimeLeft() { return this.bt; }
  timeLeft() { return this.tl; }
  syncBomb(b) {
    if (!b) { this.bomb = null; this.clearMesh(); return; }
    const B = this.bomb || (this.bomb = { pos: new THREE.Vector3() });
    B.dropped = !!b.d; B.planted = !!b.p; B.exploded = !!b.e; B.defused = !!b.f; vn(b.x, B.pos);
    if (B.planted && !this.bombMesh) { const m = this.g.bombModel(B.pos, b.y); this.bombMesh = m.group; }
    if (B.exploded && this.bombMesh) this.bombMesh.visible = false;
  }
  clearMesh() { if (this.bombMesh) this.g.scene.remove(this.bombMesh); this.bombMesh = null; }
  dispose() { this.clearMesh(); }
}

// ======================================================================
//  云端联机大厅（Cloudflare Durable Objects · 6 位房间码 & 公开房间列表）
// ======================================================================
const CALLSIGN_KEY = 'lvtushouji:arcade-callsign:v1';
const NAME_KEY = 'sandstorm_fps_netname';
const PUBLIC_POLL_MS = 10_000;

function normalizeRoomCode(raw) {
  return String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

const Lobby = {
  conn: null, role: null, roomCode: null, players: [], publicRooms: [], publicLoading: false, publicTimer: null, lastTeams: {},
  opts: { mode: 'comp', diff: 'normal', size: 5, map: Settings.data.map || 'dust', ff: false }, inGame: false, hostIn: false, hostGame: false,
  ctx: null, busy: false,

  rememberTeams() {
    for (const p of this.players) {
      if (p && p.pid && (p.team === 'CT' || p.team === 'T')) {
        this.lastTeams[p.pid] = p.team;
      }
    }
  },
  startPublicPoll() {
    this.stopPublicPoll();
    if (this.conn || $('lobby').classList.contains('hidden') || document.hidden) return;
    this.publicTimer = setInterval(() => {
      if (!this.conn && !$('lobby').classList.contains('hidden') && !document.hidden) {
        this.refreshPublicRooms();
      }
    }, PUBLIC_POLL_MS);
  },
  stopPublicPoll() {
    if (this.publicTimer) {
      clearInterval(this.publicTimer);
      this.publicTimer = null;
    }
  },

  init() {
    let nm = '';
    try { nm = localStorage.getItem(CALLSIGN_KEY) || localStorage.getItem(NAME_KEY) || ''; } catch (e) { /* ignore */ }
    $('lbName').value = nm.trim().slice(0, 16) || '火星特勤' + Math.floor(Math.random() * 900 + 100);
    $('lbName').addEventListener('change', () => this.myName());
    $('lbCode').addEventListener('input', () => {
      const clean = normalizeRoomCode($('lbCode').value);
      if ($('lbCode').value !== clean) $('lbCode').value = clean;
    });
    $('lbCode').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.joinRoom($('lbCode').value); }
    });
    $('btnNet').addEventListener('click', () => this.open());
    $('lbBack').addEventListener('click', () => this.close());
    $('lbHost').addEventListener('click', () => this.createRoom());
    $('lbJoin').addEventListener('click', () => this.joinRoom($('lbCode').value));
    $('lbRefresh').addEventListener('click', () => this.refreshPublicRooms());
    $('lbCopyCode').addEventListener('click', () => this.copyRoomCode());
    $('lbCopyLink').addEventListener('click', () => this.copyInviteLink());
    $('lbLeave').addEventListener('click', () => this.disconnect());
    $('lbStart').addEventListener('click', () => this.hostStart());
    $('lbJoinGame').addEventListener('click', () => this.conn && this.conn.send({ t: 'join' }));
    $('lbPublicList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-join-code]');
      if (!btn) return;
      const code = normalizeRoomCode(btn.dataset.joinCode);
      if (code.length === 6) {
        $('lbCode').value = code;
        this.joinRoom(code);
      }
    });
    $('lbOpts').addEventListener('click', (e) => {
      const b = e.target.closest('b[data-k]'); if (!b || this.role !== 'host') return;
      const k = b.dataset.k, v = b.dataset.v;
      this.opts[k] = k === 'size' ? Number(v) : k === 'ff' ? v === '1' : v;
      Sound.play('ui_click'); this.broadcast(); this.render();
    });
    $('lbPlayers').addEventListener('click', (e) => {
      const b = e.target.closest('[data-team]'); if (!b) return;
      const pid = Number(b.dataset.pid), team = b.dataset.team;
      if (this.role === 'host') { const p = this.players.find((x) => x.pid === pid); if (p) { p.team = team; this.rememberTeams(); this.broadcast(); this.render(); } }
      else if (this.conn && pid === this.conn.id) this.conn.send({ t: 'team', team });
      Sound.play('ui_click');
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.stopPublicPoll();
      } else if (!this.conn && !$('lobby').classList.contains('hidden')) {
        this.refreshPublicRooms();
        this.startPublicPoll();
      }
    });
    window.addEventListener('message', (e) => {
      if (e.origin !== location.origin || !e.data || e.data.type !== 'sandstorm:sync-room') return;
      const code = normalizeRoomCode(e.data.code);
      if (code.length === 6) {
        if (this.roomCode !== code) {
          if (this.conn) this.disconnect(true);
          this.openWithRoom(code);
        }
      } else if (this.conn) {
        this.disconnect();
      }
    });
  },
  open() {
    if (!this.conn && (Engine.opts.mode === 'comp' || Engine.opts.mode === 'tdm')) {
      this.opts.mode = Engine.opts.mode;
    }
    if (!this.conn && Engine.opts.map) this.opts.map = Engine.opts.map;
    $('menu').classList.add('hidden');
    $('lobby').classList.remove('hidden');
    this.render();
    if (!this.conn) {
      this.refreshPublicRooms();
      this.startPublicPoll();
    }
  },
  openWithRoom(code) {
    const clean = normalizeRoomCode(code);
    this.open();
    if (clean.length === 6) {
      $('lbCode').value = clean;
      this.joinRoom(clean);
    }
  },
  close() { this.stopPublicPoll(); $('lobby').classList.add('hidden'); $('menu').classList.remove('hidden'); },
  status(s, err) { const el = $('lbStatus'); if (!el) return; el.textContent = s; el.classList.toggle('err', !!err); },
  notifyParentRoom(code) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'sandstorm:room', code: code || null }, location.origin);
      }
    } catch (e) { /* ignore */ }
  },
  wsUrlForCode(code) {
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProto}//${location.host}/api/arena/ws?room=${encodeURIComponent(code)}&proto=sandstorm`;
  },
  myName() {
    const el = $('lbName');
    const raw = el ? el.value : '';
    const n = String(raw || '').trim().slice(0, 16) || '火星特勤';
    try {
      localStorage.setItem(CALLSIGN_KEY, n);
      localStorage.setItem(NAME_KEY, n);
    } catch (e) { /* ignore */ }
    return n;
  },

  async refreshPublicRooms() {
    if (this.publicLoading) return;
    this.publicLoading = true;
    this.renderPublicRooms();
    try {
      const res = await fetch('/api/arena/rooms', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.publicRooms = Array.isArray(data && data.rooms) ? data.rooms : [];
    } catch (e) {
      this.publicRooms = [];
    } finally {
      this.publicLoading = false;
      this.renderPublicRooms();
    }
  },

  renderPublicRooms() {
    const box = $('lbPublicList');
    if (!box) return;
    if (this.publicLoading && !this.publicRooms.length) {
      box.innerHTML = '<div class="lbpub-empty">正在查询云端公开房间…</div>';
      return;
    }
    if (!this.publicRooms.length) {
      box.innerHTML = '<div class="lbpub-empty">当前暂无公开房间，点击上方「创建云端房间」即可开黑</div>';
      return;
    }
    box.innerHTML = this.publicRooms.map((r) => {
      const modeLabel = r.mode === 'deathmatch' ? '团队死斗' : '5v5 爆破竞技';
      const isLive = r.phase === 'live' || r.phase === 'freeze' || r.phase === 'round_over';
      const stateText = isLive ? '激战中' : '候场中';
      const full = Number(r.humanCount) >= Number(r.maxHumans);
      return `<div class="lbpub-item"><div class="lbpub-meta"><span class="lbpub-code">${esc(r.code)}</span><span class="lbpub-name">${esc(r.hostName || r.name || '沙暴房间')}</span><span class="lbpub-sub">${modeLabel} · ${Number(r.humanCount) || 0}/${Number(r.maxHumans) || 10}</span><span class="lbpub-state${isLive ? ' live' : ''}">${stateText}</span></div><button class="mini${full ? '' : ' primary'}" data-join-code="${esc(r.code)}"${full ? ' disabled' : ''}>${full ? '已满' : '加入'}</button></div>`;
    }).join('');
  },

  async createRoom() {
    if (this.conn || this.busy) return;
    this.busy = true;
    Sound.init(); Sound.play('ui_click');
    const name = this.myName();
    const isPublic = $('lbPublic') ? !!$('lbPublic').checked : true;
    const mode = this.opts.mode === 'tdm' ? 'deathmatch' : 'elimination';
    this.status('正在分配云端 6 位房间码…');
    let code = '';
    try {
      const res = await fetch('/api/arena/rooms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: (name + ' 的沙暴战局').slice(0, 28),
          hostName: name,
          mode,
          isPublic,
          maxHumans: 10,
          botCount: 4,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.code) {
        throw new Error(data.error || '创建云端房间失败');
      }
      code = normalizeRoomCode(data.code);
      if (code.length !== 6) throw new Error('服务端返回的房间码格式异常');
    } catch (e) {
      this.busy = false;
      this.status(e && e.message ? e.message : '创建云端房间失败', true);
      return;
    }

    this.status('房间 ' + code + ' 已就绪，正在建立高速联机通道…');
    const conn = new NetConn(this.wsUrlForCode(code));
    try {
      await conn.open('host', name);
    } catch (e) {
      this.busy = false;
      this.status(e && e.message ? e.message : '连接房间失败', true);
      return;
    }
    this.busy = false;
    this.conn = conn; this.role = 'host'; this.roomCode = code; this.name = name; this.hostIn = true; this.hostGame = false;
    this.stopPublicPoll();
    conn.onmsg = (from, m) => this.onMessage(from, m);
    conn.onclose = () => this.lost('与云端房间的连接已断开');
    this.players = [{ pid: conn.id, name, team: Engine.opts.team || 'CT', host: true }];
    this.rememberTeams();
    this.ctx = null;
    this.notifyParentRoom(code);
    this.broadcast();
    this.status(`云端房间 ${code} 已开启，分享房号或邀请直链给好友即可加入`);
    this.render();
  },

  async joinRoom(rawCode) {
    if (this.conn || this.busy) return;
    const code = normalizeRoomCode(rawCode);
    if (code.length !== 6) {
      this.status('请输入完整的 6 位房间码', true);
      return;
    }
    this.busy = true;
    Sound.init(); Sound.play('ui_click');
    const name = this.myName();
    this.status('正在加入云端房间 ' + code + '…');
    const conn = new NetConn(this.wsUrlForCode(code));
    try {
      const welcome = await conn.open('guest', name);
      this.hostIn = !!(welcome && welcome.host);
    } catch (e) {
      this.busy = false;
      this.status(e && e.message ? e.message : '加入房间失败，请核对 6 位房间码', true);
      return;
    }
    this.busy = false;
    this.conn = conn; this.role = 'guest'; this.roomCode = code; this.name = name; this.hostGame = false;
    this.stopPublicPoll();
    conn.onmsg = (from, m) => this.onMessage(from, m);
    conn.onclose = () => this.lost('与云端房间的连接已断开');
    this.players = [];
    this.notifyParentRoom(code);
    conn.send({ t: 'info', knife: Settings.data.knife, skins: Settings.data.skins });
    this.status(this.hostIn ? `已加入房间 ${code}，正在同步大厅状态…` : `已加入房间 ${code}，等待房主上线…`);
    this.render();
  },

  async copyRoomCode() {
    if (!this.roomCode) return;
    const ok = await copyText(this.roomCode);
    this.status(ok ? `已复制 6 位房间号：${this.roomCode}` : `房间号：${this.roomCode}`);
  },
  async copyInviteLink() {
    if (!this.roomCode) return;
    const link = `${location.origin}/arcade/arena?room=${this.roomCode}`;
    const ok = await copyText(link);
    this.status(ok ? `已复制邀请直链：${link}` : `邀请直链：${link}`);
  },

  disconnect(silent) {
    if (Engine.game && Engine.game.net) Engine.quitToMenu(true);
    if (this.conn) this.conn.close();
    this.conn = null; this.role = null; this.roomCode = null; this.players = []; this.inGame = false; this.hostIn = false; this.hostGame = false; this.ctx = null; this.lastTeams = {};
    if (!silent) this.notifyParentRoom(null);
    this.status('');
    this.render();
    if (!silent) {
      this.refreshPublicRooms();
      if (!$('lobby').classList.contains('hidden')) this.startPublicPoll();
    } else {
      this.stopPublicPoll();
    }
  },
  lost(msg) {
    const wasGame = Engine.game && Engine.game.net;
    this.conn = null; this.role = null; this.roomCode = null; this.players = []; this.inGame = false; this.hostIn = false; this.hostGame = false; this.ctx = null; this.lastTeams = {};
    this.notifyParentRoom(null);
    if (wasGame) { Engine.quitToMenu(true); this.open(); }
    this.status(msg, true); this.render();
    this.refreshPublicRooms();
    if (!$('lobby').classList.contains('hidden')) this.startPublicPoll();
  },

  onMessage(from, m) {
    if (this.role === 'host') return this.hostMsg(from, m);
    return this.guestMsg(from, m);
  },

  // ---------------- 房主 ----------------
  hostMsg(from, m) {
    if (from === 0) {
      if (m.t === 'join') {
        if (this.players.some((p) => p.pid === m.id)) return;
        const cnt = (t) => this.players.filter((p) => p.team === t).length;
        const p = { pid: m.id, name: m.name, team: cnt('T') < cnt('CT') ? 'T' : 'CT', knife: 'butterfly' };
        this.players.push(p);
        Sound.play('ui_click');
        if (this.inGame) this.addToGame(p);
        this.broadcast(); this.render();
      } else if (m.t === 'leave') {
        this.players = this.players.filter((p) => p.pid !== m.id);
        if (this.inGame && Engine.game) { Engine.game.removeRemote(m.id); HUD.center('有玩家离开了对局', '', 2); }
        this.broadcast(); this.render();
      }
      return;
    }
    const p = this.players.find((x) => x.pid === from);
    if (m.t === 'info' && p) {
      p.knife = (m.knife === 'knife' || m.knife === 'karambit' || m.knife === 'butterfly') ? m.knife : 'butterfly';
      p.skins = (m.skins && typeof m.skins === 'object') ? m.skins : {};
      if (this.inGame && Engine.game) {
        const ra = Engine.game.actors.find((x) => x.remote && x.pid === from);
        if (ra) {
          ra.skins = Object.assign({}, p.skins);
          if (ra.weapon && ra.model) ra.model.setWeapon(ra.weapon.id, ra.skinOf(ra.weapon.id));
        }
      }
      return;
    }
    if (m.t === 'team' && p && !this.inGame && (m.team === 'CT' || m.team === 'T')) { p.team = m.team; this.broadcast(); this.render(); return; }
    if (m.t === 'join' && p && this.inGame && !(Engine.game && Engine.game.actors.some((a) => a.remote && a.pid === from))) { this.addToGame(p); return; }
    if (m.t === 'bye') { if (this.inGame && Engine.game) Engine.game.removeRemote(from); return; }
    if (this.ctx) this.ctx.onMessage(from, m);
  },
  broadcast() { if (this.role === 'host' && this.conn) this.conn.sendTo('*', { t: 'lobby', players: this.players, opts: this.opts, ing: this.inGame }); },
  hostStart() {
    if (this.role !== 'host' || this.inGame) return;
    const me = this.players[0];
    const ctx = this.ctx = new NetHost(this.conn);
    const humans = this.players.slice(1).map((p) => ({ pid: p.pid, name: p.name, team: p.team, knife: p.knife, skins: p.skins }));
    this.inGame = true;
    Engine.startGame({ opts: Object.assign({}, this.opts, { team: me.team, name: me.name, humans }), ctx }).then(() => {
      for (const p of this.players.slice(1)) this.conn.sendTo(p.pid, { t: 'start', opts: this.opts, team: p.team });
      ctx.sendRoster();
      this.broadcast();
    });
  },
  addToGame(p) {
    const g = Engine.game; if (!g || !this.ctx) return;
    g.addRemote({ pid: p.pid, name: p.name, team: p.team, knife: p.knife, skins: p.skins });
    this.conn.sendTo(p.pid, { t: 'start', opts: this.opts, team: p.team });
    this.ctx.rosterDirty = true;
  },
  // 对局结束 / 房主退出：通知所有人回大厅
  gameEnded() {
    if (this.role === 'host' && this.inGame) { this.inGame = false; this.ctx = null; this.conn && this.conn.sendTo('*', { t: 'end' }); this.broadcast(); this.open(); }
    else if (this.role === 'guest' && this.inGame) { this.inGame = false; this.ctx = null; this.conn && this.conn.send({ t: 'bye' }); this.open(); }
    this.render();
  },

  // ---------------- 加入者 ----------------
  guestMsg(from, m) {
    if (from === 0) {
      if (m.t === 'hostleft') {
        this.rememberTeams();
        this.hostIn = false; this.hostGame = false; this.players = [];
        if (this.inGame) { this.inGame = false; this.ctx = null; Engine.quitToMenu(true); this.open(); }
        this.status('原房主已离开，正在移交房间控制权…', true); this.render();
      } else if (m.t === 'promoted') {
        this.rememberTeams();
        this.role = 'host';
        if (this.conn) {
          this.conn.role = 'host';
          this.conn.archiveToken = typeof m.archiveToken === 'string' ? m.archiveToken : '';
        }
        this.hostIn = true;
        this.hostGame = false;
        this.inGame = false;
        this.ctx = null;
        const myPid = this.conn ? this.conn.id : m.id;
        const myTeam = this.lastTeams[myPid] || Engine.opts.team || 'CT';
        const nextPlayers = [{
          pid: myPid,
          name: this.name || this.myName(),
          team: myTeam,
          host: true,
          knife: (Settings.data.knife === 'knife' || Settings.data.knife === 'karambit' || Settings.data.knife === 'butterfly') ? Settings.data.knife : 'butterfly',
          skins: Settings.data.skins || {},
        }];
        const peers = Array.isArray(m.peers) ? m.peers : [];
        for (const peer of peers) {
          if (!peer || peer.id === myPid) continue;
          const cntT = nextPlayers.filter((x) => x.team === 'T').length;
          const cntCT = nextPlayers.filter((x) => x.team === 'CT').length;
          const team = this.lastTeams[peer.id] || (cntT < cntCT ? 'T' : 'CT');
          nextPlayers.push({ pid: peer.id, name: peer.name || '玩家', team, knife: 'butterfly' });
        }
        this.players = nextPlayers;
        this.rememberTeams();
        $('menu').classList.add('hidden');
        $('lobby').classList.remove('hidden');
        this.stopPublicPoll();
        Sound.play('ui_click');
        this.broadcast();
        this.render();
        this.status(
          m.wasLive
            ? '原房主在对局中断开，你已自动接任新房主，可直接点击「开始对局」重开'
            : '原房主已离开，你已自动接任新房主',
        );
      } else if (m.t === 'hostup') {
        this.hostIn = true;
        this.status(m.name ? `房主已自动移交给 ${m.name}，正在同步大厅状态…` : '房主已上线，等待同步大厅状态…');
        this.render();
      }
      return;
    }
    if (m.t === 'lobby') {
      this.hostIn = true; this.players = m.players; this.rememberTeams(); this.opts = m.opts; this.hostGame = !!m.ing;
      if (!this.inGame) this.status(m.ing ? '房主正在对局中，可点击下方直接中途加入' : '已在候场桌面，等待房主点击「开始对局」');
      this.render(); return;
    }
    if (m.t === 'start') {
      this.opts = Object.assign({}, this.opts, m.opts || {});
      const ctx = this.ctx = new NetClient(this.conn);
      this.inGame = true;
      Engine.startGame({ opts: Object.assign({}, m.opts, { team: m.team, name: this.name }), ctx });
      return;
    }
    if (m.t === 'end') { if (this.inGame) { this.inGame = false; this.ctx = null; Engine.quitToMenu(true); this.open(); this.status('对局结束，已回到房间候场'); } return; }
    if (this.ctx) this.ctx.onMessage(from, m);
  },

  // ---------------- 界面 ----------------
  render() {
    const on = !!this.conn, host = this.role === 'host';
    $('lbConnect').classList.toggle('hidden', on);
    $('lbRoom').classList.toggle('hidden', !on);
    $('lbStart').classList.toggle('hidden', !host);
    $('lbJoinGame').classList.toggle('hidden', !(on && !host && this.hostGame && !this.inGame));
    if (!on) { this.renderPublicRooms(); return; }
    if ($('lbRoomCode')) $('lbRoomCode').textContent = this.roomCode || '------';
    const O = this.opts;
    if (!O.map) O.map = 'dust';
    const seg = (k, list) => `<div class="opt"><label>${{ mode: '模式', map: '战术地图', diff: '机器人难度', size: '每队人数（空位补 AI）', ff: '友军伤害' }[k]}</label><div class="seg${host ? '' : ' ro'}">${list.map(([v, l]) => `<b data-k="${k}" data-v="${v}" class="${String(O[k] === true ? '1' : O[k] === false ? '0' : O[k]) === String(v) ? 'on' : ''}">${l}</b>`).join('')}</div></div>`;
    $('lbOpts').innerHTML = seg('mode', [['comp', '5v5 爆破竞技'], ['tdm', '团队死斗']]) +
      seg('map', MapGen.MAPS.map((mp) => [mp.id, mp.name])) +
      seg('diff', [['easy', '新兵'], ['normal', '老兵'], ['hard', '精英'], ['cosmic', '宇宙级']]) +
      seg('size', [[1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5']]) + seg('ff', [[0, '关'], [1, '开']]);
    const myPid = this.conn.id;
    const col = (team) => this.players.filter((p) => p.team === team).map((p) =>
      `<div class="lp${p.pid === myPid ? ' me' : ''}">${p.host ? '<i>房主</i>' : ''}${esc(p.name)}${(host || p.pid === myPid) ? `<span class="sw" data-pid="${p.pid}" data-team="${team === 'CT' ? 'T' : 'CT'}">换到 ${team === 'CT' ? 'T' : 'CT'}</span>` : ''}</div>`).join('') || '<div class="lp empty">（空位由 AI 补齐）</div>';
    $('lbPlayers').innerHTML = `<div class="lt ct"><h4>反恐精英 CT</h4>${col('CT')}</div><div class="lt t"><h4>恐怖分子 T</h4>${col('T')}</div>`;
    $('lbRole').textContent = host
      ? `你是房主（共 ${this.players.length} 名真人在线）· 分享上方 6 位房号或邀请直链给好友即可实时联机`
      : this.hostIn
        ? `已加入云端房间 ${this.roomCode || ''} · 对局设置由房主调整，可自由切换 CT / T 阵营`
        : '已连接房间，等待房主上线…';
  },
};
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
