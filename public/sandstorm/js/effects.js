'use strict';
// ======================================================================
//  effects.js —— 粒子（实例化公告板）、弹孔/血迹贴花、曳光、弹壳、
//                 枪口焰、动态光、爆炸、烟雾弹体积
// ======================================================================
class ParticleSys {
  constructor(scene, max, additive, tex, softNear) {
    this.max = max; this.n = 0; this.additive = additive;
    const base = new THREE.PlaneGeometry(1, 1);
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index; g.setAttribute('position', base.attributes.position); g.setAttribute('uv', base.attributes.uv);
    this.aPos = new Float32Array(max * 3); this.aCol = new Float32Array(max * 4); this.aSR = new Float32Array(max * 3);
    this.bPos = new THREE.InstancedBufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.bCol = new THREE.InstancedBufferAttribute(this.aCol, 4).setUsage(THREE.DynamicDrawUsage);
    this.bSR = new THREE.InstancedBufferAttribute(this.aSR, 3).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.bPos); g.setAttribute('iCol', this.bCol); g.setAttribute('iSR', this.bSR);
    g.instanceCount = 0;
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: tex }, fogColor: { value: new THREE.Color(0xd8c8b0) }, fogDensity: { value: 0.004 }, softNear: { value: softNear ? 1 : 0 } },
      vertexShader: `
        attribute vec3 iPos; attribute vec4 iCol; attribute vec3 iSR;
        uniform float fogDensity; uniform float softNear;
        varying vec2 vUv; varying vec4 vCol; varying float vFog;
        void main(){
          vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
          float c = cos(iSR.y), s = sin(iSR.y);
          vec2 p = position.xy * iSR.x;
          mv.xy += vec2(c*p.x - s*p.y, s*p.x + c*p.y);
          gl_Position = projectionMatrix * mv;
          float cx = mod(iSR.z, 2.0), cy = floor(iSR.z / 2.0);
          vUv = uv * 0.5 + vec2(cx * 0.5, (1.0 - cy) * 0.5);
          vCol = iCol;
          float d = -mv.z;
          vFog = 1.0 - exp(-fogDensity * fogDensity * d * d);
          if (softNear > 0.5) vCol.a *= smoothstep(0.25, 1.8, d);
        }`,
      fragmentShader: `
        uniform sampler2D map; uniform vec3 fogColor;
        varying vec2 vUv; varying vec4 vCol; varying float vFog;
        void main(){
          vec4 t = texture2D(map, vUv);
          float a = t.a * vCol.a;
          if (a < 0.004) discard;
          vec3 col = vCol.rgb * t.rgb;
          ${additive ? 'gl_FragColor = vec4(col * a * (1.0 - vFog), 1.0);' : 'gl_FragColor = vec4(mix(col, fogColor, vFog), a);'}
        }`,
      transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    if (additive) { this.mat.blending = THREE.CustomBlending; this.mat.blendSrc = THREE.OneFactor; this.mat.blendDst = THREE.OneFactor; }
    this.mesh = new THREE.Mesh(g, this.mat); this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 11 : 10;
    scene.add(this.mesh);
    // 粒子状态（SoA）
    const F = (k) => new Float32Array(max * k);
    this.p = F(3); this.v = F(3); this.life = F(1); this.maxLife = F(1); this.s0 = F(1); this.s1 = F(1);
    this.rot = F(1); this.rv = F(1); this.a0 = F(1); this.col = F(3); this.drag = F(1); this.grav = F(1); this.atlas = F(1); this.fin = F(1);
  }
  spawn(x, y, z, vx, vy, vz, o) {
    let i;
    if (this.n < this.max) i = this.n++;
    else i = (Math.random() * this.max) | 0;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.life[i] = 0; this.maxLife[i] = o.life || 1;
    this.s0[i] = o.s0 == null ? 0.2 : o.s0; this.s1[i] = o.s1 == null ? this.s0[i] : o.s1;
    this.rot[i] = o.rot == null ? Math.random() * 6.28 : o.rot; this.rv[i] = o.rv || 0;
    this.a0[i] = o.a == null ? 1 : o.a;
    const c = o.c || [1, 1, 1]; this.col[i * 3] = c[0]; this.col[i * 3 + 1] = c[1]; this.col[i * 3 + 2] = c[2];
    this.drag[i] = o.drag || 0; this.grav[i] = o.grav || 0; this.atlas[i] = o.atlas || 0; this.fin[i] = o.fin || 0;
  }
  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        n--;
        if (i !== n) this.copy(n, i);
        i--; continue;
      }
      const k = i * 3;
      const dr = Math.exp(-this.drag[i] * dt);
      this.v[k] *= dr; this.v[k + 1] = this.v[k + 1] * dr - this.grav[i] * dt; this.v[k + 2] *= dr;
      this.p[k] += this.v[k] * dt; this.p[k + 1] += this.v[k + 1] * dt; this.p[k + 2] += this.v[k + 2] * dt;
      this.rot[i] += this.rv[i] * dt;
    }
    this.n = n;
    for (let i = 0; i < n; i++) {
      const t = this.life[i] / this.maxLife[i];
      const k = i * 3, k4 = i * 4;
      this.aPos[k] = this.p[k]; this.aPos[k + 1] = this.p[k + 1]; this.aPos[k + 2] = this.p[k + 2];
      const fade = this.fin[i] > 0 ? Math.min(1, t / this.fin[i]) * (1 - smoothstep(0.78, 1, t)) : (1 - t) * (1 - t * 0.3);
      this.aCol[k4] = this.col[k]; this.aCol[k4 + 1] = this.col[k + 1]; this.aCol[k4 + 2] = this.col[k + 2]; this.aCol[k4 + 3] = this.a0[i] * fade;
      this.aSR[k] = this.s0[i] + (this.s1[i] - this.s0[i]) * Math.sqrt(t); this.aSR[k + 1] = this.rot[i]; this.aSR[k + 2] = this.atlas[i];
    }
    this.geo.instanceCount = n;
    this.bPos.needsUpdate = true; this.bCol.needsUpdate = true; this.bSR.needsUpdate = true;
  }
  copy(a, b) {
    for (const arr of [this.p, this.v, this.col]) { arr[b * 3] = arr[a * 3]; arr[b * 3 + 1] = arr[a * 3 + 1]; arr[b * 3 + 2] = arr[a * 3 + 2]; }
    for (const arr of [this.life, this.maxLife, this.s0, this.s1, this.rot, this.rv, this.a0, this.drag, this.grav, this.atlas, this.fin]) arr[b] = arr[a];
  }
  clear() { this.n = 0; this.geo.instanceCount = 0; }
}

