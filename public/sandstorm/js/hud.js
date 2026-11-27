'use strict';
// ======================================================================
//  hud.js —— 战术射击 HUD：准星、雷达、血量护甲、弹药/开火模式/StatTrak、
//             3D 战术标点、击杀信息、交火复盘、军备竞赛阶位条、靶场 2.0、
//             计分板、购买菜单（增量防抖）、网络图
// ======================================================================
const _hv = new THREE.Vector3(), _hd = new THREE.Vector3(), _he = new THREE.Vector3();
const _hp1 = new THREE.Vector3(), _hp2 = new THREE.Vector3();

const HUD = (() => {
  const E = {};
  let crossKey = '', radarT = 0, game = null;
  const cache = {};
  const feed = [];
  let buyOpen = false, buyCat = -1, buySig = '';
  let spraySig = '';
  let centerT = 0, hitT = 0;

  function esc(s) {
    if (typeof escHtml === 'function') return escHtml(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function sanitizeDeathHtml(s) {
    return String(s == null ? '' : s)
      .split(/(<span class="c(?:CT|T)">|<\/span>)/g)
      .map((part, i) => (i % 2 === 1 ? part : part.replace(/</g, '&lt;').replace(/>/g, '&gt;')))
      .join('');
  }
  function statTrakOf(id) {
    return (typeof StatTrak !== 'undefined' && StatTrak.get && id) ? (StatTrak.get(id) || 0) : 0;
  }

  function setText(id, v) { if (E[id] && cache[id] !== v) { cache[id] = v; E[id].textContent = v; } }
  function setHTML(id, v) { if (E[id] && cache['h' + id] !== v) { cache['h' + id] = v; E[id].innerHTML = v; } }
  function show(id, on) { const k = 's' + id; if (E[id] && cache[k] !== on) { cache[k] = on; E[id].classList.toggle('hidden', !on); } }

  const api = {
    init() {
      for (const id of ['hud', 'crosshair', 'scope', 'hitmarker', 'dmgdir', 'radar', 'radarLabel', 'money', 'buyhint', 'aliveCT', 'aliveT', 'scoreCT', 'scoreT',
        'timer', 'bombIcon', 'arBar', 'killfeed', 'rangePanel', 'sprayCanvas', 'rpAcc', 'rpChallenge', 'rpBadges', 'center', 'subcenter',
        'hpbox', 'hp', 'armor', 'hpbar', 'armorbar', 'armorIco', 'weaponbar', 'fireMode', 'wname', 'mag', 'reserve',
        'progress', 'progressLabel', 'progressBar', 'netgraph', 'dmgSummary', 'deathinfo', 'spectate', 'scoreboard', 'buymenu', 'vcursor', 'tags']) E[id] = $(id);
      E.tctx = E.tags.getContext('2d');
      E.rctx = E.radar.getContext('2d');
      E.cctx = E.crosshair.getContext('2d');
      E.sctx = E.sprayCanvas ? E.sprayCanvas.getContext('2d') : null;
      E.buymenu.addEventListener('click', (e) => {
        if (!buyOpen || !game || Input.locked) return;
        const qb = e.target && e.target.closest && e.target.closest('[data-qbuy]');
        if (qb) {
          if (qb.dataset.qbuy === 'f1') game.quickBuy(game.player, true);
          else if (qb.dataset.qbuy === 'f2') game.rebuyLast(game.player, true);
          return;
        }
        const it = e.target && e.target.closest && e.target.closest('[data-buy]');
        if (it) game.buy(game.player, it.dataset.buy, true);
      });
    },
    bind(g) {
      game = g;
      feed.length = 0;
      E.killfeed.innerHTML = '';
      for (const k in cache) delete cache[k];
      crossKey = '';
      buySig = '';
      spraySig = '';
      if (E.hud) E.hud.classList.remove('mode-range');
      show('arBar', false);
      show('dmgSummary', false);
      show('rangePanel', false);
      show('fireMode', false);
      api.closeBuy();
    },
    get buyOpen() { return buyOpen; },

    drawCrosshair(extra, hide, offX = 0, offY = 0) {
      const S = Settings.data;
      const key = [S.crossSize, S.crossGap, S.crossThick, S.crossColor, S.crossDot, S.crossOutline, Math.round(extra * 2), hide].join('|');
      const ox = Math.round(offX), oy = Math.round(offY);
      if (cache.cxOff !== ox || cache.cyOff !== oy) {
        cache.cxOff = ox; cache.cyOff = oy;
        E.crosshair.style.transform = `translate(calc(-50% + ${ox}px), calc(-50% + ${oy}px))`;
      }
      if (key === crossKey) return;
      crossKey = key;
      const c = E.crosshair, g = E.cctx, dpr = Math.min(2, devicePixelRatio || 1);
      const size = S.crossSize, th = S.crossThick, gap = Math.max(0, S.crossGap + extra);
      const R = Math.ceil(gap + size + 4);
      c.width = c.height = Math.ceil(R * 2 * dpr);
      c.style.width = c.style.height = R * 2 + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, R * 2, R * 2);
      if (hide) return;
      const cx = R, cy = R, h = th / 2;
      const rects = [];
      if (size > 0) {
        rects.push([cx - h, cy - gap - size, th, size], [cx - h, cy + gap, th, size], [cx - gap - size, cy - h, size, th], [cx + gap, cy - h, size, th]);
      }
      if (S.crossDot) rects.push([cx - h, cy - h, th, th]);
      if (S.crossOutline) { g.fillStyle = 'rgba(0,0,0,0.85)'; for (const r of rects) g.fillRect(r[0] - 1, r[1] - 1, r[2] + 2, r[3] + 2); }
      g.fillStyle = S.crossColor;
      for (const r of rects) g.fillRect(r[0], r[1], r[2], r[3]);
    },

    hitmarker(kill, hs) {
      if (!Settings.data.hitmarker) return;
      E.hitmarker.classList.toggle('kill', !!kill);
      E.hitmarker.classList.toggle('hs', !kill && !!hs);
      E.hitmarker.style.opacity = 1; hitT = kill ? 0.36 : hs ? 0.24 : 0.16;
    },
    damageFrom(angleRad) {
      const d = document.createElement('div'); d.className = 'arc';
      d.style.transform = `rotate(${angleRad}rad)`;
      E.dmgdir.appendChild(d);
      setTimeout(() => { d.style.opacity = 0; }, 700);
      setTimeout(() => d.remove(), 1000);
    },
    center(text, cls = '', dur = 3, sub = '') {
      E.center.className = cls; E.center.textContent = text; E.center.style.opacity = 1;
      E.subcenter.textContent = sub; E.subcenter.style.opacity = 1;
      centerT = dur;
    },
    killfeed(o) {
      const el = document.createElement('div');
      el.className = 'kf' + (o.mine ? ' mine' : '');
      const nm = (a) => a ? `<span class="c${esc(a.team)}">${esc(a.name)}</span>` : '';
      el.innerHTML = `${o.killer ? nm(o.killer) : ''}<span class="w">${esc(o.weapon)}</span>${o.wallbang ? '<span class="wb">穿</span>' : ''}${o.hs ? '<span class="hs">爆头</span>' : ''}${nm(o.victim)}`;
      E.killfeed.prepend(el);
      feed.push({ el, t: o.mine ? 9 : 6 });
      while (E.killfeed.children.length > 6) E.killfeed.lastChild.remove();
    },
    moneyFlash() { E.money.classList.remove('flash'); void E.money.offsetWidth; E.money.classList.add('flash'); },

    // 敌我标识 + 3D 战术标点投影
    drawTags(g) {
      const c = E.tags, ctx = E.tctx, dpr = Math.min(2, devicePixelRatio || 1);
      const W = innerWidth, H = innerHeight;
      if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const P = g.player, view = g.viewTarget || P, cam = g.camera;
      if (!P.alive && !g.spectating) return;
      const team = view.team, col = team === 'CT' ? '#6cb4ff' : '#ffbf4d';
      const v = _hv, eye = cam.position;
      ctx.textAlign = 'center'; ctx.font = '600 12px "Inter", "Noto Sans SC", system-ui, sans-serif';
      for (const a of g.actors) {
        if (!a.alive || a === view || a.team !== team) continue;
        g.aimPoint(a, 'head', v); v.y += 0.32;
        const d = v.distanceTo(eye);
        v.project(cam);
        if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) continue;
        const x = (v.x * 0.5 + 0.5) * W, y = (-v.y * 0.5 + 0.5) * H;
        const al = clamp(1.25 - d / 45, 0.45, 1);
        ctx.globalAlpha = al;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath(); ctx.moveTo(x - 7, y - 9); ctx.lineTo(x + 7, y - 9); ctx.lineTo(x, y + 1); ctx.closePath(); ctx.fill();
        ctx.fillStyle = col;
        ctx.beginPath(); ctx.moveTo(x - 5.5, y - 8); ctx.lineTo(x + 5.5, y - 8); ctx.lineTo(x, y - 0.5); ctx.closePath(); ctx.fill();
        if (d < 30) { ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillText(a.name, x + 1, y - 12); ctx.fillStyle = col; ctx.fillText(a.name, x, y - 13); }
      }
      ctx.globalAlpha = 1;

      // 3D 战术标点（同队可见，屏幕边缘柔顺贴边 + 尾段 0.8s 淡出）
      if (Array.isArray(g.pings) && g.pings.length) {
        const camFwd = _hp1.set(0, 0, -1).applyQuaternion(cam.quaternion);
        for (const p of g.pings) {
          if (!p || !p.pos || p.team !== team) continue;
          const ttl = p.ttl || 5.5, age = p.t || 0, rem = ttl - age;
          if (rem <= 0) continue;
          const fade = rem < 0.8 ? clamp(rem / 0.8, 0, 1) : 1;
          const px = p.pos.x, py = p.pos.y + 0.25, pz = p.pos.z;
          const toP = _hp2.set(px - eye.x, py - eye.y, pz - eye.z);
          const dist = toP.length();
          const behind = toP.dot(camFwd) < 0;
          v.set(px, py, pz).project(cam);
          let sx = (v.x * 0.5 + 0.5) * W;
          let sy = (-v.y * 0.5 + 0.5) * H;
          if (behind) {
            sx = W - sx; sy = H - sy;
            const dx = sx - W * 0.5, dy = sy - H * 0.5, len = Math.hypot(dx, dy) || 1;
            sx = W * 0.5 + (dx / len) * Math.max(W, H);
            sy = H * 0.5 + (dy / len) * Math.max(W, H);
          }
          const pad = 44;
          const off = behind || sx < pad || sx > W - pad || sy < pad || sy > H - pad;
          sx = clamp(sx, pad, W - pad);
          sy = clamp(sy, pad, H - pad);

          const isDanger = !!p.danger;
          const mainCol = isDanger ? '#ff473e' : '#ffb83d';
          const pop = age < 0.18 ? 1 + (1 - age / 0.18) * 0.45 : 1;
          const sz = (off ? 8 : 9.5) * pop;
          ctx.save();
          ctx.globalAlpha = fade * (off ? 0.8 : 1);

          // 扩散脉冲菱环
          const pulse = (age * (isDanger ? 2.2 : 1.4)) % 1;
          const pr = sz + pulse * (isDanger ? 16 : 11);
          ctx.strokeStyle = mainCol;
          ctx.globalAlpha = fade * (1 - pulse) * (isDanger ? 0.85 : 0.55);
          ctx.lineWidth = isDanger ? 2 : 1.5;
          ctx.beginPath();
          ctx.moveTo(sx, sy - pr); ctx.lineTo(sx + pr, sy); ctx.lineTo(sx, sy + pr); ctx.lineTo(sx - pr, sy); ctx.closePath();
          ctx.stroke();

          // 主体菱形图标
          ctx.globalAlpha = fade * (off ? 0.82 : 1);
          ctx.fillStyle = 'rgba(10,12,16,0.82)';
          ctx.beginPath();
          ctx.moveTo(sx, sy - sz - 2); ctx.lineTo(sx + sz + 2, sy); ctx.lineTo(sx, sy + sz + 2); ctx.lineTo(sx - sz - 2, sy); ctx.closePath();
          ctx.fill();
          ctx.fillStyle = mainCol;
          ctx.beginPath();
          ctx.moveTo(sx, sy - sz); ctx.lineTo(sx + sz, sy); ctx.lineTo(sx, sy + sz); ctx.lineTo(sx - sz, sy); ctx.closePath();
          ctx.fill();
          if (isDanger) {
            ctx.fillStyle = '#fff';
            ctx.font = '700 11px "JetBrains Mono", ui-monospace, monospace';
            ctx.fillText('!', sx, sy + 4);
          } else {
            ctx.fillStyle = '#1a1206';
            ctx.beginPath(); ctx.arc(sx, sy, 2.3, 0, Math.PI * 2); ctx.fill();
          }

          // 标签与距离
          const distStr = `${Math.round(dist)}m`;
          const lbl = p.label ? `${p.label} · ${distStr}` : distStr;
          ctx.font = '600 11.5px "Inter", "Noto Sans SC", system-ui, sans-serif';
          const tw = ctx.measureText(lbl).width + 12;
          const ly = sy - sz - 12;
          ctx.fillStyle = 'rgba(10,12,16,0.72)';
          ctx.fillRect(sx - tw * 0.5, ly - 11, tw, 16);
          ctx.fillStyle = isDanger ? '#ffd0cc' : '#fff0cc';
          ctx.fillText(lbl, sx, ly + 1);
          ctx.restore();
        }
      }
      ctx.globalAlpha = 1;

      // 准星下的敌人
      if (P.alive) {
        const f = dirFromAngles(P.yaw, P.pitch, _hd), e = P.eyePos(_he);
        const wh = g.world.raycast(e.x, e.y, e.z, f.x, f.y, f.z, 80, {});
        const ah = g.rayActors(e.x, e.y, e.z, f, wh ? wh.t : 80, new Set([P]));
        if (ah && ah.actor.team !== P.team && !Effects.smokeBlocks(e, _hv.copy(e).addScaledVector(f, ah.t))) {
          ctx.font = '700 13px "Inter", "Noto Sans SC", system-ui, sans-serif';
          ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillText('敌人  ' + ah.actor.name, W / 2 + 1, H / 2 + 41);
          ctx.fillStyle = '#ff5a4a'; ctx.fillText('敌人  ' + ah.actor.name, W / 2, H / 2 + 40);
        }
      }
    },

    update(dt, g) {
      const P = g.player, view = g.viewTarget || P, md = g.mode;
      if (E.hud) E.hud.classList.toggle('mode-range', md.id === 'range');
      api.drawTags(g);
      // 计时
      if (centerT > 0) { centerT -= dt; if (centerT <= 0) { E.center.style.opacity = 0; E.subcenter.style.opacity = 0; } }
      if (hitT > 0) { hitT -= dt; if (hitT <= 0) E.hitmarker.style.opacity = 0; }
      for (let i = feed.length - 1; i >= 0; i--) { feed[i].t -= dt; if (feed[i].t <= 0) { feed[i].el.style.opacity = 0; const el = feed[i].el; setTimeout(() => el.remove(), 600); feed.splice(i, 1); } }

      // 血量护甲
      const a = view;
      setText('hp', String(Math.max(0, Math.ceil(a.hp))));
      setText('armor', String(Math.ceil(a.armor)));
      E.hpbar.style.width = clamp(a.hp, 0, 100) + '%';
      E.armorbar.style.width = clamp(a.armor, 0, 100) + '%';
      setText('armorIco', a.helmet ? '头甲' : 'AP');
      E.hpbox.classList.toggle('low', a.hp <= 25);

      // 武器（附带已装备皮肤名 + StatTrak 击杀计数 + 开火模式徽标）
      const w = a.weapon, def = w ? w.def : null;
      let wHtml = def ? esc(def.name) : '';
      if (def && a.skinOf && typeof Skins !== 'undefined') {
        const sk = Skins.BY_ID[a.skinOf(def.id)];
        if (sk && sk.id !== 'default') wHtml += ' · ' + esc(sk.name);
      }
      if (def && a.isPlayer) {
        const st = statTrakOf(def.id);
        if (st > 0) wHtml += ` <span class="st-tag">★ ${st}</span>`;
      }
      setHTML('wname', wHtml);
      const hasBurst = !!(def && def.burstMode && w);
      show('fireMode', hasBurst);
      if (hasBurst) {
        const isBurst = !!w.burst;
        setText('fireMode', isBurst ? '三连发' : (def.auto ? '全自动' : '单发'));
        E.fireMode.classList.toggle('burst', isBurst);
      }
      if (def && def.mag) {
        setText('mag', String(w.mag)); setText('reserve', '/ ' + (g.infiniteAmmo ? '∞' : w.reserve));
        E.mag.classList.toggle('low', w.mag <= Math.ceil(def.mag * 0.2));
      } else if (def && def.type === 'grenade') {
        setText('mag', String((a.inv.nades && a.inv.nades[def.id]) || 0)); setText('reserve', ''); E.mag.classList.remove('low');
      } else { setText('mag', '—'); setText('reserve', ''); E.mag.classList.remove('low'); }

      // 武器栏
      const I = a.inv; const rows = [];
      const ws = (k, n, on) => `<div class="ws${on ? ' on' : ''}"><b>${k}</b>${esc(n)}</div>`;
      if (I.primary) rows.push(ws(1, I.primary.def.name, a.slot === 'primary'));
      if (I.secondary) rows.push(ws(2, I.secondary.def.name, a.slot === 'secondary'));
      rows.push(ws(3, I.knife.def.name, a.slot === 'knife'));
      const nd = GRENADE_ORDER.filter((k) => I.nades && I.nades[k] > 0 && WEAPONS[k]).map((k) => WEAPONS[k].short + (I.nades[k] > 1 ? '×' + I.nades[k] : '')).join(' ');
      if (nd) rows.push(ws(4, nd, a.slot === 'nade'));
      if (I.c4) rows.push(ws(5, 'C4', a.slot === 'c4'));
      if (I.defuser) rows.push(`<div class="ws"><b>[钳]</b>拆弹器</div>`);
      setHTML('weaponbar', rows.join(''));

      // 金钱/购买
      setText('money', md.infiniteMoney ? '$ ∞' : '$' + P.money);
      show('buyhint', !!(md.canBuy && md.canBuy(P)) && !buyOpen);

      // 顶栏
      const tl = md.timeLeft != null ? md.timeLeft() : null;
      setText('timer', tl == null ? '--:--' : fmtTime(tl));
      E.timer.classList.toggle('low', tl != null && tl <= 10 && md.phase === 'live');
      setText('scoreCT', String(md.score ? md.score.CT : 0)); setText('scoreT', String(md.score ? md.score.T : 0));
      const alive = (t) => g.actors.filter((x) => x.team === t).map((x) => `<i class="${x.alive ? '' : 'dead'}"></i>`).join('');
      setHTML('aliveCT', alive('CT')); setHTML('aliveT', alive('T'));
      show('bombIcon', !!(md.bomb && md.bomb.planted && !md.bomb.exploded && !md.bomb.defused));

      // 军备竞赛阶位进度条
      api.updateArmsRace(g, a);

      // 准星（可选 CS2 风格弹道跟随；支持第一人称观战显示）
      const S = Settings.data;
      let extra = 0, offX = 0, offY = 0;
      if (S.crossStyle === 'dynamic' && a.alive) {
        const inacc = a.inaccuracy() / 1000;
        const px = Math.tan(inacc) / Math.tan(g.camera.fov * 0.5 * DEG) * innerHeight * 0.5;
        extra = Math.min(60, px * 0.6);
      }
      if (S.crossFollow && a.alive && !a.scoped && def && def.pattern && a.recoilIdx > 0.05) {
        const vf = 0.55;
        const pyPerDeg = (innerHeight * 0.5) / Math.tan(g.camera.fov * 0.5 * DEG) * DEG;
        offX = clamp(a.recoilY * vf * pyPerDeg, -140, 140);
        offY = clamp(-a.recoilP * vf * pyPerDeg, -140, 140);
      }
      const inFirstPerson = !g.spectating || g.specFirstPerson;
      const hideX = !a.alive || (def && def.scope) || !inFirstPerson;
      api.drawCrosshair(extra, hideX, offX, offY);
      show('scope', !!(a.alive && a.scoped && def && def.scope && inFirstPerson));

      // 进度条（安放/拆除）
      let prog = null;
      if (a.planting) prog = ['正在安放炸弹…', a.plantT / 3.2];
      else if (a.defusing) prog = [a.inv.defuser ? '正在拆除炸弹（拆弹器）…' : '正在拆除炸弹…', a.defuseT / (a.inv.defuser ? 5 : 10)];
      show('progress', !!prog);
      if (prog) { setText('progressLabel', prog[0]); E.progressBar.style.width = clamp(prog[1] * 100, 0, 100) + '%'; }

      // 网络图
      if (S.showFps) {
        const sp = Math.round(a.hspeed() / U);
        let s = `${g.fps.toFixed(0)} fps   ${sp} u/s`;
        if (g.client) s += g.net.rtt != null ? `   延迟 ${g.net.rtt}ms` : '   连接中…';
        if (g.opts && g.opts.lowGrav) s += '   0.48g';
        if (md.id === 'range') s += `\n散布 ${a.inaccuracy().toFixed(1)} mrad\n后坐序号 ${a.recoilIdx.toFixed(1)}\n${a.sliding ? '滑铲中' : a.sprinting ? '冲刺' : a.ducked ? '下蹲' : a.onGround ? '' : '空中'}`;
        setText('netgraph', s);
      } else setText('netgraph', '');

      // 交火复盘卡片 & 靶场 2.0 面板
      api.updateCombatSummary(g);
      api.updateRangePanel(g);

      // 雷达
      radarT -= dt;
      if (radarT <= 0) { radarT = 1 / 30; api.drawRadar(g, a); }
      api.updateBuy(g);
    },

    updateArmsRace(g, a) {
      const md = g.mode;
      const on = md.id === 'armsrace';
      show('arBar', on);
      if (!on) return;
      const ladder = (md.ladder && md.ladder.length) ? md.ladder : (typeof ARMS_RACE_LADDER !== 'undefined' ? ARMS_RACE_LADDER : []);
      const total = ladder.length || 12;
      const kpl = md.killsPerLevel || 2;
      const lvl = clamp(a.arLevel || 0, 0, total - 1);
      const isFinal = lvl === total - 1;
      const curId = ladder[lvl];
      const nextId = !isFinal ? ladder[lvl + 1] : null;
      const curName = isFinal ? '黄金爪子刀' : ((WEAPONS[curId] && WEAPONS[curId].name) || curId || '');
      const nextName = nextId ? ((WEAPONS[nextId] && WEAPONS[nextId].name) || nextId) : '';
      const prog = clamp(a.arProgress || 0, 0, kpl);
      let pips = '';
      for (let i = 0; i < kpl; i++) pips += `<i class="${i < prog ? 'on' : ''}"></i>`;
      let lead = typeof md.leader === 'function' ? md.leader() : null;
      if (!lead && g.actors && g.actors.length) {
        const top = g.actors.slice().sort((x, y) => ((y.arLevel || 0) - (x.arLevel || 0)) || ((y.arProgress || 0) - (x.arProgress || 0)) || (y.kills - x.kills))[0];
        if (top) lead = { name: top.name, team: top.team, level: top.arLevel || 0, total };
      }
      const leadHtml = lead
        ? `<span class="ar-lead">领跑：<b class="c${esc(lead.team)}">${esc(lead.name)}</b> ${Math.min(total, (lead.level || 0) + 1)}/${lead.total || total}</span>`
        : '';
      const nextHtml = isFinal
        ? '<span class="ar-next">近战击杀终结比赛</span>'
        : `<span class="ar-next">下阶：${esc(nextName)}</span>`;
      setHTML('arBar', `<span class="ar-tier">第 ${lvl + 1}/${total} 阶</span><span class="ar-wep${isFinal ? ' gold' : ''}">${esc(curName)}</span><span class="ar-pips">${pips}</span>${nextHtml}${leadHtml}`);
    },

    updateCombatSummary(g) {
      const P = g.player, md = g.mode;
      const want = (!P.alive || md.phase === 'post') && typeof g.getCombatSummary === 'function';
      if (!want) { show('dmgSummary', false); return; }
      const cs = g.getCombatSummary();
      const given = (cs && Array.isArray(cs.given)) ? cs.given.slice(0, 4) : [];
      const taken = (cs && Array.isArray(cs.taken)) ? cs.taken.slice(0, 4) : [];
      if (!given.length && !taken.length) { show('dmgSummary', false); return; }
      const cols = [];
      if (given.length) {
        const rows = given.map((r) => `<div class="ds-row"><span>对 <b class="c${esc(r.team)}">${esc(r.name)}</b>${r.dead ? '<i class="ds-ko">击杀</i>' : ''}</span><span class="ds-num given">${Math.round(r.dmg || 0)} (${r.hits || 0} 命中)</span></div>`).join('');
        cols.push(`<div class="ds-col"><h5>造成伤害</h5>${rows}</div>`);
      }
      if (taken.length) {
        const rows = taken.map((r) => `<div class="ds-row"><span>承受 <b class="c${esc(r.team)}">${esc(r.name)}</b></span><span class="ds-num taken">${Math.round(r.dmg || 0)} (${r.hits || 0} 命中)</span></div>`).join('');
        cols.push(`<div class="ds-col"><h5>承受伤害</h5>${rows}</div>`);
      }
      setHTML('dmgSummary', `<div class="ds-title">本回合交火复盘</div><div class="ds-grid">${cols.join('')}</div>`);
      show('dmgSummary', true);
    },

    updateRangePanel(g) {
      const md = g.mode;
      const on = md.id === 'range';
      show('rangePanel', on);
      if (!on) return;
      const hits = Array.isArray(md.sprayHits) ? md.sprayHits : [];
      const acc = md.sprayAcc != null ? Math.round(md.sprayAcc) : 100;
      setText('rpAcc', hits.length ? `精准度 ${acc}%` : '精准度 --');

      // 仅在弹道点变化时重绘 140x140 弹道画布
      const last = hits.length ? hits[hits.length - 1] : null;
      const lastKey = last ? `${last.dx != null ? last.dx : (last.dxDeg || 0)},${last.dy != null ? last.dy : (last.dyDeg || 0)},${last.hit ? 1 : 0}` : '';
      const sSig = `${hits.length}|${lastKey}`;
      if (sSig !== spraySig && E.sctx) {
        spraySig = sSig;
        api.drawSprayCanvas(hits);
      }

      // 30s 极速反应挑战状态
      const ch = md.challenge || null;
      const best = (Settings.data && Settings.data.rangeBest) || { kills: 0, hsRate: 0, avgMs: 0 };
      let chHtml = '';
      if (ch && ch.active) {
        const tl = Math.max(0, ch.timeLeft != null ? ch.timeLeft : 0).toFixed(1);
        const hsRate = ch.kills > 0 ? Math.round((ch.headshots || 0) / ch.kills * 100) : 0;
        const avgMs = ch.reactCount > 0 ? Math.round((ch.reactSum / ch.reactCount) * 1000) + 'ms' : '--';
        chHtml = `<div class="rp-live">30s 挑战 · ${tl}s</div><div>击杀 <b>${ch.kills || 0}</b> · 爆头 ${hsRate}% · 反应 ${avgMs}</div>`;
      } else if (ch && ch.lastResult) {
        const lr = ch.lastResult;
        const lrHs = lr.hsRate != null ? Math.round(lr.hsRate) : 0;
        const lrMs = lr.avgMs != null && lr.avgMs > 0 ? Math.round(lr.avgMs) + 'ms' : '--';
        chHtml = `<div>上次：<b>${lr.kills || 0}</b> 杀 · 爆头 ${lrHs}% · ${lrMs}</div>`;
      } else {
        chHtml = '<div>按 <b>T</b> 开始 30s 极速反应挑战</div>';
      }
      if (best.kills > 0) {
        const bMs = best.avgMs > 0 ? `${Math.round(best.avgMs)}ms` : '--';
        chHtml += `<div class="rp-pb">最佳：${best.kills} 杀 · 爆头 ${Math.round(best.hsRate || 0)}% · ${bMs}</div>`;
      }
      setHTML('rpChallenge', chHtml);

      const staticOn = !!md.staticDummies;
      const impactsOn = md.showImpacts !== false;
      setHTML('rpBadges', `<span class="rp-badge${staticOn ? ' on' : ''}">J 靶标：${staticOn ? '静止' : '移动'}</span><span class="rp-badge${impactsOn ? ' on' : ''}">K 弹着：${impactsOn ? '开' : '关'}</span>`);
    },

    drawSprayCanvas(hits) {
      const ctx = E.sctx;
      const W = 140, H = 140, cx = 70, cy = 84, scale = 7.2;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = 'rgba(7,9,13,0.92)';
      ctx.fillRect(0, 0, W, H);
      // 准心参考圆环与十字轴线
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.lineWidth = 1;
      for (const r of [18, 38, 58]) {
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(W, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, H); ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);

      if (!hits.length) return;
      const pts = hits.map((h) => {
        const dx = h.dx != null ? h.dx : (h.dxDeg != null ? h.dxDeg : (h.x != null ? h.x : (Array.isArray(h) ? h[0] : 0)));
        const dy = h.dy != null ? h.dy : (h.dyDeg != null ? h.dyDeg : (h.y != null ? h.y : (Array.isArray(h) ? h[1] : 0)));
        return {
          x: clamp(cx + dx * scale, 6, W - 6),
          y: clamp(cy - dy * scale, 6, H - 6),
          hit: !!(h.hit || (Array.isArray(h) && h[2])),
          hs: !!(h.hs || (Array.isArray(h) && h[3])),
        };
      });
      // 弹道连线
      if (pts.length > 1) {
        ctx.strokeStyle = 'rgba(255,255,255,0.22)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
        ctx.stroke();
      }
      // 逐发着色圆点（首枪绿 → 中段黄 → 尾段橙红）
      const n = Math.max(1, pts.length - 1);
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], t = i / n;
        const hue = lerp(132, 6, t);
        ctx.fillStyle = `hsl(${hue.toFixed(0)}, 92%, 58%)`;
        ctx.beginPath(); ctx.arc(p.x, p.y, i === pts.length - 1 ? 3.8 : 2.8, 0, Math.PI * 2); ctx.fill();
        if (p.hs) {
          ctx.strokeStyle = '#6cf4ff'; ctx.lineWidth = 1.4;
          ctx.beginPath(); ctx.arc(p.x, p.y, 4.8, 0, Math.PI * 2); ctx.stroke();
        } else if (p.hit) {
          ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(p.x, p.y, 3.8, 0, Math.PI * 2); ctx.stroke();
        }
      }
    },

    drawRadar(g, a) {
      const c = E.rctx, W = 400, map = g.map;
      const ppm = 200 / 34, k = ppm / map.radarScale;
      const yaw = a.yaw, px = a.renderPos.x, pz = a.renderPos.z;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, W, W);
      c.save(); c.translate(200, 200); c.rotate(yaw); c.scale(k, k);
      c.globalAlpha = 0.92;
      c.drawImage(map.radar, -(px - map.origin) * map.radarScale, -(pz - map.origin) * map.radarScale);
      c.restore();
      const cs = Math.cos(yaw), sn = Math.sin(yaw);
      const toS = (x, z) => { const rx = x - px, rz = z - pz; return [200 + (rx * cs - rz * sn) * ppm, 200 + (rx * sn + rz * cs) * ppm]; };
      const dot = (x, z, col, r, ring) => {
        let [sx, sy] = toS(x, z);
        const dx = sx - 200, dy = sy - 200, d = Math.hypot(dx, dy);
        if (d > 192) { sx = 200 + dx / d * 192; sy = 200 + dy / d * 192; r *= 0.75; }
        c.beginPath(); c.arc(sx, sy, r, 0, 7); c.fillStyle = col; c.fill();
        if (ring) { c.lineWidth = 2; c.strokeStyle = 'rgba(0,0,0,0.7)'; c.stroke(); }
      };
      const md = g.mode;
      if (md.bomb && (md.bomb.dropped || md.bomb.planted) && (g.player.team === 'T' || md.bomb.planted)) {
        const b = md.bomb.pos; const [sx, sy] = toS(b.x, b.z);
        c.fillStyle = md.bomb.planted ? '#ff3b30' : '#ffb43a'; c.fillRect(sx - 7, sy - 5, 14, 10);
        c.fillStyle = '#000'; c.font = '700 9px "JetBrains Mono", ui-monospace, monospace'; c.textAlign = 'center'; c.fillText('C4', sx, sy + 3.5);
      }
      for (const o of g.actors) {
        if (o === a || !o.alive) continue;
        if (o.team === g.player.team) dot(o.renderPos.x, o.renderPos.z, o.team === 'CT' ? '#8ab8ff' : '#ffc94d', 7, true);
        else if (g.time - (o.spottedT || -9) < 0.6) dot(o.renderPos.x, o.renderPos.z, '#ff4a3d', 7, true);
      }
      // 战术标点雷达菱形闪烁
      if (Array.isArray(g.pings) && g.pings.length) {
        for (const p of g.pings) {
          if (!p || !p.pos || p.team !== a.team) continue;
          const ttl = p.ttl || 5.5, age = p.t || 0, rem = ttl - age;
          if (rem <= 0) continue;
          const fade = rem < 0.8 ? clamp(rem / 0.8, 0, 1) : 1;
          let [sx, sy] = toS(p.pos.x, p.pos.z);
          const dx = sx - 200, dy = sy - 200, d = Math.hypot(dx, dy);
          if (d > 188) { sx = 200 + dx / d * 188; sy = 200 + dy / d * 188; }
          const pcol = p.danger ? '#ff473e' : '#ffb83d';
          const pulse = (age * 2.2) % 1;
          c.save();
          c.globalAlpha = fade * (1 - pulse) * 0.9;
          c.strokeStyle = pcol;
          c.lineWidth = 2.5;
          const pr = 9 + pulse * 14;
          c.beginPath(); c.moveTo(sx, sy - pr); c.lineTo(sx + pr, sy); c.lineTo(sx, sy + pr); c.lineTo(sx - pr, sy); c.closePath(); c.stroke();
          c.globalAlpha = fade * (0.65 + 0.35 * Math.sin(age * 10));
          c.fillStyle = pcol;
          c.beginPath(); c.moveTo(sx, sy - 8); c.lineTo(sx + 8, sy); c.lineTo(sx, sy + 8); c.lineTo(sx - 8, sy); c.closePath(); c.fill();
          c.lineWidth = 1.6; c.strokeStyle = 'rgba(0,0,0,0.8)'; c.stroke();
          c.restore();
        }
      }
      // 自身箭头
      c.beginPath(); c.moveTo(200, 189); c.lineTo(208, 208); c.lineTo(200, 203); c.lineTo(192, 208); c.closePath();
      c.fillStyle = '#ffffff'; c.fill(); c.lineWidth = 1.5; c.strokeStyle = '#000'; c.stroke();
      const area = api.areaName(g, a.pos);
      setText('radarLabel', area);
    },
    areaName(g, p) {
      const list = g.map && g.map.callouts;
      if (Array.isArray(list)) {
        for (const c of list) {
          if (p.x >= c.x0 && p.x <= c.x1 && p.z >= c.z0 && p.z <= c.z1) return c.name;
        }
      }
      return '中路';
    },

    showDeath(text, sub) {
      if (text && typeof text === 'object') {
        const dh = text;
        const main = dh.killerName
          ? `被 <span class="c${esc(dh.killerTeam || '')}">${esc(dh.killerName)}</span> 使用 ${esc(dh.weapon || '')} 击杀${dh.hs ? '（爆头）' : ''}${dh.wall ? '（穿墙）' : ''}`
          : '你阵亡了';
        const parts = [];
        if (dh.killerName && dh.remainingHp != null) parts.push(`对方剩余生命 ${Math.max(0, Math.ceil(dh.remainingHp))}`);
        if (dh.respawnNote) parts.push(dh.respawnNote);
        const subText = sub != null ? String(sub) : parts.join(' · ');
        setHTML('deathinfo', main + (subText ? `<small>${esc(subText)}</small>` : ''));
        show('deathinfo', true);
        return;
      }
      const safeMain = sanitizeDeathHtml(text);
      const safeSub = sub ? `<small>${esc(sub)}</small>` : '';
      setHTML('deathinfo', safeMain + safeSub);
      show('deathinfo', true);
    },
    hideDeath() { show('deathinfo', false); },
    spectate(text) {
      if (!text) { show('spectate', false); return; }
      if (game && game.spectating && game.viewTarget && game.viewTarget.alive) {
        const pov = game.specFirstPerson ? '第一人称' : '第三人称';
        setText('spectate', `观战：${game.viewTarget.name} [${pov}] · V / 空格切换视角 · 左/右键切队友`);
        show('spectate', true);
        return;
      }
      setText('spectate', text);
      show('spectate', true);
    },

    scoreboard(on, g) {
      show('scoreboard', on);
      if (!on) return;
      const md = g.mode, P = g.player;
      const isAR = md.id === 'armsrace';
      const ladderLen = (md.ladder && md.ladder.length) || (typeof ARMS_RACE_LADDER !== 'undefined' ? ARMS_RACE_LADDER.length : 12);
      const row = (a) => {
        const arCol = isAR ? `<td class="n">${Math.min(ladderLen, (a.arLevel || 0) + 1)}/${ladderLen}</td>` : '';
        const dmg = Math.round(a.damageDealt || 0);
        const hs = a.headshots || 0;
        return `<tr class="${a === P ? 'me' : ''} ${a.alive ? '' : 'dead'}"><td><span class="c${esc(a.team)}">${esc(a.name)}</span>${a.inv.c4 && a.team === P.team ? ' <span class="tag-c4">[C4]</span>' : ''}${a.inv.defuser && a.team === P.team ? ' <span class="tag-kit">[钳]</span>' : ''}</td>${arCol}<td class="n">${a.kills}</td><td class="n">${a.assists}</td><td class="n">${a.deaths}</td><td class="n">${dmg}</td><td class="n">${hs}</td><td class="n">${a.mvp > 0 ? a.mvp : '—'}</td><td class="n">${a.team === P.team && !md.infiniteMoney ? '$' + a.money : ''}</td><td class="n">${a.isBot ? 'BOT' : a.ping != null ? a.ping + 'ms' : g.net ? (a === P ? '你' : '玩家') : '本机'}</td></tr>`;
      };
      const tbl = (t) => {
        const list = g.actors.filter((x) => x.team === t).sort((x, y) => (isAR ? ((y.arLevel || 0) - (x.arLevel || 0)) || ((y.arProgress || 0) - (x.arProgress || 0)) : 0) || (y.kills - x.kills) || (x.deaths - y.deaths));
        return `<h3><span class="c${t}">${t === 'CT' ? '反恐精英' : '恐怖分子'}</span><span class="c${t}">${md.score ? md.score[t] : ''}</span></h3><table><tr><th>玩家</th>${isAR ? '<th class="n">阶位</th>' : ''}<th class="n">击杀</th><th class="n">助攻</th><th class="n">死亡</th><th class="n">伤害</th><th class="n">爆头</th><th class="n">MVP</th><th class="n">金钱</th><th class="n">延迟</th></tr>${list.map(row).join('')}</table>`;
      };
      const mapName = (g.map && g.map.name) || '炽沙小镇';
      const gravTag = (g.opts && g.opts.lowGrav) ? ' · 火星低重力 0.48g' : '';
      setHTML('scoreboard', `<div style="text-align:center;color:#a9a49a;font-size:13px;letter-spacing:2px;margin-bottom:6px">${esc(md.title)} · ${esc(mapName)}${gravTag} · 机器人难度：${esc(DIFFS[g.opts.diff].label)}</div>` + tbl('CT') + tbl('T'));
    },

    // ---------------- 购买菜单（签名缓存防 60fps DOM 重建） ----------------
    openBuy(g) {
      buyOpen = true; buyCat = -1; buySig = '';
      show('buymenu', true); show('vcursor', Input.locked);
      Input.cursorX = innerWidth / 2; Input.cursorY = innerHeight / 2;
      api.renderBuy(g);
    },
    closeBuy() { buyOpen = false; buySig = ''; show('buymenu', false); show('vcursor', false); },
    renderBuy(g) {
      const P = g.player, md = g.mode;
      const hasLast = !!(g.lastPurchases && g.lastPurchases.length);
      const mapId = (g.map && g.map.id) || '';
      const states = [];
      const sigParts = [md.id, md.infiniteMoney ? 'inf' : P.money, buyCat, mapId, hasLast ? 1 : 0];
      for (let ci = 0; ci < BUY_MENU.length; ci++) {
        const items = BUY_MENU[ci].items;
        const colStates = [];
        for (let ii = 0; ii < items.length; ii++) {
          const id = items[ii];
          const st = g.buyState(P, id);
          const skId = (WEAPONS[id] && typeof Skins !== 'undefined') ? Skins.forWeapon(id) : '';
          const stK = WEAPONS[id] ? statTrakOf(id) : 0;
          colStates.push({ id, st, skId, stK });
          sigParts.push(`${st.ok ? 1 : 0}${st.own ? 1 : 0}${skId}:${stK}`);
        }
        states.push(colStates);
      }
      const sig = sigParts.join('|');
      const timerText = md.buyTimeLeft ? ' · 剩余购买时间 ' + Math.max(0, Math.ceil(md.buyTimeLeft())) + ' 秒' : '';

      if (sig === buySig) {
        const tm = $('bmTimer');
        if (tm && tm.textContent !== timerText) tm.textContent = timerText;
        return;
      }
      buySig = sig;

      const cols = BUY_MENU.map((cat, ci) => {
        const items = states[ci].map(({ id, st, skId, stK }, ii) => {
          const it = WEAPONS[id] || EQUIP[id];
          let sdot = '';
          if (skId && typeof Skins !== 'undefined') {
            const sk = Skins.BY_ID[skId];
            if (sk && sk.id !== 'default') sdot = `<i class="sdot" style="background:${sk.swatch}" title="${esc(sk.name)}"></i>`;
          }
          const stBadge = stK > 0 ? `<span class="st-mini">★${stK}</span>` : '';
          return `<div class="it ${st.ok ? '' : 'no'} ${st.own ? 'own' : ''} ${buyCat === ci ? 'hot' : ''}" data-buy="${esc(id)}"><div class="nm">${esc(it.name)}${sdot}${stBadge}</div><div class="pr">${md.infiniteMoney ? '免费' : '$' + it.price}</div><div class="k">${ci + 1}-${ii + 1}</div></div>`;
        }).join('');
        return `<div class="col"><h4>${ci + 1}. ${esc(cat.title)}</h4>${items}</div>`;
      }).join('');

      setHTML('buymenu', `<div class="bm"><div class="bmh"><div class="t">购买菜单 · ${esc((g.map && g.map.name) || '')}</div><div class="m">${md.infiniteMoney ? '$ ∞' : '$' + P.money}</div></div><div class="cols">${cols}</div><div class="bmquick"><div class="bmquick-btns"><button type="button" class="qbtn" data-qbuy="f1">F1 一键全甲步枪</button><button type="button" class="qbtn" data-qbuy="f2">F2 重复上局购买</button></div><div class="foot">数字键选择分类+物品 · B / Esc 关闭<span id="bmTimer">${esc(timerText)}</span></div></div></div>`);
    },
    updateBuy(g) {
      if (!buyOpen) return;
      show('vcursor', Input.locked);
      if (Input.locked) E.vcursor.style.transform = `translate(${Input.cursorX}px, ${Input.cursorY}px)`;
      if (!(g.mode.canBuy && g.mode.canBuy(g.player)) || !g.player.alive) { api.closeBuy(); return; }
      api.renderBuy(g);
    },
    buyClick(g) {
      const el = document.elementFromPoint(Input.cursorX, Input.cursorY);
      const qb = el && el.closest && el.closest('[data-qbuy]');
      if (qb) {
        if (qb.dataset.qbuy === 'f1') g.quickBuy(g.player, true);
        else if (qb.dataset.qbuy === 'f2') g.rebuyLast(g.player, true);
        return;
      }
      const it = el && el.closest && el.closest('[data-buy]');
      if (it) g.buy(g.player, it.dataset.buy, true);
    },
    buyKey(g, n) {
      if (buyCat < 0) { if (n >= 1 && n <= BUY_MENU.length) { buyCat = n - 1; Sound.play('ui_click'); api.renderBuy(g); } return; }
      const id = BUY_MENU[buyCat].items[n - 1];
      if (id) g.buy(g.player, id, true);
      buyCat = -1;
      api.renderBuy(g);
    },
  };
  return api;
})();
