'use strict';
// ======================================================================
//  map.js —— 多地图系统（炽沙小镇 / 极地科研站 / 黄昏货运港）
//           网格雕刻 + 贪心合并建筑 + 顶点 AO 烘焙 + 俯视雷达生成
// ======================================================================
const MapGen = (() => {
  const N = 48, CELL = 2, O = -48; // 48x48 格，每格 2m，覆盖 [-48, 48]
  const cx0 = (c) => O + c * CELL;

  const FACES = {
    px: { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0], vert: true },
    nx: { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0], vert: true },
    pz: { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0], vert: true },
    nz: { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0], vert: true },
    py: { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    ny: { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  };
  const FACE_KEYS = ['px', 'nx', 'pz', 'nz', 'py', 'ny'];
  const TEXS = {
    sand: 4, snow: 4, ice: 4, asphalt: 4,
    sandstone: 4, plaster: 4, concrete: 4, tile: 4, metal: 3, beam: 2.5, trim: 2,
    sack: 1.2, paint: 2, glass: 2, darkmetal: 2, rubber: 2, cloth: 2, lamp: 1,
  };
  const FACEUV = { crate: true, door: true };
  const PHYS_MAT = {
    sand: 'sand', snow: 'snow', ice: 'ice', asphalt: 'asphalt',
    sandstone: 'stone', plaster: 'plaster', concrete: 'concrete', tile: 'tile',
    crate: 'wood', metal: 'metal', door: 'wood', beam: 'wood', trim: 'stone',
    sack: 'sand', paint: 'metal', darkmetal: 'metal', glass: 'metal', rubber: 'wood', cloth: 'wood',
  };

  const DUST_STYLES = [
    { mat: 'plaster', tint: [1.0, 0.96, 0.88] },
    { mat: 'plaster', tint: [0.98, 0.85, 0.66] },
    { mat: 'plaster', tint: [0.86, 0.9, 0.96] },
    { mat: 'sandstone', tint: [1, 1, 1] },
    { mat: 'sandstone', tint: [0.94, 0.87, 0.78] },
    { mat: 'plaster', tint: [1.0, 0.8, 0.66] },
    { mat: 'concrete', tint: [1.0, 0.97, 0.92] },
    { mat: 'sandstone', tint: [1.04, 0.95, 0.86] },
  ];

  const FROST_STYLES = [
    { mat: 'concrete', tint: [0.92, 0.96, 1.0] },
    { mat: 'ice', tint: [0.88, 0.95, 1.02] },
    { mat: 'metal', tint: [0.76, 0.84, 0.92] },
    { mat: 'concrete', tint: [0.84, 0.9, 0.98] },
    { mat: 'concrete', tint: [0.88, 0.93, 0.99] },
    { mat: 'ice', tint: [0.8, 0.9, 1.0] },
  ];

  const HARBOR_STYLES = [
    { mat: 'concrete', tint: [0.88, 0.85, 0.82] },
    { mat: 'metal', tint: [0.46, 0.56, 0.64] },
    { mat: 'metal', tint: [0.68, 0.42, 0.34] },
    { mat: 'concrete', tint: [0.82, 0.78, 0.72] },
    { mat: 'concrete', tint: [0.76, 0.78, 0.82] },
    { mat: 'metal', tint: [0.48, 0.58, 0.48] },
  ];

  const MAPS = [
    {
      id: 'dust',
      name: '炽沙小镇',
      en: 'SANDSTORM · DUST',
      desc: '经典双道沙漠爆破图 · 长通道与中门对狙',
      weather: 'dust',
      lighting: {
        el: 34, az: 215,
        exposure: 0.50, env: 0.42, sun: 3.4, sunColor: 0xffe4c0,
        hemi: 0.12, hemiSky: 0xb9cfff, hemiGround: 0x9b7e5c,
        turbidity: 4.2, rayleigh: 1.9, mie: 0.004,
        ground: [0.4, 0.31, 0.2],
        fogColor: [0.86, 0.80, 0.70], fogDensity: 0.0032,
        tintHi: [0.014, 0.006, -0.012], tintLo: [-0.01, 0.0, 0.014],
      },
    },
    {
      id: 'frost',
      name: '极地科研站',
      en: 'ARCTIC LAB · FROST',
      desc: '低温反应釜与科研机库 · 冷阳积雪与飘雪视野',
      weather: 'snow',
      lighting: {
        el: 24, az: 145,
        exposure: 0.48, env: 0.46, sun: 3.0, sunColor: 0xdff0ff,
        hemi: 0.16, hemiSky: 0xaed4ff, hemiGround: 0x6b7f94,
        turbidity: 2.2, rayleigh: 1.4, mie: 0.006,
        ground: [0.65, 0.72, 0.80],
        fogColor: [0.76, 0.84, 0.92], fogDensity: 0.0042,
        tintHi: [-0.006, 0.005, 0.018], tintLo: [-0.012, 0.002, 0.018],
      },
    },
    {
      id: 'harbor',
      name: '黄昏货运港',
      en: 'SUNSET DOCK · HARBOR',
      desc: '龙门吊栈桥与货仓巷战 · 落日余晖与火星微光',
      weather: 'embers',
      lighting: {
        el: 16, az: 262,
        exposure: 0.52, env: 0.44, sun: 3.3, sunColor: 0xffae6c,
        hemi: 0.14, hemiSky: 0x96a6d8, hemiGround: 0x664836,
        turbidity: 6.5, rayleigh: 2.8, mie: 0.009,
        ground: [0.34, 0.24, 0.20],
        fogColor: [0.78, 0.58, 0.46], fogDensity: 0.0038,
        tintHi: [0.022, 0.006, -0.014], tintLo: [0.008, -0.004, 0.016],
      },
    },
  ];
  const MAP_BY_ID = Object.fromEntries(MAPS.map((m) => [m.id, m]));

  function injectAO(m) {
    m.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float ao;\nvarying float vAO;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvAO = ao;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vAO;')
        .replace('#include <aomap_fragment>', '#include <aomap_fragment>\nreflectedLight.indirectDiffuse *= vAO;\nreflectedLight.indirectSpecular *= vAO;\nreflectedLight.directDiffuse *= mix(0.62, 1.0, vAO);');
    };
    m.customProgramCacheKey = () => 'bakedAO';
    return m;
  }

  function build(mapId, world, scene, progress) {
    // 兼容旧的 3 参签名 build(world, scene, progress)
    if (typeof mapId !== 'string') {
      progress = scene;
      scene = world;
      world = mapId;
      mapId = 'dust';
    }
    const meta = MAP_BY_ID[mapId] || MAPS[0];
    mapId = meta.id;

    const T = Tex.sets, SP = Tex.sprites;
    const ownedMats = [];
    const trackMat = (m) => { ownedMats.push(m); return m; };

    // ---------------- 材质 ----------------
    const M = {};
    const std = (set, o) => trackMat(injectAO(new THREE.MeshStandardMaterial(Object.assign({
      map: set.map, normalMap: set.normalMap, roughnessMap: set.roughnessMap,
      roughness: 1, metalness: 0, vertexColors: true, envMapIntensity: 0.9,
    }, o))));
    const plain = (o) => trackMat(injectAO(new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, envMapIntensity: 0.9 }, o))));

    M.sand = std(T.sand);
    M.snow = std(T.snow);
    M.ice = std(T.ice, { metalness: 0.12 });
    M.asphalt = std(T.asphalt);
    M.sandstone = std(T.sandstone);
    M.plaster = std(T.plaster);
    M.concrete = std(T.concrete);
    M.tile = std(T.tile);
    M.crate = std(T.crate);
    M.metal = std(T.metal, { metalness: 0.45 });
    M.door = std(T.door);
    M.beam = std(T.beam);
    M.trim = std(T.trim);
    M.sack = std(T.sackcloth);

    const tone = {
      sand: 0.68, snow: 0.88, ice: 0.82, asphalt: 0.72,
      plaster: 0.74, sandstone: 0.84, tile: 0.6, concrete: 0.82, trim: 0.84, crate: 0.9, sack: 0.85,
    };
    for (const k in tone) M[k].color.setScalar(tone[k]);

    M.paint = plain({ color: 0xffffff, roughness: 0.4, metalness: 0.3 });
    M.glass = plain({ color: 0x10161b, roughness: 0.06, metalness: 0.5 });
    M.darkmetal = plain({ color: 0x2a2c2e, roughness: 0.5, metalness: 0.65 });
    M.rubber = plain({ color: 0x171717, roughness: 0.9 });
    M.cloth = plain({ color: 0xffffff, roughness: 0.95, side: THREE.DoubleSide });
    M.lamp = plain({
      color: 0x111111,
      emissive: mapId === 'frost' ? 0x9edbff : mapId === 'harbor' ? 0xff9b48 : 0xffd49a,
      emissiveIntensity: 5,
    });

    // ---------------- 公共建造原语 ----------------
    const solidG = new Uint8Array(N * N).fill(1);
    const carve = (c0, r0, c1, r1) => {
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) solidG[r * N + c] = 0;
    };
    const isSolid = (c, r) => c < 0 || r < 0 || c >= N || r >= N || solidG[r * N + c] === 1;

    const vis = [];
    const solid = (x0, y0, z0, x1, y1, z1, mat, o = {}) => {
      const b = world.add(x0, y0, z0, x1, y1, z1, o.phys || PHYS_MAT[o.top || mat] || 'stone', { ramp: !!o.ramp, noDecal: !!o.noDecal || !!o.ramp });
      if (!o.noVis) vis.push(Object.assign({ x0: b.minX, y0: b.minY, z0: b.minZ, x1: b.maxX, y1: b.maxY, z1: b.maxZ, mat }, o));
      return b;
    };
    const decor = (x0, y0, z0, x1, y1, z1, mat, o = {}) => vis.push(Object.assign({
      x0: Math.min(x0, x1), y0: Math.min(y0, y1), z0: Math.min(z0, z1),
      x1: Math.max(x0, x1), y1: Math.max(y0, y1), z1: Math.max(z0, z1), mat,
    }, o));

    const props = { barrels: [], wheels: [], palms: [], wires: [], lamps: [], signs: [], ramps: [] };
    const crate = (x, z, s = 1.63, y = 0, tint) => {
      const t = tint || [0.92 + Math.random() * 0.14, 0.9 + Math.random() * 0.12, 0.88 + Math.random() * 0.1];
      return solid(x - s / 2, y, z - s / 2, x + s / 2, y + s, z + s / 2, 'crate', { tint: t });
    };
    const barrel = (x, z, y = 0, color = [0.55, 0.16, 0.12]) => {
      solid(x - 0.3, y, z - 0.3, x + 0.3, y + 0.9, z + 0.3, 'metal', { noVis: true });
      props.barrels.push({ x, y, z, color });
    };
    const sandbags = (x0, z0, x1, z1, h = 0.95, bagMat = 'sack') => {
      solid(x0, 0, z0, x1, h, z1, bagMat, { noVis: true });
      const alongX = (x1 - x0) >= (z1 - z0);
      const L = alongX ? x1 - x0 : z1 - z0;
      const rows = Math.round(h / 0.19);
      for (let r = 0; r < rows; r++) {
        const y0 = r * 0.19, off = (r % 2) * 0.3;
        for (let u = -off; u < L - 0.05; u += 0.62) {
          const a = Math.max(0, u), bb = Math.min(L, u + 0.6); if (bb - a < 0.15) continue;
          const sh = (Math.random() - 0.5) * 0.04, k = 0.9 + Math.random() * 0.15;
          if (alongX) decor(x0 + a, y0, z0 + 0.02 + sh, x0 + bb, y0 + 0.2, z1 - 0.02 + sh, bagMat, { tint: [k, k, k * 0.97] });
          else decor(x0 + 0.02 + sh, y0, z0 + a, x1 - 0.02 + sh, y0 + 0.2, z0 + bb, bagMat, { tint: [k, k, k * 0.97] });
        }
      }
    };
    const car = (cx, cz, alongX, tint) => {
      const L = 4.3, W = 1.8;
      const bx = (a0, a1, w0, w1, y0, y1, mat, o = {}) => {
        if (alongX) decor(cx + a0, y0, cz + w0, cx + a1, y1, cz + w1, mat, Object.assign({ tint }, o));
        else decor(cx + w0, y0, cz + a0, cx + w1, y1, cz + a1, mat, Object.assign({ tint }, o));
      };
      if (alongX) { solid(cx - L / 2, 0, cz - W / 2, cx + L / 2, 0.95, cz + W / 2, 'paint', { noVis: true }); solid(cx - 1.25, 0.95, cz - 0.82, cx + 0.95, 1.5, cz + 0.82, 'paint', { noVis: true }); }
      else { solid(cx - W / 2, 0, cz - L / 2, cx + W / 2, 0.95, cz + L / 2, 'paint', { noVis: true }); solid(cx - 0.82, 0.95, cz - 1.25, cx + 0.82, 1.5, cz + 0.95, 'paint', { noVis: true }); }
      bx(-L / 2, L / 2, -W / 2, W / 2, 0.32, 0.95, 'paint');
      bx(-L / 2 - 0.08, -L / 2 + 0.05, -W / 2 + 0.05, W / 2 - 0.05, 0.3, 0.55, 'darkmetal', { tint: [1, 1, 1] });
      bx(L / 2 - 0.05, L / 2 + 0.08, -W / 2 + 0.05, W / 2 - 0.05, 0.3, 0.55, 'darkmetal', { tint: [1, 1, 1] });
      bx(-1.2, 0.9, -0.78, 0.78, 0.95, 1.42, 'glass', { tint: [1, 1, 1] });
      bx(-1.25, 0.95, -0.82, 0.82, 1.42, 1.5, 'paint');
      for (const a of [-1.2, 0.85]) for (const w of [-0.8, 0.74]) bx(a, a + 0.07, w, w + 0.06, 0.95, 1.42, 'paint');
      for (const a of [-L / 2 + 0.78, L / 2 - 0.78]) for (const s of [-1, 1]) {
        props.wheels.push(alongX ? { x: cx + a, y: 0.33, z: cz + s * (W / 2 - 0.02), rotY: 0 } : { x: cx + s * (W / 2 - 0.02), y: 0.33, z: cz + a, rotY: Math.PI / 2 });
      }
    };
    const container = (x0, z0, x1, z1, h, tint, y0 = 0) => {
      solid(x0, y0, z0, x1, y0 + h, z1, 'metal', { tint });
      decor(x0 - 0.04, y0 + h - 0.12, z0 - 0.04, x1 + 0.04, y0 + h, z1 + 0.04, 'darkmetal', { tint: [0.8, 0.8, 0.8] });
    };
    const ramp = (x0, z0, x1, z1, y0, y1, axis, rising, mat = 'concrete') => {
      const steps = Math.ceil((y1 - y0) / 0.1);
      for (let i = 0; i < steps; i++) {
        const top = y0 + (i + 0.5) / steps * (y1 - y0);
        if (axis === 'x') {
          const a = rising > 0 ? x0 + (x1 - x0) * i / steps : x1 - (x1 - x0) * i / steps;
          const b2 = rising > 0 ? x0 + (x1 - x0) * (i + 1) / steps : x1 - (x1 - x0) * (i + 1) / steps;
          solid(a, 0, z0, b2, top, z1, mat, { ramp: true, noVis: true });
        } else {
          const a = rising > 0 ? z0 + (z1 - z0) * i / steps : z1 - (z1 - z0) * i / steps;
          const b2 = rising > 0 ? z0 + (z1 - z0) * (i + 1) / steps : z1 - (z1 - z0) * (i + 1) / steps;
          solid(x0, 0, a, x1, top, b2, mat, { ramp: true, noVis: true });
        }
      }
      props.ramps.push({ x0, z0, x1, z1, y0, y1, axis, rising, mat });
    };
    const stairs = (x0, z0, x1, z1, y0, y1, axis, rising, n, mat = 'trim') => {
      for (let i = 0; i < n; i++) {
        const top = y0 + (i + 1) / n * (y1 - y0);
        if (axis === 'x') {
          const a = rising > 0 ? x0 + (x1 - x0) * i / n : x0;
          const b2 = rising > 0 ? x1 : x1 - (x1 - x0) * i / n;
          solid(a, 0, z0, b2, top, z1, mat, { tint: [0.95, 0.9, 0.84] });
        } else {
          const a = rising > 0 ? z0 + (z1 - z0) * i / n : z0;
          const b2 = rising > 0 ? z1 : z1 - (z1 - z0) * i / n;
          solid(x0, 0, a, x1, top, b2, mat, { tint: [0.95, 0.9, 0.84] });
        }
      }
    };
    const palm = (x, z, h) => props.palms.push({ x, z, h });
    const wire = (a, b2, sag = 0.8) => props.wires.push({ a, b: b2, sag });
    const lamp = (x, y, z) => props.lamps.push({ x, y, z });

    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const hold = (x, y, z, lx, ly, lz) => ({ pos: V(x, y, z), look: V(lx, ly + 1.5, lz) });

    // ---------------- 按地图 ID 雕刻布局与配置 ----------------
    let STYLES = DUST_STYLES;
    let borderStyle = { mat: 'sandstone', tint: [0.97, 0.92, 0.84] };
    let borderH = 11;
    let floorMat = () => 'sand';
    let windowStyle = 'mediterranean';
    let points = {}, sites = {}, buyZones = {}, holds = {}, routes = {}, callouts = [];
    let spawns = { T: [], CT: [] };
    let rangeAnchor = { pos: [0, 0, 24], yaw: 0 };
    let rangeSpots = [[2.5, 0, 4], [-2.5, 0, -4], [1.5, 0, -12], [-1.5, 0, -17], [3, 0, -28], [-3.2, 0, 9.5]];

    if (mapId === 'frost') {
      // ================================================================
      //  极地科研站（ARCTIC LAB · FROST）
      // ================================================================
      STYLES = FROST_STYLES;
      borderStyle = { mat: 'ice', tint: [0.85, 0.92, 0.98] };
      borderH = 10;
      windowStyle = 'arctic';

      carve(18, 2, 29, 7);    // CT 北停机坪 / 主实验楼
      carve(21, 8, 26, 12);   // CT 中门通道
      carve(19, 13, 28, 34);  // 中央冰桥广场
      carve(20, 35, 27, 39);  // T 中路入口
      carve(16, 40, 31, 45);  // T 南破冰补给站
      // 东侧 A 区：低温反应釜广场
      carve(33, 4, 44, 15);
      carve(30, 4, 32, 8);    // CT → A 通道
      carve(32, 35, 44, 42);  // T → A 外场
      carve(39, 16, 44, 34);  // A 东侧大道
      carve(29, 16, 38, 19);  // 中路 → A 小道
      // 西侧 B 区：科研机库
      carve(3, 4, 14, 15);
      carve(15, 4, 17, 7);    // CT → B 门
      carve(15, 11, 18, 13);  // CT → B 观察窗
      carve(5, 36, 15, 41);   // T → B 外廊
      carve(5, 16, 9, 35);    // B 实验室长廊
      carve(10, 22, 18, 25);  // 中路 → B 连廊

      floorMat = (c, r) => {
        if (c >= 33 && c <= 44 && r >= 4 && r <= 15) return 'concrete';
        if (c >= 3 && c <= 14 && r >= 4 && r <= 15) return 'concrete';
        if (c >= 19 && c <= 28 && r >= 13 && r <= 34) return 'ice';
        if (c >= 18 && c <= 29 && r >= 2 && r <= 7) return 'concrete';
        if (c >= 5 && c <= 9 && r >= 16 && r <= 35) return 'concrete';
        return 'snow';
      };

      // A 低温反应釜广场
      solid(28, 0, -36, 38, 0.85, -24, 'concrete', { top: 'ice', tint: [0.88, 0.94, 1.0] });
      ramp(28, -24, 38, -20, 0, 0.85, 'z', -1, 'concrete');
      stairs(24, -33, 28, -28, 0, 0.85, 'x', 1, 4, 'concrete');
      container(31, -35, 34, -29, 2.2, [0.22, 0.56, 0.78], 0.85);
      crate(24, -22, 1.6, 0, [0.84, 0.9, 0.98]);
      barrel(39, -24, 0, [0.16, 0.45, 0.72]); barrel(39, -23.1, 0, [0.82, 0.42, 0.14]);
      container(33, 4, 37.5, 10, 2.5, [0.24, 0.44, 0.64]);
      crate(38, 24, 1.63, 0, [0.85, 0.92, 0.98]);
      solid(14, 0, -14, 16.5, 1.1, -11.5, 'ice', { tint: [0.82, 0.92, 1] });
      props.signs.push({ tex: SP.siteA, x: 33, y: 2.8, z: -39.96, ry: 0, s: 2.2 });
      props.signs.push({ tex: SP.siteA, x: 34, y: 2.2, z: -16.05, ry: Math.PI, s: 1.4 });

      // B 科研机库（半室内顶棚）
      solid(-41, 4.2, -39, -21, 4.7, -19, 'metal', { tint: [0.74, 0.82, 0.9] });
      for (let z = -37; z <= -21; z += 6) lamp(-31, 3.9, z);
      container(-37, -34, -32, -26, 2.3, [0.82, 0.36, 0.18]);
      crate(-25, -35, 1.63, 0, [0.85, 0.92, 0.98]);
      crate(-26, -24, 1.63, 0, [0.85, 0.92, 0.98]); crate(-26, -24, 1.2, 1.63, [0.85, 0.92, 0.98]);
      barrel(-39, -22, 0, [0.16, 0.45, 0.72]);
      // B 实验室长廊顶灯
      solid(-38, 3.6, -12, -30, 4.0, 22, 'metal', { tint: [0.76, 0.84, 0.92] });
      for (let z = -8; z <= 20; z += 7) lamp(-34, 3.25, z);
      crate(-33, 4, 1.4, 0, [0.84, 0.9, 0.98]);

      // 中央冰桥（保持正中 x ∈ [-5, 5] 通透供靶场）
      crate(-7.2, -6, 1.5, 0, [0.82, 0.92, 1.0]);
      crate(7.2, 5, 1.5, 0, [0.82, 0.92, 1.0]);
      barrel(-6.8, 12, 0, [0.82, 0.42, 0.14]); barrel(6.8, -14, 0, [0.16, 0.45, 0.72]);
      sandbags(-7.5, -27.5, -4.2, -26.8, 0.95, 'ice');
      sandbags(4.2, 26.5, 7.5, 27.2, 0.95, 'ice');

      // CT & T 出生点装饰
      car(-7, -39, true, [0.86, 0.92, 0.98]);
      container(4, -41, 10, -37, 2.4, [0.22, 0.52, 0.76]);
      container(-12, 35, -6, 38, 2.4, [0.82, 0.36, 0.18]);
      car(9, 36, true, [0.35, 0.45, 0.56]);
      wire(V(-9, 5.8, -16), V(9, 5.6, -16), 0.9);
      wire(V(-9, 5.8, 12), V(9, 5.8, 12), 0.9);
      props.signs.push({ tex: SP.siteB, x: -41.96, y: 2.8, z: -28, ry: Math.PI / 2, s: 2.2 });

      for (let x = -10; x <= 10; x += 2.5) for (let z = -42.5; z <= -34; z += 2.6) spawns.CT.push(V(x, 0, z));
      for (let x = -13; x <= 13; x += 3) for (let z = 34; z <= 42; z += 3) spawns.T.push(V(x, 0, z));

      points = {
        t_spawn: V(0, 0, 38), ct_spawn: V(0, 0, -38),
        top_mid: V(0, 0, 22), mid: V(0, 0, 0), xbox: V(-5, 0, -6), mid_doors: V(0, 0, -24), ct_mid: V(0, 0, -30),
        outside_long: V(28, 0, 32), long_doors: V(36, 0, 18), long: V(36, 0, 0), long_corner: V(36, 0, -13),
        a_ramp: V(33, 0.4, -22), a_site: V(29, 0.85, -30), a_short: V(22, 0, -13), short: V(13, 0, -13), ct_to_a: V(15, 0, -36),
        upper_tunnel: V(-34, 0, 32), b_tunnel: V(-34, 0, 0), lower_tunnel: V(-18, 0, -1), b_exit: V(-34, 0, -14),
        b_site: V(-29, 0, -29), b_plat: V(-38, 0, -36), b_doors: V(-16, 0, -37), b_window: V(-15, 0, -24),
      };
      sites = {
        A: { min: [21, -39], max: [41, -19], center: V(30, 0.85, -30) },
        B: { min: [-41, -39], max: [-21, -19], center: V(-30, 0, -29) },
      };
      buyZones = { T: { min: [-16, 30], max: [16, 44] }, CT: { min: [-12, -44], max: [12, -32] } };
      holds = {
        A: [hold(29, 0.85, -33, 36, 0, -14), hold(25, 0.85, -28, 22, 0, -14), hold(38, 0, -36, 36, 0, -20), hold(18, 0, -36, 28, 0, -24)],
        B: [hold(-38, 0, -36, -34, 0, -16), hold(-23, 0, -31, -34, 0, -18), hold(-26, 0, -39, -18, 0, -25), hold(-20, 0, -21, -34, 0, -15)],
        mid: [hold(0, 0, -28, 0, 0, 0), hold(-4, 0, -26, 0, 0, -6)],
      };
      routes = {
        A: [['outside_long', 'long_doors', 'long', 'long_corner', 'a_ramp', 'a_site'], ['top_mid', 'mid', 'short', 'a_short', 'a_site']],
        B: [['upper_tunnel', 'b_tunnel', 'b_exit', 'b_site'], ['top_mid', 'lower_tunnel', 'b_tunnel', 'b_exit', 'b_site']],
      };
      callouts = [
        { name: 'CT 停机坪', x0: -14, x1: 14, z0: -46, z1: -32 },
        { name: 'T 破冰补给站', x0: -18, x1: 18, z0: 32, z1: 46 },
        { name: 'A 反应釜广场', x0: 18, x1: 44, z0: -42, z1: -16 },
        { name: 'B 科研机库', x0: -44, x1: -18, z0: -42, z1: -16 },
        { name: 'A 东外走廊', x0: 28, x1: 44, z0: -16, z1: 36 },
        { name: 'B 实验长廊', x0: -40, x1: -28, z0: -16, z1: 36 },
        { name: '中路冰桥', x0: -14, x1: 14, z0: -32, z1: 32 },
      ];
      rangeAnchor = { pos: [0, 0, 22], yaw: 0 };
      rangeSpots = [[-4.5, 0, 6], [4.5, 0, -2], [-2.5, 0, -10], [3.2, 0, -16], [0, 0, -20], [4.0, 0, 12]];

    } else if (mapId === 'harbor') {
      // ================================================================
      //  黄昏货运港（SUNSET DOCK · HARBOR）
      // ================================================================
      STYLES = HARBOR_STYLES;
      borderStyle = { mat: 'concrete', tint: [0.76, 0.72, 0.68] };
      borderH = 9.5;
      windowStyle = 'industrial';

      carve(18, 2, 29, 7);    // CT 海关调度广场
      carve(21, 8, 26, 13);   // CT 中路闸口
      carve(19, 14, 28, 33);  // 中路港口主干道
      carve(20, 34, 27, 39);  // T 南码头大道
      carve(15, 40, 32, 45);  // T 南码头入口
      // 东侧 A 区：龙门吊露天堆场
      carve(32, 3, 45, 15);
      carve(30, 4, 31, 8);    // CT → A 闸口
      carve(33, 35, 44, 41);  // T → A 外码头
      carve(38, 16, 44, 34);  // A 栈桥走廊
      carve(29, 17, 37, 20);  // 中路 → A 联通路
      // 西侧 B 区：海关一号货仓
      carve(3, 3, 15, 15);
      carve(16, 4, 17, 7);    // CT → B 卷帘门
      carve(16, 11, 18, 13);  // CT → B 侧窗
      carve(4, 36, 14, 41);   // T → B 货场外道
      carve(4, 16, 9, 35);    // B 西侧通道
      carve(10, 23, 18, 26);  // 中路 → B 叉车通道

      floorMat = (c, r) => {
        if (c >= 32 && c <= 45 && r >= 3 && r <= 15) return 'concrete';
        if (c >= 3 && c <= 15 && r >= 3 && r <= 15) return 'concrete';
        if (c >= 18 && c <= 29 && r >= 2 && r <= 7) return 'concrete';
        return 'asphalt';
      };

      // A 龙门吊露天堆场
      solid(28, 0, -40, 42, 0.9, -28, 'concrete', { top: 'concrete', tint: [0.84, 0.8, 0.76] });
      ramp(35, -28, 42, -23.5, 0, 0.9, 'z', -1, 'concrete');
      stairs(24, -36, 28, -31, 0, 0.9, 'x', 1, 5, 'concrete');
      container(31, -39, 36.5, -36.6, 2.4, [0.16, 0.44, 0.48], 0.9); // 青绿集装箱
      container(32, -39, 36.5, -36.6, 2.2, [0.76, 0.36, 0.16], 3.3); // 上层红橙箱
      container(37, -33.5, 39.5, -29, 2.3, [0.18, 0.32, 0.56], 0.9);
      crate(29.5, -31, 1.5, 0.9);
      // 标志性港口橙色龙门吊横梁 + 立柱
      decor(23, 7.6, -41.5, 44.5, 8.4, -39.2, 'paint', { tint: [0.86, 0.32, 0.12], ao: false });
      decor(23, 0, -41.4, 24.1, 7.6, -39.3, 'paint', { tint: [0.82, 0.3, 0.12] });
      decor(43.2, 0, -41.4, 44.3, 7.6, -39.3, 'paint', { tint: [0.82, 0.3, 0.12] });
      // A 东侧大道集装箱
      container(31, -8, 33.4, -2, 2.5, [0.74, 0.52, 0.16]);
      crate(39, 10); crate(37, -16);
      barrel(41.5, 4, 0, [0.76, 0.24, 0.12]); barrel(41.5, 4.9, 0, [0.18, 0.36, 0.62]);
      props.signs.push({ tex: SP.siteA, x: 35, y: 2.8, z: -41.96, ry: 0, s: 2.2 });

      // B 海关一号货仓
      solid(-41.5, 4.5, -41.5, -18.5, 4.9, -18.5, 'concrete', { tint: [0.72, 0.7, 0.68] });
      for (let z = -39; z <= -21; z += 6) lamp(-30, 4.15, z);
      container(-38, -37, -32, -34.5, 2.4, [0.68, 0.22, 0.18]);
      crate(-28, -32); crate(-28, -32, 1.2, 1.63);
      crate(-34, -24); crate(-23, -24);
      barrel(-40, -25, 0, [0.76, 0.24, 0.12]);
      // B 西通道堆货
      crate(-35, 2); crate(-35, 2, 1.2, 1.63);
      barrel(-37, 26, 0, [0.74, 0.52, 0.16]);
      props.signs.push({ tex: SP.siteB, x: -41.96, y: 2.8, z: -29, ry: Math.PI / 2, s: 2.2 });

      // 中路港口主干道（两侧集装箱与车辆，中轴留空供狙击/靶场）
      container(-8.5, -9, -6.1, -3, 2.4, [0.18, 0.32, 0.56]);
      container(6.1, 2, 8.5, 8, 2.4, [0.16, 0.44, 0.48]);
      crate(-7.2, 11); crate(7.2, -13);
      sandbags(-7.8, -26.5, -4.4, -25.9, 0.95);
      car(-7, -38.5, true, [0.24, 0.34, 0.44]);
      car(9, 36.5, true, [0.74, 0.22, 0.16]);
      container(-12, 34, -6, 36.6, 2.4, [0.74, 0.52, 0.16]);
      lamp(0, 4.6, -24); lamp(26, 4.6, -12); lamp(-24, 4.6, -12);
      wire(V(-9, 6.2, -14), V(9, 6.0, -14), 1.0);
      wire(V(-9, 6.0, 14), V(9, 6.2, 14), 1.0);

      for (let x = -10; x <= 10; x += 2.5) for (let z = -42.5; z <= -34; z += 2.6) spawns.CT.push(V(x, 0, z));
      for (let x = -13; x <= 13; x += 3) for (let z = 34; z <= 42; z += 3) spawns.T.push(V(x, 0, z));

      points = {
        t_spawn: V(0, 0, 38), ct_spawn: V(0, 0, -38),
        top_mid: V(0, 0, 22), mid: V(0, 0, 0), xbox: V(4, 0, 5), mid_doors: V(0, 0, -22), ct_mid: V(0, 0, -29),
        outside_long: V(28, 0, 32), long_doors: V(35, 0, 18), long: V(35, 0, 0), long_corner: V(35, 0, -14),
        a_ramp: V(38, 0.45, -25), a_site: V(32, 0.9, -32), a_short: V(22, 0, -11), short: V(13, 0, -11), ct_to_a: V(15, 0, -36),
        upper_tunnel: V(-35, 0, 32), b_tunnel: V(-35, 0, 0), lower_tunnel: V(-18, 0, 1), b_exit: V(-35, 0, -14),
        b_site: V(-30, 0, -30), b_plat: V(-38, 0, -32), b_doors: V(-15, 0, -37), b_window: V(-14, 0, -24),
      };
      sites = {
        A: { min: [22, -41], max: [42, -19], center: V(32, 0.9, -32) },
        B: { min: [-42, -41], max: [-18, -19], center: V(-30, 0, -30) },
      };
      buyZones = { T: { min: [-18, 30], max: [18, 44] }, CT: { min: [-12, -44], max: [12, -32] } };
      holds = {
        A: [hold(30, 0.9, -34, 35, 0, -14), hold(26, 0.9, -29, 22, 0, -12), hold(40, 0.9, -36, 36, 0, -20), hold(18, 0, -36, 28, 0, -24)],
        B: [hold(-39, 0, -30, -35, 0, -16), hold(-22, 0, -30, -35, 0, -18), hold(-26, 0, -39, -18, 0, -25), hold(-20, 0, -22, -35, 0, -16)],
        mid: [hold(0, 0, -28, 0, 0, 0), hold(3, 0, -26, -2, 0, -8)],
      };
      routes = {
        A: [['outside_long', 'long_doors', 'long', 'long_corner', 'a_ramp', 'a_site'], ['top_mid', 'mid', 'short', 'a_short', 'a_site']],
        B: [['upper_tunnel', 'b_tunnel', 'b_exit', 'b_site'], ['top_mid', 'lower_tunnel', 'b_tunnel', 'b_exit', 'b_site']],
      };
      callouts = [
        { name: '海关调度场', x0: -14, x1: 14, z0: -46, z1: -32 },
        { name: '南码头入口', x0: -18, x1: 18, z0: 32, z1: 46 },
        { name: 'A 龙门吊堆场', x0: 18, x1: 44, z0: -42, z1: -16 },
        { name: 'B 一号货仓', x0: -44, x1: -16, z0: -42, z1: -16 },
        { name: '东栈桥大道', x0: 28, x1: 44, z0: -16, z1: 36 },
        { name: '西货场巷道', x0: -40, x1: -28, z0: -16, z1: 36 },
        { name: '港口中路大道', x0: -14, x1: 14, z0: -32, z1: 32 },
      ];
      rangeAnchor = { pos: [0, 0, 22], yaw: 0 };
      rangeSpots = [[-4.2, 0, 8], [4.2, 0, 0], [-2.5, 0, -9], [3.0, 0, -16], [0, 0, -20], [-4.5, 0, 14]];

    } else {
      // ================================================================
      //  炽沙小镇（SANDSTORM · DUST）
      // ================================================================
      carve(18, 2, 29, 7);    // CT 出生点
      carve(21, 8, 26, 11);   // CT 中路
      carve(23, 12, 24, 13);  // 中门
      carve(22, 14, 25, 29);  // 中路
      carve(20, 30, 27, 37);  // T 中路
      carve(15, 38, 31, 45);  // T 出生点
      carve(31, 34, 44, 39);  // A 大外
      carve(41, 31, 43, 33);  // A 大门
      carve(39, 15, 44, 30);  // A 大道
      carve(33, 3, 44, 14);   // A 包点
      carve(26, 16, 35, 18);  // A 小道
      carve(33, 15, 35, 15);
      carve(30, 4, 32, 7);    // CT → A
      carve(3, 3, 14, 14);    // B 包点
      carve(15, 4, 17, 6);    // B 门
      carve(15, 10, 20, 11);  // B 窗
      carve(6, 38, 14, 42);   // B 外/上洞
      carve(6, 15, 8, 37);    // B 洞
      carve(9, 26, 21, 27);   // 下水道

      floorMat = (c, r) => {
        if (c >= 33 && c <= 44 && r >= 3 && r <= 14) return 'tile';
        if (c >= 3 && c <= 14 && r >= 3 && r <= 14) return 'tile';
        if (c >= 18 && c <= 29 && r >= 2 && r <= 7) return 'concrete';
        if ((c >= 6 && c <= 8 && r >= 20 && r <= 37) || (r >= 26 && r <= 27 && c >= 9 && c <= 21)) return 'concrete';
        return 'sand';
      };

      // A 包点
      solid(26, 0, -42, 42, 1.1, -30, 'sandstone', { top: 'tile', tint: [0.95, 0.9, 0.82] });
      decor(26, 1.1, -30.12, 42, 1.22, -29.92, 'trim', { tint: [0.9, 0.85, 0.78] });
      ramp(36, -30, 42, -26, 0, 1.1, 'z', -1, 'tile');
      stairs(23, -36, 26, -33, 0, 1.1, 'x', 1, 5);
      crate(33.3, -37.8, 1.63, 1.1); crate(33.3, -37.8, 1.2, 2.73);
      crate(38.8, -34.2, 1.63, 1.1);
      crate(41.0, -41.0, 1.63, 1.1);
      crate(21.8, -24.0); crate(28.8, -21.2); crate(28.8, -21.2, 1.2, 1.63);
      barrel(40.9, -22.5, 0, [0.2, 0.32, 0.5]); barrel(41.0, -21.6, 0, [0.2, 0.32, 0.5]);
      sandbags(18.3, -30.6, 21.5, -30.0, 0.95);
      props.signs.push({ tex: SP.siteA, x: 30, y: 2.9, z: -41.98, ry: 0, s: 2.2 });
      props.signs.push({ tex: SP.siteA, x: 32.0, y: 2.0, z: -17.98, ry: Math.PI, s: 1.4 });
      // A 大道 / 大门 / 大外
      container(30.4, -9, 32.84, -3, 2.6, [0.34, 0.5, 0.68]);
      crate(40.3, 9.8); crate(31.3, -15.7);
      barrel(41.4, 3.0); barrel(41.4, 2.15, 0, [0.6, 0.45, 0.15]);
      solid(34, 3.2, 14, 40, 4.8, 20, 'sandstone', { tint: [0.95, 0.9, 0.82] });
      solid(34, 0, 16.93, 36.6, 2.6, 17.07, 'door', { phys: 'wood' });
      crate(22.8, 24.8); crate(24.45, 24.8); crate(23.6, 24.8, 1.2, 1.63);
      solid(28, 0, 21, 28.4, 1.1, 25, 'sandstone', { tint: [0.92, 0.86, 0.78] });
      car(36, 26.5, true, [0.72, 0.18, 0.14]);
      // A 小道
      solid(14.8, 0, -16, 15.2, 1.0, -13.6, 'sandstone', { tint: [0.95, 0.9, 0.82] });
      crate(21.3, -11.0); barrel(9, -15.3, 0, [0.25, 0.4, 0.22]);
      // 中路
      crate(-2.2, 9.4);
      barrel(3.3, -6.0); barrel(3.3, -5.15, 0, [0.25, 0.4, 0.22]);
      solid(-2, 3.0, -24, 2, 4.6, -20, 'sandstone', { tint: [0.95, 0.9, 0.82] });
      solid(-2, 0, -22.07, -0.25, 2.5, -21.93, 'door', { phys: 'wood' });
      crate(5.8, 22.8); sandbags(-7.5, 26.2, -4.5, 26.8);
      // CT
      sandbags(2.5, -27.3, 5.5, -26.7);
      crate(-4.7, -30.2);
      car(-6, -40.2, true, [0.85, 0.83, 0.78]);
      crate(6.8, -42.2); crate(8.45, -42.2); crate(7.6, -42.2, 1.2, 1.63);
      palm(9.5, -34.5, 7.5); palm(-10.5, -34, 6.5);
      // B 包点
      solid(-42, 0, -42, -32, 0.9, -34, 'sandstone', { top: 'tile', tint: [0.95, 0.9, 0.82] });
      ramp(-32, -40, -29, -36, 0, 0.9, 'x', -1, 'tile');
      car(-24, -37, true, [0.36, 0.42, 0.3]);
      crate(-26.7, -25.7); crate(-26.7, -25.7, 1.2, 1.63);
      crate(-37.7, -38.2, 1.63, 0.9);
      crate(-31.0, -20.2);
      barrel(-41.3, -26, 0, [0.6, 0.45, 0.15]); barrel(-41.3, -25.15);
      solid(-17, 0, -28, -16.6, 1.0, -24, 'sandstone', { tint: [0.95, 0.9, 0.82] });
      solid(-18.07, 0, -40, -17.93, 2.6, -37.4, 'door', { phys: 'wood' });
      props.signs.push({ tex: SP.siteB, x: -41.98, y: 2.8, z: -30, ry: Math.PI / 2, s: 2.2 });
      props.signs.push({ tex: SP.siteB, x: -30.02, y: 2.0, z: -14.5, ry: -Math.PI / 2, s: 1.3 });
      // B 洞 / 下水道
      solid(-36, 3.2, -12, -30, 3.6, 26, 'beam', { tint: [1, 1, 1] });
      for (let z = -11; z < 26; z += 3.6) { decor(-36, 2.95, z, -30, 3.2, z + 0.24, 'beam', { tint: [0.85, 0.85, 0.85] }); lamp(-33, 2.75, z + 1.8); }
      solid(-30, 3.2, 4, -9, 3.6, 8, 'beam', { tint: [1, 1, 1] });
      for (let x = -29; x < -9; x += 3.6) { decor(x, 2.95, 4, x + 0.24, 3.2, 8, 'beam', { tint: [0.85, 0.85, 0.85] }); lamp(x + 1.8, 2.75, 6); }
      solid(-36, 3.4, 29.5, -25, 3.8, 38, 'beam', { tint: [1, 1, 1] });
      crate(-34.8, 2.8); crate(-21.2, 35.8); barrel(-35.4, 31.4); barrel(-34.6, 31.4, 0, [0.6, 0.45, 0.15]);
      // T 出生点
      solid(2, 0, 36, 7, 3.0, 38.4, 'metal', { tint: [0.4, 0.5, 0.36] });
      solid(7, 0, 36.1, 8.7, 2.3, 38.3, 'paint', { tint: [0.75, 0.7, 0.6] });
      decor(7.05, 1.4, 36.15, 8.75, 2.1, 38.25, 'glass', { tint: [1, 1, 1] });
      for (const x of [3, 5.8, 7.8]) for (const s of [-1, 1]) props.wheels.push({ x, y: 0.42, z: 37.2 + s * 1.18, rotY: 0, r: 0.42 });
      crate(-9.2, 31.8); crate(-7.55, 31.8); crate(-8.4, 31.8, 1.2, 1.63);
      sandbags(-3, 30.0, 1.5, 30.6);
      palm(-15.5, 42.5, 7); palm(13.5, 30.5, 8); palm(-16, 30, 6);
      wire(V(-4, 6.2, -2), V(4, 5.6, 3), 0.9);
      wire(V(-4, 6.0, 4), V(4, 6.4, 6), 0.7);
      wire(V(30, 6.4, 6), V(42, 6.2, 4), 1.2);
      wire(V(14, 6.0, 26), V(14, 6.2, 32), 0.6);
      wire(V(-18, 6.0, 33), V(-6, 6.4, 28), 1.0);
      wire(V(-12, 6.0, -44), V(12, 6.0, -44), 1.6);
      lamp(0, 3.0, -21.5); lamp(37, 3.0, 17);

      for (let x = -13; x <= 11; x += 3) for (let z = 33; z <= 42; z += 3) spawns.T.push(V(x, 0, z));
      for (let x = -10; x <= 10; x += 2.5) for (let z = -42.5; z <= -34; z += 2.6) spawns.CT.push(V(x, 0, z));

      points = {
        t_spawn: V(0, 0, 38), ct_spawn: V(0, 0, -38),
        top_mid: V(0, 0, 20), mid: V(0, 0, 0), xbox: V(-1, 0, 12), mid_doors: V(1, 0, -22), ct_mid: V(0, 0, -28),
        outside_long: V(25, 0, 27), long_doors: V(38, 0, 17), long: V(36, 0, 0), long_corner: V(36, 0, -13),
        a_ramp: V(39, 0.55, -28), a_site: V(32, 1.1, -35), a_short: V(21, 0, -14), short: V(12, 0, -13), ct_to_a: V(15, 0, -36),
        upper_tunnel: V(-27, 0, 33), b_tunnel: V(-33, 0, 0), lower_tunnel: V(-18, 0, 6), b_exit: V(-33, 0, -14),
        b_site: V(-28, 0, -30), b_plat: V(-38, 0.9, -36), b_doors: V(-15, 0, -37), b_window: V(-12, 0, -26),
      };
      sites = {
        A: { min: [24, -42], max: [42, -24], center: V(33, 1.1, -35) },
        B: { min: [-42, -42], max: [-24, -24], center: V(-30, 0, -32) },
      };
      buyZones = { T: { min: [-18, 28], max: [16, 44] }, CT: { min: [-12, -44], max: [12, -32] } };
      holds = {
        A: [hold(34, 1.1, -33, 36, 0, -12), hold(27, 1.1, -40, 21, 0, -15), hold(40, 1.1, -38, 38, 0, -24), hold(20, 0, -36, 26, 0, -24)],
        B: [hold(-37, 0.9, -36, -33, 0, -16), hold(-24, 0, -33, -33, 0, -18), hold(-28, 0, -41, -20, 0, -26), hold(-20, 0, -22, -33, 0, -16)],
        mid: [hold(0, 0, -29, 0, 0, 0), hold(3, 0, -29.5, -1, 0, -10)],
      };
      routes = {
        A: [['outside_long', 'long_doors', 'long', 'long_corner', 'a_ramp', 'a_site'], ['top_mid', 'mid', 'short', 'a_short', 'a_site']],
        B: [['upper_tunnel', 'b_tunnel', 'b_exit', 'b_site'], ['top_mid', 'lower_tunnel', 'b_tunnel', 'b_exit', 'b_site']],
      };
      callouts = [
        { name: 'CT 出生点', x0: -12, x1: 12, z0: -46, z1: -32 },
        { name: 'T 出生点', x0: -18, x1: 16, z0: 28, z1: 46 },
        { name: 'A 包点', x0: 22, x1: 44, z0: -44, z1: -20 },
        { name: 'B 包点', x0: -44, x1: -22, z0: -44, z1: -20 },
        { name: 'A 大道', x0: 28, x1: 44, z0: -20, z1: 32 },
        { name: 'B 洞', x0: -38, x1: -28, z0: -20, z1: 36 },
        { name: '下水道', x0: -28, x1: -6, z0: 2, z1: 10 },
        { name: 'A 小道', x0: 6, x1: 28, z0: -18, z1: -10 },
        { name: '中路', x0: -8, x1: 8, z0: -32, z1: 28 },
      ];
    }

    // ---------------- 建筑（贪心合并同风格格子） ----------------
    const H = (s) => Tex.hash2(s[0], s[1], s[2]);
    const keyOf = (c, r) => {
      if (c <= 1 || r <= 1 || c >= N - 2 || r >= N - 2) return 1000;
      const bx = Math.floor(c / 4), bz = Math.floor(r / 4);
      const st = Math.floor(H([bx, bz, 3]) * STYLES.length);
      const hh = Math.round(H([bx, bz, 9]) * 8);
      return st * 100 + hh;
    };
    const visited = new Uint8Array(N * N);
    const buildings = [];
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (!isSolid(c, r) || visited[r * N + c]) continue;
      const k = keyOf(c, r);
      let w = 1;
      while (c + w < N && isSolid(c + w, r) && !visited[r * N + c + w] && keyOf(c + w, r) === k) w++;
      let h = 1;
      outer: while (r + h < N) {
        for (let i = 0; i < w; i++) if (!isSolid(c + i, r + h) || visited[(r + h) * N + c + i] || keyOf(c + i, r + h) !== k) break outer;
        h++;
      }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) visited[(r + j) * N + c + i] = 1;
      const border = k === 1000;
      const style = border ? borderStyle : STYLES[Math.floor(k / 100)];
      const height = border ? borderH : 4.6 + (k % 100) * 0.5;
      const b = { c0: c, r0: r, c1: c + w - 1, r1: r + h - 1, x0: cx0(c), z0: cx0(r), x1: cx0(c + w), z1: cx0(r + h), height, style };
      buildings.push(b);
      solid(b.x0, 0, b.z0, b.x1, height, b.z1, style.mat, { tint: style.tint, topNoAO: true });
    }

    // 建筑立面细节：踢脚、檐口、窗、门
    const rng = (a, b2, c) => Tex.hash2(a * 7 + 13, b2 * 11 + 5, c);
    for (const b of buildings) {
      const sides = [
        { f: 'nz', fixed: b.z0, along: 'x', a0: b.c0, a1: b.c1, out: (i) => [i, b.r0 - 1] },
        { f: 'pz', fixed: b.z1, along: 'x', a0: b.c0, a1: b.c1, out: (i) => [i, b.r1 + 1] },
        { f: 'nx', fixed: b.x0, along: 'z', a0: b.r0, a1: b.r1, out: (i) => [b.c0 - 1, i] },
        { f: 'px', fixed: b.x1, along: 'z', a0: b.r0, a1: b.r1, out: (i) => [b.c1 + 1, i] },
      ];
      const trimMat = windowStyle === 'arctic' ? 'concrete' : windowStyle === 'industrial' ? 'darkmetal' : 'trim';
      const trimTint = windowStyle === 'arctic'
        ? [0.56, 0.66, 0.78]
        : [b.style.tint[0] * 0.92, b.style.tint[1] * 0.9, b.style.tint[2] * 0.88];
      for (const s of sides) {
        const sign = (s.f === 'nz' || s.f === 'nx') ? -1 : 1;
        let i = s.a0;
        while (i <= s.a1) {
          const [oc, orr] = s.out(i);
          if (isSolid(oc, orr)) { i++; continue; }
          let j = i;
          while (j + 1 <= s.a1) { const [c2, r2] = s.out(j + 1); if (isSolid(c2, r2)) break; j++; }
          const p0 = cx0(i), p1 = cx0(j + 1);
          const strip = (y0, y1, depth, mat, tint) => {
            if (s.along === 'x') decor(p0, y0, s.fixed, p1, y1, s.fixed + sign * depth, mat, { tint });
            else decor(s.fixed, y0, p0, s.fixed + sign * depth, y1, p1, mat, { tint });
          };
          strip(0, 0.42, 0.07, trimMat, [trimTint[0] * 0.8, trimTint[1] * 0.8, trimTint[2] * 0.8]);
          strip(b.height - 0.28, b.height, 0.16, trimMat, trimTint);
          strip(b.height - 0.5, b.height - 0.42, 0.07, trimMat, trimTint);
          for (let k = i; k <= j; k++) {
            const c0 = cx0(k) + 0.5, c1 = cx0(k) + 1.5;
            const rr = rng(k, s.f.charCodeAt(1) + b.c0 * 3 + b.r0, 1);
            const box = (u0, u1, y0, y1, d0, d1, mat, tint) => {
              if (s.along === 'x') decor(u0, y0, s.fixed + sign * d0, u1, y1, s.fixed + sign * d1, mat, { tint });
              else decor(s.fixed + sign * d0, y0, u0, s.fixed + sign * d1, y1, u1, mat, { tint });
            };
            const rows = [];
            if (b.height >= 4.6) rows.push(2.7);
            if (b.height >= 7.2) rows.push(5.2);
            for (const wy of rows) {
              if (rng(k, wy * 10 + b.c0, 2) < 0.42) {
                box(c0 - 0.08, c1 + 0.08, wy - 0.1, wy + 1.42, -0.01, 0.07, trimMat, trimTint);
                const shutter = windowStyle === 'mediterranean' && rng(k, wy, 3) < 0.5;
                box(c0, c1, wy, wy + 1.32, -0.01, shutter ? 0.085 : 0.075, shutter ? 'door' : 'glass', [1, 1, 1]);
                box(c0 - 0.12, c1 + 0.12, wy - 0.16, wy - 0.06, -0.01, 0.14, trimMat, trimTint);
              }
            }
            if (rr < 0.13 && j - i >= 1) {
              box(c0 - 0.1, c1 + 0.1, 0, 2.35, -0.01, 0.06, trimMat, trimTint);
              box(c0, c1, 0, 2.25, -0.01, 0.05, windowStyle === 'mediterranean' ? 'door' : 'darkmetal', [1, 1, 1]);
            } else if (rr > 0.9 && b.height > 5) {
              box(c0 + 0.1, c1 - 0.1, 3.6, 4.2, 0, 0.35, 'darkmetal', [0.9, 0.9, 0.88]);
            }
          }
          i = j + 1;
        }
      }
    }

    // ---------------- 地面（按材质合并） ----------------
    const fv = new Uint8Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
      if (isSolid(c, r) || fv[r * N + c]) continue;
      const m = floorMat(c, r);
      let w = 1; while (c + w < N && !isSolid(c + w, r) && !fv[r * N + c + w] && floorMat(c + w, r) === m) w++;
      let h = 1;
      outer2: while (r + h < N) { for (let i = 0; i < w; i++) if (isSolid(c + i, r + h) || fv[(r + h) * N + c + i] || floorMat(c + i, r + h) !== m) break outer2; h++; }
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) fv[(r + j) * N + c + i] = 1;
      solid(cx0(c), -1, cx0(r), cx0(c + w), 0, cx0(r + h), m, { faces: ['py'] });
    }

    // ---------------- 远景建筑轮廓 ----------------
    const skyline = [];
    for (let i = 0; i < 64; i++) {
      const a = i / 64 * Math.PI * 2 + Math.random() * 0.05;
      const r = 58 + Math.random() * 30;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (Math.abs(x) < 50 && Math.abs(z) < 50) continue;
      const w = 6 + Math.random() * 10, d = 6 + Math.random() * 10, h = 9 + Math.random() * 14;
      const st = STYLES[i % STYLES.length];
      decor(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, st.mat, { tint: st.tint, ao: false, cull: false, skipTop: false });
      decor(x - w / 2 - 0.15, h - 0.3, z - d / 2 - 0.15, x + w / 2 + 0.15, h, z + d / 2 + 0.15, mapId === 'frost' ? 'metal' : 'trim', { tint: st.tint, ao: false, cull: false });
      skyline.push({ x, z, h });
    }

    world.build();
    progress && progress(0.55, '烘焙环境光遮蔽');

    // ================= 几何生成 =================
    const batches = {};
    const batch = (k) => batches[k] || (batches[k] = { pos: [], nrm: [], uv: [], col: [], aoF: [], idx: [], n: 0 });
    const splits = (len, step) => { const n = Math.max(1, Math.ceil(len / step - 1e-6)); const s = []; for (let i = 0; i <= n; i++) s.push(len * i / n); return s; };
    const wallSplits = (dv) => { const s = [0]; for (const h of [0.3, 0.8, 1.6, 2.6, 3.8, 5.2, 6.8, 8.5]) if (h < dv - 0.05) s.push(h); s.push(dv); return s; };

    function addFace(key, o, f, du, dv, opt) {
      const B = batch(key);
      const us = splits(du, opt.stepU || 1.0);
      const vs = f.vert ? wallSplits(dv) : splits(dv, opt.stepV || 1.0);
      const vmap = new Map();
      const tint = opt.tint || [1, 1, 1];
      const getV = (i, j) => {
        const k = i * 4096 + j; let id = vmap.get(k); if (id !== undefined) return id;
        const u = us[i], v = vs[j];
        const x = o[0] + f.u[0] * u + f.v[0] * v, y = o[1] + f.u[1] * u + f.v[1] * v, z = o[2] + f.u[2] * u + f.v[2] * v;
        id = B.n++;
        B.pos.push(x, y, z); B.nrm.push(f.n[0], f.n[1], f.n[2]);
        if (FACEUV[key]) B.uv.push(u / du, v / dv);
        else { const s = TEXS[key] || 2; B.uv.push((x * f.u[0] + y * f.u[1] + z * f.u[2]) / s, (x * f.v[0] + y * f.v[1] + z * f.v[2]) / s); }
        B.col.push(tint[0], tint[1], tint[2]);
        B.aoF.push(opt.ao === false ? 0 : 1);
        vmap.set(k, id); return id;
      };
      for (let i = 0; i < us.length - 1; i++) for (let j = 0; j < vs.length - 1; j++) {
        if (opt.cull !== false) {
          const uc = (us[i] + us[i + 1]) / 2, vc = (vs[j] + vs[j + 1]) / 2;
          const px = o[0] + f.u[0] * uc + f.v[0] * vc + f.n[0] * 0.02;
          const py = o[1] + f.u[1] * uc + f.v[1] * vc + f.n[1] * 0.02;
          const pz = o[2] + f.u[2] * uc + f.v[2] * vc + f.n[2] * 0.02;
          if (world.pointSolid(px, py, pz, true)) continue;
        }
        const a = getV(i, j), b2 = getV(i + 1, j), c = getV(i + 1, j + 1), d = getV(i, j + 1);
        B.idx.push(a, b2, c, a, c, d);
      }
    }
    function addTri(key, p0, p1, p2, tint) {
      const B = batch(key);
      const e1 = _v1.subVectors(p1, p0), e2 = _v2.subVectors(p2, p0);
      const n = _v3.crossVectors(e1, e2).normalize();
      const s = TEXS[key] || 2;
      const ax = Math.abs(n.x) > 0.5;
      for (const p of [p0, p1, p2]) {
        B.pos.push(p.x, p.y, p.z); B.nrm.push(n.x, n.y, n.z);
        B.uv.push((ax ? p.z : p.x) / s, p.y / s);
        B.col.push(tint[0], tint[1], tint[2]); B.aoF.push(1);
        B.idx.push(B.n++);
      }
    }

    for (const v of vis) {
      for (const fk of FACE_KEYS) {
        if (v.faces && !v.faces.includes(fk)) continue;
        if (fk === 'py' && v.skipTop) continue;
        if (fk === 'ny' && (v.y0 < 0.05 || v.skipBottom)) continue;
        const f = FACES[fk];
        const key = (fk === 'py' && v.top) ? v.top : v.mat;
        const mn = [v.x0, v.y0, v.z0], mx = [v.x1, v.y1, v.z1], o = [0, 0, 0];
        for (let a = 0; a < 3; a++) {
          if (f.n[a] !== 0) o[a] = f.n[a] > 0 ? mx[a] : mn[a];
          else if (f.u[a] !== 0) o[a] = f.u[a] > 0 ? mn[a] : mx[a];
          else o[a] = f.v[a] > 0 ? mn[a] : mx[a];
        }
        const ua = f.u.findIndex((x) => x !== 0), va = f.v.findIndex((x) => x !== 0);
        const du = mx[ua] - mn[ua], dv = mx[va] - mn[va];
        if (du < 1e-3 || dv < 1e-3) continue;
        const noAO = v.ao === false || (fk === 'py' && v.topNoAO);
        addFace(key, o, f, du, dv, { tint: v.tint, ao: !noAO, cull: v.cull, stepU: noAO ? 8 : 1.0, stepV: noAO ? 8 : 1.0 });
      }
    }
    const rampSideMat = mapId === 'dust' ? 'sandstone' : 'concrete';
    for (const r of props.ramps) {
      const tint = mapId === 'frost' ? [0.88, 0.92, 0.98] : [0.95, 0.92, 0.86];
      let o, u, vdir, du, dv;
      if (r.axis === 'z') {
        const zl = r.rising > 0 ? r.z0 : r.z1, zh = r.rising > 0 ? r.z1 : r.z0;
        const dz = zh - zl, dy = r.y1 - r.y0, L = Math.hypot(dz, dy);
        vdir = [0, dy / L, dz / L];
        u = [-Math.sign(dz) * -1 * 1, 0, 0];
        const cr = [u[1] * vdir[2] - u[2] * vdir[1], u[2] * vdir[0] - u[0] * vdir[2], u[0] * vdir[1] - u[1] * vdir[0]];
        if (cr[1] < 0) u = [-u[0], 0, 0];
        o = [u[0] > 0 ? r.x0 : r.x1, r.y0, zl]; du = r.x1 - r.x0; dv = L;
        const n = [u[1] * vdir[2] - u[2] * vdir[1], u[2] * vdir[0] - u[0] * vdir[2], u[0] * vdir[1] - u[1] * vdir[0]];
        addFace(r.mat, o, { n, u, v: vdir }, du, dv, { tint, cull: true });
        for (const x of [r.x0, r.x1]) {
          const a = new THREE.Vector3(x, r.y0, zl), b2 = new THREE.Vector3(x, r.y1, zh), c = new THREE.Vector3(x, 0, zh);
          if ((x === r.x0) === (dz > 0)) addTri(rampSideMat, a, c, b2, tint); else addTri(rampSideMat, a, b2, c, tint);
        }
      } else {
        const xl = r.rising > 0 ? r.x0 : r.x1, xh = r.rising > 0 ? r.x1 : r.x0;
        const dx = xh - xl, dy = r.y1 - r.y0, L = Math.hypot(dx, dy);
        vdir = [dx / L, dy / L, 0];
        u = [0, 0, 1];
        let n = [u[1] * vdir[2] - u[2] * vdir[1], u[2] * vdir[0] - u[0] * vdir[2], u[0] * vdir[1] - u[1] * vdir[0]];
        if (n[1] < 0) { u = [0, 0, -1]; n = [-n[0], -n[1], -n[2]]; }
        o = [xl, r.y0, u[2] > 0 ? r.z0 : r.z1]; du = r.z1 - r.z0; dv = L;
        addFace(r.mat, o, { n, u, v: vdir }, du, dv, { tint, cull: true });
        for (const z of [r.z0, r.z1]) {
          const a = new THREE.Vector3(xl, r.y0, z), b2 = new THREE.Vector3(xh, r.y1, z), c = new THREE.Vector3(xh, 0, z);
          if ((z === r.z0) === (dx > 0)) addTri(rampSideMat, a, b2, c, tint); else addTri(rampSideMat, a, c, b2, tint);
        }
      }
    }

    // ---------------- 顶点 AO 烘焙 ----------------
    const K = 16, R = 4.0, samples = [];
    for (let i = 0; i < K; i++) { const r = Math.sqrt((i + 0.5) / K), ph = i * 2.399963; samples.push([r * Math.cos(ph), r * Math.sin(ph), Math.sqrt(1 - r * r)]); }
    const hit = {}, cache = new Map();
    const T1 = new THREE.Vector3(), B1 = new THREE.Vector3(), Nn = new THREE.Vector3();
    function aoAt(px, py, pz, nx, ny, nz) {
      const key = Math.round(px * 40) + ',' + Math.round(py * 40) + ',' + Math.round(pz * 40) + ',' + Math.round(nx * 4) + Math.round(ny * 4) + Math.round(nz * 4);
      const c = cache.get(key); if (c !== undefined) return c;
      Nn.set(nx, ny, nz);
      if (Math.abs(ny) < 0.9) T1.crossVectors(UP, Nn).normalize(); else T1.set(1, 0, 0).cross(Nn).normalize();
      B1.crossVectors(Nn, T1);
      const ox = px + nx * 0.04, oy = py + ny * 0.04, oz = pz + nz * 0.04;
      let occ = 0;
      for (const s of samples) {
        const dx = T1.x * s[0] + B1.x * s[1] + nx * s[2], dy = T1.y * s[0] + B1.y * s[1] + ny * s[2], dz = T1.z * s[0] + B1.z * s[1] + nz * s[2];
        const h = world.raycast(ox, oy, oz, dx, dy, dz, R, hit, true);
        if (h) occ += 1 - h.t / R;
      }
      const a = clamp(1 - (occ / K) * 1.45, 0.1, 1);
      cache.set(key, a);
      return a;
    }

    const group = new THREE.Group(); group.name = 'map_' + mapId;
    let totalV = 0;
    for (const k in batches) {
      const B = batches[k];
      if (!B.idx.length) continue;
      const ao = new Float32Array(B.n);
      for (let i = 0; i < B.n; i++) ao[i] = B.aoF[i] ? aoAt(B.pos[i * 3], B.pos[i * 3 + 1], B.pos[i * 3 + 2], B.nrm[i * 3], B.nrm[i * 3 + 1], B.nrm[i * 3 + 2]) : 1;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(B.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(B.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(B.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(B.col, 3));
      g.setAttribute('ao', new THREE.BufferAttribute(ao, 1));
      g.setIndex(B.n > 65535 ? new THREE.Uint32BufferAttribute(B.idx, 1) : new THREE.Uint16BufferAttribute(B.idx, 1));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, M[k] || M.plaster);
      mesh.castShadow = k !== 'sand' && k !== 'snow' && k !== 'asphalt' && k !== 'glass' && k !== 'lamp';
      mesh.receiveShadow = true;
      mesh.name = 'batch_' + k;
      group.add(mesh);
      totalV += B.n;
    }
    scene.add(group);
    progress && progress(0.7, '布置道具');

    // ---------------- 独立道具网格 ----------------
    const P = {
      barrel: trackMat(new THREE.MeshStandardMaterial({ map: T.metal.map, normalMap: T.metal.normalMap, roughnessMap: T.metal.roughnessMap, metalness: 0.45, roughness: 1, envMapIntensity: 0.8 })),
      rubber: trackMat(new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 })),
      rim: trackMat(new THREE.MeshStandardMaterial({ color: 0x777777, roughness: 0.4, metalness: 0.8 })),
      bark: trackMat(new THREE.MeshStandardMaterial({ map: T.beam.map, normalMap: T.beam.normalMap, color: 0xd2b896, roughness: 0.95 })),
      leaf: trackMat(new THREE.MeshStandardMaterial({ map: SP.leaf, alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.75, color: 0xd8e0b0 })),
      wire: trackMat(new THREE.MeshStandardMaterial({ color: 0x0e0e0e, roughness: 0.6 })),
      glow: trackMat(new THREE.MeshBasicMaterial({ color: mapId === 'frost' ? new THREE.Color(2.6, 4.2, 5.2) : mapId === 'harbor' ? new THREE.Color(5, 3.2, 1.8) : new THREE.Color(5, 3.9, 2.4) })),
      rock: trackMat(new THREE.MeshStandardMaterial({
        map: (mapId === 'frost' ? T.snow : T.rock).map,
        normalMap: (mapId === 'frost' ? T.snow : T.rock).normalMap,
        roughness: 1,
        color: mapId === 'frost' ? 0xc0d4e8 : mapId === 'harbor' ? 0x9c8e82 : 0xd9c2a0,
      })),
    };

    if (props.barrels.length) {
      const g = new THREE.CylinderGeometry(0.29, 0.29, 0.9, 20, 1); g.translate(0, 0.45, 0);
      const im = new THREE.InstancedMesh(g, P.barrel, props.barrels.length);
      const m4 = new THREE.Matrix4(), col = new THREE.Color();
      props.barrels.forEach((b, i) => {
        m4.makeRotationY(Math.random() * 6.28); m4.setPosition(b.x, b.y, b.z); im.setMatrixAt(i, m4);
        im.setColorAt(i, col.setRGB(b.color[0] * 1.6, b.color[1] * 1.6, b.color[2] * 1.6));
      });
      im.castShadow = im.receiveShadow = true; group.add(im);
      const rg = new THREE.TorusGeometry(0.295, 0.012, 6, 24); rg.rotateX(Math.PI / 2);
      const rings = new THREE.InstancedMesh(rg, P.rim, props.barrels.length * 2);
      props.barrels.forEach((b, i) => { for (let k = 0; k < 2; k++) { m4.makeTranslation(b.x, b.y + 0.3 + k * 0.3, b.z); rings.setMatrixAt(i * 2 + k, m4); } });
      group.add(rings);
    }
    if (props.wheels.length) {
      const g = new THREE.CylinderGeometry(1, 1, 0.22, 18); g.rotateX(Math.PI / 2);
      const im = new THREE.InstancedMesh(g, P.rubber, props.wheels.length);
      const hub = new THREE.CylinderGeometry(0.55, 0.55, 0.24, 12); hub.rotateX(Math.PI / 2);
      const ih = new THREE.InstancedMesh(hub, P.rim, props.wheels.length);
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
      props.wheels.forEach((w, i) => {
        const r = w.r || 0.33;
        q.setFromAxisAngle(UP, w.rotY); s.set(r, r, 1); p.set(w.x, w.y, w.z);
        m4.compose(p, q, s); im.setMatrixAt(i, m4); ih.setMatrixAt(i, m4);
      });
      im.castShadow = true; group.add(im); group.add(ih);
    }

    const bark = [], leaves = [], wires = [], bulbs = [], shades = [], cords = [];
    const put = (list, geo, pos, quat, rotEuler) => {
      const o = new THREE.Object3D();
      if (pos) o.position.copy(pos);
      if (quat) o.quaternion.copy(quat);
      if (rotEuler) o.rotation.copy(rotEuler);
      o.updateMatrix(); list.push({ geo, matrix: o.matrix.clone() });
    };
    for (const pm of props.palms) {
      const segs = 7, lean = new THREE.Vector3(Math.random() - 0.5, 0, Math.random() - 0.5).normalize().multiplyScalar(0.12);
      let prev = new THREE.Vector3(pm.x, 0, pm.z);
      for (let i = 0; i < segs; i++) {
        const t = (i + 1) / segs;
        const next = new THREE.Vector3(pm.x + lean.x * pm.h * t * t * 4, pm.h * t, pm.z + lean.z * pm.h * t * t * 4);
        const len = prev.distanceTo(next);
        const g = new THREE.CylinderGeometry(0.17 - 0.06 * t, 0.2 - 0.06 * t, len * 1.04, 10);
        put(bark, g, prev.clone().add(next).multiplyScalar(0.5), new THREE.Quaternion().setFromUnitVectors(UP, _v1.subVectors(next, prev).normalize()));
        prev = next;
      }
      const top = prev.clone();
      for (let i = 0; i < 11; i++) {
        const L = 3.2 + Math.random() * 1.2;
        const g = new THREE.PlaneGeometry(1.5, L, 1, 8);
        const pos = g.attributes.position;
        for (let k = 0; k < pos.count; k++) {
          const yy = pos.getY(k) + L / 2;
          const t = yy / L;
          pos.setY(k, yy);
          pos.setZ(k, -Math.pow(t, 2) * L * 0.55 + Math.abs(pos.getX(k)) * 0.25);
          pos.setX(k, pos.getX(k) * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.2))));
        }
        g.computeVertexNormals();
        put(leaves, g, top, null, new THREE.Euler(-0.35 - Math.random() * 0.35, i / 11 * Math.PI * 2 + Math.random() * 0.3, 0, 'YXZ'));
      }
    }
    for (const w of props.wires) {
      const pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16; const p = new THREE.Vector3().lerpVectors(w.a, w.b, t); p.y -= Math.sin(Math.PI * t) * w.sag; pts.push(p); }
      put(wires, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.013, 4, false));
    }
    const bulbG = new THREE.SphereGeometry(0.06, 10, 8), shadeG = new THREE.ConeGeometry(0.16, 0.12, 12, 1, true), cordG = new THREE.CylinderGeometry(0.006, 0.006, 0.3, 4);
    for (const l of props.lamps) {
      put(bulbs, bulbG, new THREE.Vector3(l.x, l.y, l.z));
      put(shades, shadeG, new THREE.Vector3(l.x, l.y + 0.08, l.z));
      put(cords, cordG, new THREE.Vector3(l.x, l.y + 0.28, l.z));
    }
    const addMerged = (list, mat, shadow) => { if (!list.length) return; const m = new THREE.Mesh(Models.mergeGeos(list), mat); m.castShadow = !!shadow; m.receiveShadow = true; group.add(m); };
    addMerged(bark, P.bark, true); addMerged(leaves, P.leaf, true); addMerged(wires, P.wire, true);
    addMerged(bulbs, P.glow, false); addMerged(shades, P.rim, false); addMerged(cords, P.wire, false);

    for (const s of props.signs) {
      const sm = trackMat(new THREE.MeshStandardMaterial({ map: s.tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, roughness: 0.9 }));
      const m = new THREE.Mesh(new THREE.PlaneGeometry(s.s, s.s), sm);
      m.position.set(s.x, s.y, s.z); m.rotation.y = s.ry; m.receiveShadow = true; group.add(m);
    }

    // 远山与远景地面
    {
      const segs = 96, rings = 6;
      const pos = [], uv = [], idx = [];
      for (let j = 0; j <= rings; j++) for (let i = 0; i <= segs; i++) {
        const a = i / segs * Math.PI * 2, t = j / rings;
        const r = 380 + t * 420;
        const n = Tex.fbm(i / segs, t * 0.5, 6, 4, 4242);
        const h = (j === 0 ? -5 : 0) + Math.sin(Math.PI * Math.min(1, t * 1.3)) * (40 + n * 140);
        pos.push(Math.cos(a) * r, h, Math.sin(a) * r); uv.push(i / segs * 24, t * 4);
      }
      for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
        const a = j * (segs + 1) + i, b2 = a + 1, c = a + segs + 1, d = c + 1;
        idx.push(a, c, b2, b2, c, d);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx); g.computeVertexNormals();
      const mt = new THREE.Mesh(g, P.rock); mt.name = 'mountains'; group.add(mt);

      const gg = new THREE.RingGeometry(48, 900, 64, 1); gg.rotateX(-Math.PI / 2);
      const guv = gg.attributes.uv, gp = gg.attributes.position;
      for (let i = 0; i < guv.count; i++) guv.setXY(i, gp.getX(i) / 4, gp.getZ(i) / 4);
      const outerTex = mapId === 'frost' ? T.snow : mapId === 'harbor' ? T.ice : T.sand;
      const outerMat = trackMat(new THREE.MeshStandardMaterial({
        map: outerTex.map,
        normalMap: outerTex.normalMap,
        roughness: mapId === 'harbor' ? 0.22 : 1,
        metalness: mapId === 'harbor' ? 0.35 : 0,
        color: mapId === 'frost' ? 0xdce8f4 : mapId === 'harbor' ? 0x2c4256 : 0xe8dcc8,
      }));
      const ground = new THREE.Mesh(gg, outerMat);
      ground.position.y = -0.02; ground.receiveShadow = true; group.add(ground);
    }

    // ---------------- 雷达图 ----------------
    const RS = 4, RC = document.createElement('canvas'); RC.width = RC.height = 96 * RS;
    {
      const g = RC.getContext('2d');
      g.fillStyle = mapId === 'frost' ? '#141e28' : mapId === 'harbor' ? '#16191e' : '#1b1a18';
      g.fillRect(0, 0, RC.width, RC.height);
      const sorted = world.boxes.slice().sort((a, b2) => a.maxY - b2.maxY);
      for (const b of sorted) {
        if (b.minY > 2.5) continue;
        let col;
        if (b.ramp) col = mapId === 'frost' ? '#8ea6bc' : '#9a8c74';
        else if (b.maxY <= 0.01) {
          col = b.mat === 'snow' ? '#9eb2c4'
            : b.mat === 'ice' ? '#7b99b4'
              : b.mat === 'asphalt' ? '#58606a'
                : b.mat === 'tile' ? '#8f8270'
                  : b.mat === 'concrete' ? '#7e7a72' : '#8a7a62';
        }
        else if (b.maxY <= 1.3 && (b.maxX - b.minX) * (b.maxZ - b.minZ) > 20) col = mapId === 'frost' ? '#aec2d6' : '#a39478';
        else if (b.maxY <= 3.5) col = mapId === 'frost' ? '#3f5060' : '#4e4840';
        else col = mapId === 'frost' ? '#1e2c3a' : '#262420';
        g.fillStyle = col;
        g.fillRect((b.minX - O) * RS, (b.minZ - O) * RS, (b.maxX - b.minX) * RS, (b.maxZ - b.minZ) * RS);
      }
      g.font = 'bold 44px "Inter", "Noto Sans SC", system-ui, sans-serif'; g.fillStyle = 'rgba(255,90,70,0.9)'; g.textAlign = 'center'; g.textBaseline = 'middle';
      const scA = sites.A.center, scB = sites.B.center;
      g.fillText('A', (scA.x - O) * RS, (scA.z - O) * RS);
      g.fillText('B', (scB.x - O) * RS, (scB.z - O) * RS);
    }

    const freeSpawn = (arr) => arr.filter((p) => !world.overlapHull(p.x, p.y + 0.02, p.z, PHYS.hullHalf + 0.1, PHYS.standH));
    spawns.T = freeSpawn(spawns.T);
    spawns.CT = freeSpawn(spawns.CT);

    return {
      id: meta.id,
      name: meta.name,
      en: meta.en,
      desc: meta.desc,
      weather: meta.weather,
      lighting: meta.lighting,
      group,
      materials: M,
      _mats: ownedMats,
      radar: RC,
      radarScale: RS,
      origin: O,
      size: 96,
      spawns,
      points,
      callouts,
      sites,
      buyZones,
      holds,
      routes,
      rangeAnchor,
      rangeSpots,
      skyline,
      verts: totalV,
      inSite(p) {
        for (const k of ['A', 'B']) {
          const s = this.sites[k];
          if (p.x >= s.min[0] && p.x <= s.max[0] && p.z >= s.min[1] && p.z <= s.max[1]) return k;
        }
        return null;
      },
      inBuyZone(team, p) {
        const z = this.buyZones[team];
        return p.x >= z.min[0] && p.x <= z.max[0] && p.z >= z.min[1] && p.z <= z.max[1];
      },
    };
  }

  function dispose(map, scene) {
    if (!map) return;
    if (map.group && scene) scene.remove(map.group);
    if (map.group) {
      map.group.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
    }
    if (Array.isArray(map._mats)) {
      for (const m of map._mats) {
        if (m && m.dispose) m.dispose();
      }
    }
  }

  return { MAPS, build, dispose, injectAO };
})();