class DecalSet {
  constructor(scene, tex, max, opts = {}) {
    this.max = max; this.count = 0; this.i = 0;
    const mat = new THREE.MeshStandardMaterial(Object.assign({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, roughness: 0.9, metalness: 0 }, opts));
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, max);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 2;
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(max * 3).fill(1), 3);
    scene.add(this.mesh);
    this.m4 = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.q2 = new THREE.Quaternion(); this.s = new THREE.Vector3(); this.p = new THREE.Vector3(); this.n = new THREE.Vector3();
    this.col = new THREE.Color();
  }
  add(pos, normal, size, color, rot) {
    this.n.copy(normal);
    this.q.setFromUnitVectors(_v1.set(0, 0, 1), this.n);
    this.q2.setFromAxisAngle(_v1.set(0, 0, 1), rot == null ? Math.random() * 6.28 : rot);
    this.q.multiply(this.q2);
    this.p.copy(pos).addScaledVector(this.n, 0.004);
    this.s.set(size, size, size);
    this.m4.compose(this.p, this.q, this.s);
    const i = this.i % this.max;
    this.mesh.setMatrixAt(i, this.m4);
    this.col.setRGB(color[0], color[1], color[2]);
    this.mesh.setColorAt(i, this.col);
    this.i++; this.count = Math.min(this.max, this.count + 1);
    this.mesh.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true; this.mesh.instanceColor.needsUpdate = true;
  }
  clear() { this.count = 0; this.i = 0; this.mesh.count = 0; }
}

const Effects = (() => {
  let scene, curWorld, P, PA, smokeSys, holes, blood, scorch;
  let weatherKind = 'dust';
  const tracers = [], shells = [], flashes = [], lights = [];
  let shellMesh = null; const SHELL_MAX = 96;
  let fireLight = null;
  let impactMesh = null, impactIdx = 0, impactCount = 0; const IMPACT_MAX = 80;
  const smokes = [], fires = [];
  const tmpHit = {};
  const DUST = {
    stone: [0.62, 0.55, 0.46],
    sand: [0.6, 0.5, 0.36],
    mars: [0.74, 0.34, 0.20],
    snow: [0.88, 0.94, 1.0],
    ice: [0.72, 0.88, 1.0],
    wood: [0.42, 0.32, 0.22],
    metal: [0.35, 0.34, 0.33],
  };
  const HOLE_TINT = {
    stone: [1, 1, 1],
    sand: [0.9, 0.85, 0.8],
    mars: [0.86, 0.56, 0.44],
    snow: [0.82, 0.9, 1.0],
    ice: [0.72, 0.88, 1.0],
    wood: [0.8, 0.65, 0.5],
    metal: [0.6, 0.62, 0.66],
  };

  const api = {
    smokes,
    fires,
    init(sc, w) {
      scene = sc; curWorld = w;
      const S = Tex.sprites;
      P = new ParticleSys(scene, 3000, false, S.atlas, false);
      PA = new ParticleSys(scene, 1500, true, S.atlas, false);
      smokeSys = new ParticleSys(scene, 600, false, S.atlas, true);
      smokeSys.mesh.renderOrder = 12;
      holes = new DecalSet(scene, S.hole, 320);
      blood = new DecalSet(scene, S.blood, 80, { roughness: 0.35 });
      scorch = new DecalSet(scene, S.scorch, 24);
      // 曳光
      for (let i = 0; i < 40; i++) {
        const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: S.tracer, color: new THREE.Color(7, 5, 2.6), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
        m.visible = false; m.frustumCulled = false; m.matrixAutoUpdate = false; m.renderOrder = 13;
        scene.add(m);
        tracers.push({ mesh: m, start: new THREE.Vector3(), dir: new THREE.Vector3(), len: 0, head: 0, active: false, speed: 380 });
      }
      // 弹壳
      const sg = new THREE.CylinderGeometry(0.0055, 0.0055, 0.039, 8); sg.rotateZ(Math.PI / 2);
      shellMesh = new THREE.InstancedMesh(sg, new THREE.MeshStandardMaterial({ color: 0xd8aa52, roughness: 0.28, metalness: 1 }), SHELL_MAX);
      shellMesh.count = 0; shellMesh.frustumCulled = false; shellMesh.castShadow = false;
      scene.add(shellMesh);
      // 第三人称枪口焰
      for (let i = 0; i < 10; i++) {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: S.flash, color: new THREE.Color(6, 4.5, 2.5), blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
        sp.visible = false; scene.add(sp); flashes.push({ sp, t: 0 });
      }
      // 动态点光源池（常驻，避免着色器重编译）
      for (let i = 0; i < 2; i++) {
        const l = new THREE.PointLight(0xffb45a, 0, 9, 2); l.position.set(0, -100, 0);
        scene.add(l); lights.push({ l, t: 0, dur: 0.05, peak: 0 });
      }
      // 燃烧弹常驻火光
      fireLight = new THREE.PointLight(0xff6b1c, 0, 14, 2);
      fireLight.position.set(0, -100, 0);
      scene.add(fireLight);
      // 靶场 2.0 3D 弹着标记池
      const imat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.82, depthWrite: false });
      impactMesh = new THREE.InstancedMesh(new THREE.BoxGeometry(0.085, 0.085, 0.085), imat, IMPACT_MAX);
      impactMesh.count = 0; impactMesh.frustumCulled = false; impactMesh.renderOrder = 9;
      impactMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(IMPACT_MAX * 3).fill(1), 3);
      scene.add(impactMesh);
    },

    setWorld(w) { curWorld = w; },
    setWeather(kind) { weatherKind = kind || 'dust'; },

    light(pos, intensity, dur, color = 0xffb45a, dist = 9) {
      let best = lights[0];
      for (const L of lights) if (L.t >= L.dur) { best = L; break; } else if (L.t / L.dur > best.t / best.dur) best = L;
      best.l.position.copy(pos); best.l.color.set(color); best.l.distance = dist; best.peak = intensity; best.t = 0; best.dur = dur;
      best.l.intensity = intensity;
    },

    impact(point, normal, matKey, dir, noDecal) {
      const fx = (MATS[matKey] || MATS.stone).fx;
      const nx = normal.x, ny = normal.y, nz = normal.z;
      const dust = DUST[fx] || DUST.stone;
      const amb = 1.0;
      const isDusty = fx === 'sand' || fx === 'mars';
      // 碎屑
      const nChips = fx === 'metal' ? 2 : isDusty ? 7 : 6;
      for (let i = 0; i < nChips; i++) {
        const s = 2 + Math.random() * 4;
        P.spawn(point.x + nx * 0.02, point.y + ny * 0.02, point.z + nz * 0.02,
          (nx + rand(-0.7, 0.7)) * s, (ny + rand(-0.2, 1.0)) * s, (nz + rand(-0.7, 0.7)) * s,
          { life: rand(0.4, 0.8), s0: rand(0.012, 0.03), atlas: 3, c: [dust[0] * 0.8, dust[1] * 0.8, dust[2] * 0.8], grav: 9.8, drag: 0.5, rv: rand(-12, 12) });
      }
      // 尘雾
      const puffs = fx === 'metal' ? 1 : isDusty ? 4 : 3;
      for (let i = 0; i < puffs; i++) {
        const s = rand(0.4, 1.3);
        P.spawn(point.x + nx * 0.05, point.y + ny * 0.05, point.z + nz * 0.05, nx * s + rand(-0.2, 0.2), ny * s + rand(0, 0.4), nz * s + rand(-0.2, 0.2),
          { life: rand(0.7, 1.4), s0: 0.08, s1: rand(0.45, 0.8), atlas: 1, a: isDusty ? 0.55 : 0.42, c: [dust[0] * amb, dust[1] * amb, dust[2] * amb], drag: 2.2, grav: -0.15, rv: rand(-0.6, 0.6) });
      }
      if (fx === 'metal' || (fx === 'stone' && Math.random() < 0.35)) {
        const n = fx === 'metal' ? 9 : 3;
        for (let i = 0; i < n; i++) {
          const s = rand(3, 9);
          PA.spawn(point.x, point.y, point.z, (nx + rand(-0.8, 0.8)) * s, (ny + rand(-0.3, 0.9)) * s, (nz + rand(-0.8, 0.8)) * s,
            { life: rand(0.12, 0.35), s0: rand(0.018, 0.035), s1: 0.006, atlas: 2, c: [9, 5.5, 2.2], grav: 9.8, drag: 1.0 });
        }
        PA.spawn(point.x + nx * 0.03, point.y + ny * 0.03, point.z + nz * 0.03, 0, 0, 0, { life: 0.06, s0: 0.12, s1: 0.18, atlas: 2, c: [6, 4, 2] });
      }
      if (fx === 'wood') {
        for (let i = 0; i < 4; i++) {
          const s = rand(2, 5);
          P.spawn(point.x, point.y, point.z, (nx + rand(-0.6, 0.6)) * s, (ny + rand(0, 1)) * s, (nz + rand(-0.6, 0.6)) * s,
            { life: rand(0.5, 1.0), s0: rand(0.02, 0.045), atlas: 3, c: [0.55, 0.4, 0.24], grav: 9.8, drag: 0.4, rv: rand(-20, 20) });
        }
      }
      if (!noDecal) holes.add(point, normal, fx === 'metal' ? rand(0.05, 0.065) : rand(0.06, 0.09), HOLE_TINT[fx] || HOLE_TINT.stone);
    },

    blood(point, dir, big) {
      const n = big ? 14 : 7;
      for (let i = 0; i < n; i++) {
        const s = rand(1, 4.5);
        P.spawn(point.x, point.y, point.z, (dir.x + rand(-0.5, 0.5)) * s, (dir.y + rand(-0.3, 0.6)) * s, (dir.z + rand(-0.5, 0.5)) * s,
          { life: rand(0.3, 0.7), s0: rand(0.015, 0.035), atlas: 0, c: [0.35, 0.02, 0.015], a: 0.95, grav: 9.8, drag: 0.6 });
      }
      for (let i = 0; i < (big ? 4 : 2); i++) {
        P.spawn(point.x, point.y, point.z, dir.x * 0.8 + rand(-0.3, 0.3), dir.y * 0.8 + rand(-0.1, 0.3), dir.z * 0.8 + rand(-0.3, 0.3),
          { life: rand(0.35, 0.6), s0: 0.06, s1: big ? 0.5 : 0.32, atlas: 1, c: [0.32, 0.03, 0.02], a: 0.75, drag: 3 });
      }
      // 墙上溅血
      const h = curWorld.raycast(point.x, point.y, point.z, dir.x, dir.y - 0.15, dir.z, 2.6, tmpHit, true);
      if (h && !h.box.noDecal) {
        const p = _v2.set(point.x + dir.x * h.t, point.y + (dir.y - 0.15) * h.t, point.z + dir.z * h.t);
        blood.add(p, _v3.set(h.nx, h.ny, h.nz), rand(0.35, big ? 0.9 : 0.6), [1, 1, 1]);
      }
    },
    bloodPool(pos) {
      blood.add(_v2.set(pos.x, pos.y + 0.01, pos.z), _v3.set(0, 1, 0), rand(0.8, 1.3), [0.8, 0.8, 0.8]);
    },

    tracer(from, to, speed = 380) {
      let t = tracers.find((x) => !x.active) || tracers[(Math.random() * tracers.length) | 0];
      t.start.copy(from); t.dir.subVectors(to, from); t.len = t.dir.length();
      if (t.len < 1) return;
      t.dir.multiplyScalar(1 / t.len); t.head = 0; t.active = true; t.speed = speed;
      t.mesh.visible = true;
    },

    shell(pos, vel, big) {
      if (shells.length >= SHELL_MAX) shells.shift();
      shells.push({ p: pos.clone(), v: vel.clone(), r: new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)), w: new THREE.Vector3(rand(-25, 25), rand(-25, 25), rand(-25, 25)), life: 0, bounces: 0, rest: false, big: !!big });
    },

    muzzle(pos, scale = 1) {
      const f = flashes.find((x) => !x.sp.visible) || flashes[0];
      f.sp.position.copy(pos); f.sp.scale.setScalar(0.45 * scale * rand(0.8, 1.2)); f.sp.material.rotation = Math.random() * 6.28;
      f.sp.visible = true; f.t = 0;
    },

    slideDust(pos, vel) {
      const col = weatherKind === 'snow' ? DUST.snow : weatherKind === 'mars' ? DUST.mars : DUST.sand;
      for (let i = 0; i < 2; i++) {
        P.spawn(pos.x + rand(-0.2, 0.2), pos.y + 0.05, pos.z + rand(-0.2, 0.2), vel.x * 0.25 + rand(-0.3, 0.3), rand(0.2, 0.6), vel.z * 0.25 + rand(-0.3, 0.3),
          { life: rand(0.6, 1.1), s0: 0.15, s1: rand(0.6, 0.9), atlas: 1, a: 0.32, c: col, drag: 2.0, grav: -0.1 });
      }
    },
    landDust(pos, k) {
      const col = weatherKind === 'snow' ? DUST.snow : weatherKind === 'mars' ? DUST.mars : DUST.sand;
      for (let i = 0; i < 6; i++) {
        const a = i / 6 * 6.28;
        P.spawn(pos.x, pos.y + 0.05, pos.z, Math.cos(a) * 1.2 * k, 0.2, Math.sin(a) * 1.2 * k, { life: 0.7, s0: 0.12, s1: 0.5, atlas: 1, a: 0.25 * k, c: col, drag: 3 });
      }
    },

    explosion(pos) {
      for (let i = 0; i < 26; i++) {
        const d = _v1.set(rand(-1, 1), rand(0.1, 1.2), rand(-1, 1)).normalize(); const s = rand(2, 9);
        PA.spawn(pos.x, pos.y + 0.2, pos.z, d.x * s, d.y * s, d.z * s, { life: rand(0.25, 0.6), s0: rand(0.5, 0.9), s1: rand(1.4, 2.4), atlas: 1, c: [9, 4.2, 1.2], drag: 4, rv: rand(-2, 2) });
      }
      for (let i = 0; i < 22; i++) {
        const d = _v1.set(rand(-1, 1), rand(0.2, 1.4), rand(-1, 1)).normalize(); const s = rand(1, 5);
        P.spawn(pos.x, pos.y + 0.3, pos.z, d.x * s, d.y * s, d.z * s, { life: rand(1.8, 3.2), s0: rand(0.8, 1.2), s1: rand(2.6, 4.2), atlas: 1, a: 0.6, c: [0.16, 0.15, 0.14], drag: 2.2, grav: -0.35, rv: rand(-0.5, 0.5) });
      }
      for (let i = 0; i < 26; i++) {
        const d = _v1.set(rand(-1, 1), rand(0.3, 1.5), rand(-1, 1)).normalize(); const s = rand(5, 14);
        P.spawn(pos.x, pos.y + 0.2, pos.z, d.x * s, d.y * s, d.z * s, { life: rand(0.8, 1.6), s0: rand(0.03, 0.08), atlas: 3, c: [0.3, 0.26, 0.2], grav: 9.8, drag: 0.6, rv: rand(-15, 15) });
      }
      for (let i = 0; i < 20; i++) {
        const d = _v1.set(rand(-1, 1), rand(0, 1.5), rand(-1, 1)).normalize(); const s = rand(8, 20);
        PA.spawn(pos.x, pos.y + 0.2, pos.z, d.x * s, d.y * s, d.z * s, { life: rand(0.3, 0.8), s0: 0.04, s1: 0.01, atlas: 2, c: [10, 6, 2.5], grav: 9.8, drag: 1.2 });
      }
      api.light(_v2.set(pos.x, pos.y + 0.8, pos.z), 30, 0.35, 0xffa040, 22);
      const h = curWorld.raycast(pos.x, pos.y + 0.3, pos.z, 0, -1, 0, 2, tmpHit, true);
      if (h) scorch.add(_v2.set(pos.x, pos.y + 0.3 - h.t, pos.z), _v3.set(0, 1, 0), rand(2.4, 3.2), [1, 1, 1]);
    },
    flashPop(pos) {
      PA.spawn(pos.x, pos.y, pos.z, 0, 0, 0, { life: 0.12, s0: 1.5, s1: 4, atlas: 0, c: [30, 30, 28] });
      for (let i = 0; i < 12; i++) { const d = _v1.set(rand(-1, 1), rand(-0.5, 1), rand(-1, 1)).normalize(); PA.spawn(pos.x, pos.y, pos.z, d.x * 9, d.y * 9, d.z * 9, { life: 0.25, s0: 0.05, atlas: 2, c: [12, 12, 10], drag: 2 }); }
      for (let i = 0; i < 6; i++) P.spawn(pos.x, pos.y, pos.z, rand(-0.5, 0.5), rand(0, 0.6), rand(-0.5, 0.5), { life: 2.5, s0: 0.2, s1: 1.2, atlas: 1, a: 0.35, c: [0.7, 0.7, 0.7], drag: 2 });
      api.light(pos, 60, 0.15, 0xffffff, 26);
    },
    smoke(pos) {
      const s = { pos: pos.clone(), r: 0, maxR: 3.6, t: 0, life: 18, parts: [] };
      smokes.push(s);
      return s;
    },
    fire(pos, dur = 7.5, radius = 3.3) {
      if (!pos) return null;
      const f = { pos: pos.clone(), r: radius, t: 0, life: dur, active: true };
      fires.push(f);
      const h = curWorld ? curWorld.raycast(pos.x, pos.y + 0.4, pos.z, 0, -1, 0, 2.4, tmpHit, true) : null;
      const gy = h ? pos.y + 0.4 - h.t : pos.y + 0.01;
      scorch.add(_v2.set(pos.x, gy, pos.z), _v3.set(0, 1, 0), rand(radius * 0.9, radius * 1.15), [0.95, 0.85, 0.78]);
      for (let i = 0; i < 18; i++) {
        const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * radius * 0.65;
        PA.spawn(pos.x + Math.cos(a) * rr * 0.3, gy + 0.15, pos.z + Math.sin(a) * rr * 0.3,
          Math.cos(a) * rand(1.4, 3.6), rand(1.0, 2.8), Math.sin(a) * rand(1.4, 3.6),
          { life: rand(0.3, 0.65), s0: rand(0.35, 0.65), s1: rand(0.9, 1.6), atlas: 1, c: [8.5, 3.6, 0.7], drag: 3.2, grav: -1.6, rv: rand(-2, 2) });
      }
      for (let i = 0; i < 14; i++) {
        const d = _v1.set(rand(-1, 1), rand(0.3, 1.5), rand(-1, 1)).normalize(); const s = rand(3.5, 9.5);
        PA.spawn(pos.x, gy + 0.25, pos.z, d.x * s, d.y * s, d.z * s,
          { life: rand(0.3, 0.75), s0: 0.035, s1: 0.008, atlas: 2, c: [10, 5.5, 1.8], grav: 9.8, drag: 1.0 });
      }
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * 6.28, rr = rand(0, radius * 0.45);
        P.spawn(pos.x + Math.cos(a) * rr, gy + 0.3, pos.z + Math.sin(a) * rr,
          Math.cos(a) * 0.8, rand(1.0, 2.2), Math.sin(a) * 0.8,
          { life: rand(1.2, 2.0), s0: 0.55, s1: rand(1.5, 2.3), atlas: 1, a: 0.48, c: [0.15, 0.13, 0.12], drag: 1.6, grav: -0.45, rv: rand(-0.6, 0.6) });
      }
      api.light(_v2.set(pos.x, gy + 0.7, pos.z), 16, 0.35, 0xff6a18, 16);
      return f;
    },
    extinguishFiresNear(pos, radius = 4.2) {
      if (!pos) return 0;
      let count = 0;
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i];
        if (!f.active) { fires.splice(i, 1); continue; }
        if (f.pos.distanceTo(pos) <= radius) {
          f.active = false;
          fires.splice(i, 1);
          count++;
          for (let k = 0; k < 20; k++) {
            const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * f.r * 0.9;
            P.spawn(f.pos.x + Math.cos(a) * rr, f.pos.y + 0.25, f.pos.z + Math.sin(a) * rr,
              Math.cos(a) * rand(0.3, 1.2), rand(1.2, 2.8), Math.sin(a) * rand(0.3, 1.2),
              { life: rand(1.2, 2.3), s0: rand(0.55, 0.9), s1: rand(1.9, 3.0), atlas: 1, a: 0.66, c: [0.92, 0.95, 0.98], drag: 1.8, grav: -0.55, fin: 0.08, rv: rand(-0.4, 0.4) });
          }
        }
      }
      if (!fires.length && fireLight) fireLight.intensity = 0;
      return count;
    },
    impactMarker(pos, isHit) {
      if (!impactMesh || !pos) return;
      const idx = impactIdx % IMPACT_MAX;
      impactIdx++;
      impactCount = Math.min(IMPACT_MAX, impactCount + 1);
      _impM4.makeTranslation(pos.x, pos.y, pos.z);
      impactMesh.setMatrixAt(idx, _impM4);
      if (isHit) _impCol.setRGB(0.12, 0.96, 0.74);
      else _impCol.setRGB(0.96, 0.16, 0.14);
      impactMesh.setColorAt(idx, _impCol);
      impactMesh.count = impactCount;
      impactMesh.instanceMatrix.needsUpdate = true;
      impactMesh.instanceColor.needsUpdate = true;
    },
    clearImpactMarkers() {
      impactIdx = 0;
      impactCount = 0;
      if (impactMesh) impactMesh.count = 0;
    },

    update(dt, cam) {
      // 环境天气粒子：低画质或关闭镜头特效时停用以保帧率
      if (Settings.data.quality !== 'low' && Settings.data.motionFx !== false) {
        const c = cam.position;
        if (weatherKind === 'snow') {
          if (Math.random() < dt * 36) {
            P.spawn(c.x + rand(-11, 11), c.y + rand(2.5, 6.5), c.z + rand(-11, 11), rand(-0.35, 0.45), rand(-1.3, -0.7), rand(-0.3, 0.35),
              { life: rand(4.5, 7.5), s0: rand(0.014, 0.028), atlas: 0, a: 0.72, c: [0.95, 0.98, 1.05], fin: 0.2, drag: 0.18, grav: 0.12 });
          }
        } else if (weatherKind === 'embers') {
          if (Math.random() < dt * 14) {
            P.spawn(c.x + rand(-8, 8), c.y + rand(-1.0, 2.5), c.z + rand(-8, 8), rand(0.15, 0.5), rand(0.02, 0.12), rand(-0.15, 0.2),
              { life: rand(3.5, 6), s0: rand(0.01, 0.02), atlas: 0, a: 0.48, c: [1.5, 1.1, 0.85], fin: 0.2, drag: 0.15 });
          }
          if (Math.random() < dt * 5) {
            PA.spawn(c.x + rand(-8, 8), c.y + rand(-0.8, 1.6), c.z + rand(-8, 8), rand(0.15, 0.6), rand(0.15, 0.5), rand(-0.2, 0.2),
              { life: rand(2.2, 4.2), s0: rand(0.012, 0.024), s1: 0.005, atlas: 2, a: 0.85, c: [4.5, 1.8, 0.4], fin: 0.15, drag: 0.2 });
          }
        } else if (weatherKind === 'mars') {
          if (Math.random() < dt * 24) {
            P.spawn(c.x + rand(-10, 10), c.y + rand(-1.0, 3.2), c.z + rand(-10, 10), rand(0.9, 2.2), rand(-0.12, 0.14), rand(-0.35, 0.35),
              { life: rand(3.2, 5.5), s0: rand(0.012, 0.026), atlas: 0, a: 0.62, c: [1.35, 0.62, 0.36], fin: 0.2, drag: 0.14 });
          }
          if (Math.random() < dt * 7) {
            P.spawn(c.x + rand(-12, 12), c.y + rand(-1.4, 0.4), c.z + rand(-12, 12), rand(2.2, 4.2), rand(-0.04, 0.08), rand(-0.4, 0.4),
              { life: rand(2.4, 4.0), s0: rand(0.5, 0.9), s1: rand(1.6, 2.5), atlas: 1, a: 0.16, c: [0.82, 0.40, 0.24], fin: 0.25, drag: 0.28, rv: rand(-0.2, 0.2) });
          }
        } else if (Math.random() < dt * 14) {
          P.spawn(c.x + rand(-7, 7), c.y + rand(-1.2, 2.5), c.z + rand(-7, 7), rand(0.05, 0.25), rand(-0.03, 0.06), rand(-0.1, 0.1),
            { life: rand(4, 7), s0: rand(0.008, 0.016), atlas: 0, a: 0.55, c: [1.6, 1.45, 1.2], fin: 0.25, drag: 0.1 });
        }
      }
      P.update(dt); PA.update(dt); smokeSys.update(dt);
      // 曳光
      for (const t of tracers) {
        if (!t.active) continue;
        t.head += t.speed * dt;
        const tail = Math.max(0, t.head - 3.5), head = Math.min(t.head, t.len);
        if (tail >= t.len) { t.active = false; t.mesh.visible = false; continue; }
        const segL = head - tail; if (segL <= 0.01) { t.mesh.visible = false; continue; }
        t.mesh.visible = true;
        const c = _v1.copy(t.start).addScaledVector(t.dir, (tail + head) / 2);
        const w = _v2.subVectors(cam.position, c); w.addScaledVector(t.dir, -w.dot(t.dir)).normalize();
        const y = _v3.crossVectors(w, t.dir).normalize();
        const m = t.mesh.matrix;
        const wid = 0.022 + Math.min(0.03, w.length() * 0);
        m.set(t.dir.x * segL, y.x * wid, w.x, c.x, t.dir.y * segL, y.y * wid, w.y, c.y, t.dir.z * segL, y.z * wid, w.z, c.z, 0, 0, 0, 1);
        t.mesh.matrixWorldNeedsUpdate = true;
      }
      // 弹壳
      const m4 = _shellM4, q = _shellQ;
      for (let i = shells.length - 1; i >= 0; i--) {
        const s = shells[i];
        s.life += dt;
        if (s.life > 9) { shells.splice(i, 1); continue; }
        if (!s.rest) {
          s.v.y -= 9.8 * dt;
          s.p.addScaledVector(s.v, dt);
          s.r.x += s.w.x * dt; s.r.y += s.w.y * dt; s.r.z += s.w.z * dt;
          const top = curWorld.surfaceTop(s.p.x, s.p.z, s.p.y + 0.3);
          if (s.p.y < top + 0.006) {
            s.p.y = top + 0.006;
            if (Math.abs(s.v.y) < 0.6 || s.bounces > 3) { s.rest = true; s.r.x = 0; s.r.z = 0; }
            else {
              s.v.y = -s.v.y * 0.32; s.v.x *= 0.55; s.v.z *= 0.55; s.w.multiplyScalar(0.5); s.bounces++;
              if (s.bounces <= 2 && Math.random() < 0.8) Sound.play('bounce', { pos: s.p, vol: 0.12, rate: s.big ? 1.1 : 1.6, ref: 1.5, rev: 0 });
            }
          }
          if (curWorld.pointSolid(s.p.x, s.p.y, s.p.z)) { s.v.x *= -0.3; s.v.z *= -0.3; s.p.addScaledVector(s.v, dt * 2); }
        }
        q.setFromEuler(s.r);
        m4.compose(s.p, q, _shellS.set(s.big ? 1.25 : 1, 1, 1));
        shellMesh.setMatrixAt(i, m4);
      }
      shellMesh.count = shells.length; shellMesh.instanceMatrix.needsUpdate = true;
      // 枪口焰
      for (const f of flashes) if (f.sp.visible) { f.t += dt; if (f.t > 0.05) f.sp.visible = false; }
      // 光
      for (const L of lights) {
        if (L.t < L.dur) { L.t += dt; L.l.intensity = L.peak * Math.max(0, 1 - L.t / L.dur); } else L.l.intensity = 0;
      }
      // 烟雾弹
      for (let i = smokes.length - 1; i >= 0; i--) {
        const s = smokes[i];
        s.t += dt;
        s.r = s.maxR * smoothstep(0, 2.2, s.t) * (s.t > s.life - 2 ? smoothstep(s.life + 1, s.life - 2, s.t) : 1);
        if (s.t < 2.4 && Math.random() < dt * 45) {
          for (let k = 0; k < 2; k++) {
            // 半球分布：向四周与上方翻涌，最终约 3.6m 半径、3m 高
            const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * s.maxR * 0.95, yy = Math.pow(Math.random(), 0.7) * s.maxR * 0.95;
            const g = 0.62 + Math.random() * 0.14;
            smokeSys.spawn(s.pos.x + Math.cos(a) * rr * 0.2, s.pos.y + 0.4, s.pos.z + Math.sin(a) * rr * 0.2,
              Math.cos(a) * rr * 1.1, yy * 1.25, Math.sin(a) * rr * 1.1,
              { life: s.life - s.t + rand(-1, 1.5), s0: 1.2, s1: rand(2.6, 3.6), atlas: 1, a: 0.88, c: [g, g, g * 0.98], drag: 1.35, fin: 0.06, rv: rand(-0.15, 0.15) });
          }
        }
        if (s.t > s.life + 1) smokes.splice(i, 1);
      }
      // 燃烧弹火焰体积
      let nearFire = null, nearD2 = Infinity, nearK = 0;
      for (let i = fires.length - 1; i >= 0; i--) {
        const f = fires[i];
        f.t += dt;
        if (!f.active || f.t >= f.life) { f.active = false; fires.splice(i, 1); continue; }
        const k = smoothstep(0, 0.35, f.t) * (f.t > f.life - 1.1 ? smoothstep(f.life, f.life - 1.1, f.t) : 1);
        const rad = f.r * (0.28 + 0.72 * smoothstep(0, 0.55, f.t));
        const flameCount = Math.min(5, Math.floor(dt * 52 * k + Math.random()));
        for (let m = 0; m < flameCount; m++) {
          const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * rad * 0.92;
          const hot = Math.random();
          PA.spawn(f.pos.x + Math.cos(a) * rr, f.pos.y + 0.12, f.pos.z + Math.sin(a) * rr,
            rand(-0.45, 0.45), rand(1.1, 2.3), rand(-0.45, 0.45),
            { life: rand(0.28, 0.58), s0: rand(0.32, 0.62), s1: rand(0.72, 1.3), atlas: 1, a: 0.75 * k,
              c: [7.5 + hot * 2.0, 2.2 + hot * 2.4, 0.35 + hot * 0.3], drag: 1.6, grav: -1.7, fin: 0.12, rv: rand(-1.4, 1.4) });
        }
        if (Math.random() < dt * 16 * k) {
          const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * rad * 0.85;
          PA.spawn(f.pos.x + Math.cos(a) * rr, f.pos.y + 0.25, f.pos.z + Math.sin(a) * rr,
            rand(-0.7, 0.7), rand(2.2, 4.4), rand(-0.7, 0.7),
            { life: rand(0.4, 0.85), s0: 0.032, s1: 0.008, atlas: 2, a: 0.95 * k, c: [10, 5.2, 1.4], drag: 0.8, grav: 0.8 });
        }
        if (Math.random() < dt * 15 * k) {
          const a = Math.random() * 6.28, rr = Math.sqrt(Math.random()) * rad * 0.78;
          P.spawn(f.pos.x + Math.cos(a) * rr, f.pos.y + 0.45, f.pos.z + Math.sin(a) * rr,
            rand(-0.35, 0.35), rand(1.1, 2.1), rand(-0.35, 0.35),
            { life: rand(1.0, 1.8), s0: rand(0.45, 0.72), s1: rand(1.4, 2.3), atlas: 1, a: 0.34 * k, c: [0.14, 0.12, 0.11], drag: 1.4, grav: -0.45, fin: 0.14, rv: rand(-0.4, 0.4) });
        }
        const d2 = f.pos.distanceToSquared(cam.position);
        if (d2 < nearD2) { nearD2 = d2; nearFire = f; nearK = k; }
      }
      if (fireLight) {
        if (nearFire) {
          fireLight.position.set(nearFire.pos.x, nearFire.pos.y + 0.85, nearFire.pos.z);
          fireLight.intensity = (6.5 + Math.sin(nearFire.t * 23) * 1.4 + Math.cos(nearFire.t * 37) * 0.9) * nearK;
        } else {
          fireLight.intensity = 0;
        }
      }
    },

    // 视线是否被烟雾遮挡
    smokeBlocks(a, b) {
      for (const s of smokes) {
        if (s.r < 0.8) continue;
        const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
        const L2 = dx * dx + dy * dy + dz * dz; if (L2 < 1e-6) continue;
        const cy = s.pos.y + s.r * 0.45;
        let t = ((s.pos.x - a.x) * dx + (cy - a.y) * dy + (s.pos.z - a.z) * dz) / L2;
        t = clamp(t, 0, 1);
        const px = a.x + dx * t - s.pos.x, py = a.y + dy * t - cy, pz = a.z + dz * t - s.pos.z;
        if (px * px + py * py * 1.6 + pz * pz < s.r * s.r * 0.8) return true;
      }
      return false;
    },

    setFog(color, density) {
      for (const sys of [P, PA, smokeSys]) { sys.mat.uniforms.fogColor.value.copy(color); sys.mat.uniforms.fogDensity.value = density; }
    },
    clearRound() {
      smokes.length = 0; smokeSys.clear(); shells.length = 0;
      fires.length = 0;
      if (fireLight) fireLight.intensity = 0;
      api.clearImpactMarkers();
      for (const t of tracers) { t.active = false; t.mesh.visible = false; }
    },
    clearAll() { api.clearRound(); holes.clear(); blood.clear(); scorch.clear(); P.clear(); PA.clear(); },
  };
  const _shellM4 = new THREE.Matrix4(), _shellQ = new THREE.Quaternion(), _shellS = new THREE.Vector3();
  const _impM4 = new THREE.Matrix4(), _impCol = new THREE.Color();
  return api;
})();
