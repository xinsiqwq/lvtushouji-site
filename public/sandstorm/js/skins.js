'use strict';
// ======================================================================
//  skins.js —— 程序化 PBR 武器皮肤系统（9 款高辨识度涂装）
//             零外部图片资产，严格兼容 CSP，支持 1P/3P 与云端联机同步
// ======================================================================
const Skins = (() => {
  const LIST = [
    {
      id: 'default', name: '原厂战术', en: 'Factory Standard', rarity: 'common', rarityLabel: '原厂',
      color: '#8f8a80', swatch: 'linear-gradient(135deg, #2e3136 0%, #5c5850 60%, #8a643c 100%)',
    },
    {
      id: 'asiimov', name: '二西莫夫', en: 'Asiimov', rarity: 'legendary', rarityLabel: '隐秘',
      color: '#ff6f1e', swatch: 'linear-gradient(135deg, #f3f5f8 0%, #f3f5f8 46%, #ff6b1a 46%, #ff6b1a 74%, #1e2229 74%)',
    },
    {
      id: 'fade', name: '渐变之色', en: 'Fade', rarity: 'mythic', rarityLabel: '违禁',
      color: '#ff529c', swatch: 'linear-gradient(135deg, #6b38f5 0%, #e43f94 52%, #ffd24d 100%)',
    },
    {
      id: 'dragon', name: '炽焰龙纹', en: 'Dragon Lore', rarity: 'mythic', rarityLabel: '纪念',
      color: '#ff962e', swatch: 'linear-gradient(135deg, #2c1e0e 0%, #c87b1e 50%, #ff4518 100%)',
    },
    {
      id: 'doppler', name: '多普勒蓝宝石', en: 'Doppler Sapphire', rarity: 'legendary', rarityLabel: '隐秘',
      color: '#3488ff', swatch: 'linear-gradient(135deg, #061840 0%, #1454d8 52%, #44b8ff 100%)',
    },
    {
      id: 'printstream', name: '印花集', en: 'Printstream', rarity: 'epic', rarityLabel: '保密',
      color: '#e8eef8', swatch: 'linear-gradient(135deg, #f4f6fa 0%, #dce4f4 55%, #1b1d22 55%)',
    },
    {
      id: 'cyber', name: '赛博霓虹', en: 'Cyber Neon', rarity: 'epic', rarityLabel: '保密',
      color: '#19e8ff', swatch: 'linear-gradient(135deg, #0d121d 0%, #19e8ff 50%, #ff2eb3 100%)',
    },
    {
      id: 'arctic', name: '极地雪迷彩', en: 'Arctic Frost', rarity: 'rare', rarityLabel: '受限',
      color: '#8ec5ff', swatch: 'linear-gradient(135deg, #eef4fb 0%, #a4bfd8 52%, #405872 100%)',
    },
    {
      id: 'gold', name: '鎏金纪念', en: 'Souvenir Gold', rarity: 'mythic', rarityLabel: '纪念',
      color: '#f2c34d', swatch: 'linear-gradient(135deg, #8b6010 0%, #f5c954 48%, #fff1a8 100%)',
    },
  ];
  const BY_ID = Object.fromEntries(LIST.map((s) => [s.id, s]));
  const MAT_CACHE = {};

  function mkTex(size, draw, srgb = true) {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    draw(g, size, c);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (srgb) t.encoding = THREE.sRGBEncoding;
    return t;
  }

  function buildTextures(id) {
    const S = 256;
    if (id === 'asiimov') {
      const map = mkTex(S, (g, s) => {
        g.fillStyle = '#edf0f4'; g.fillRect(0, 0, s, s);
        g.fillStyle = '#ff6a18';
        g.beginPath(); g.moveTo(0, 24); g.lineTo(148, 24); g.lineTo(106, 98); g.lineTo(0, 98); g.closePath(); g.fill();
        g.beginPath(); g.moveTo(164, 130); g.lineTo(s, 130); g.lineTo(s, 198); g.lineTo(124, 198); g.closePath(); g.fill();
        g.fillStyle = '#1b1d22';
        g.beginPath(); g.moveTo(156, 24); g.lineTo(222, 24); g.lineTo(182, 98); g.lineTo(116, 98); g.closePath(); g.fill();
        g.fillRect(0, 212, s, 44);
        g.strokeStyle = 'rgba(0,0,0,0.22)'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(0, 114); g.lineTo(s, 114); g.stroke();
      });
      return { map, accentColor: 0x1c1e24, metal: 0.18, rough: 0.44 };
    }
    if (id === 'fade') {
      const map = mkTex(S, (g, s) => {
        const gr = g.createLinearGradient(0, 0, s, s);
        gr.addColorStop(0, '#5a2cf5');
        gr.addColorStop(0.42, '#dd2a8d');
        gr.addColorStop(0.76, '#ff7d3b');
        gr.addColorStop(1, '#ffd94f');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
        g.fillStyle = 'rgba(255,255,255,0.06)';
        for (let y = 0; y < s; y += 3) g.fillRect(0, y, s, 1);
      });
      return { map, accentColor: 0x4b2478, metal: 0.9, rough: 0.2 };
    }
    if (id === 'dragon') {
      const map = mkTex(S, (g, s) => {
        const gr = g.createLinearGradient(0, 0, 0, s);
        gr.addColorStop(0, '#c89b3c'); gr.addColorStop(1, '#7c5318');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
        // 鳞片底纹 + 烈焰龙纹线条
        g.strokeStyle = 'rgba(42,20,8,0.42)'; g.lineWidth = 2;
        for (let row = 0; row < 12; row++) {
          for (let col = -1; col < 10; col++) {
            const cx = col * 32 + (row % 2) * 16, cy = row * 24;
            g.beginPath(); g.arc(cx, cy, 16, 0, Math.PI); g.stroke();
          }
        }
        g.fillStyle = '#e83e18';
        g.beginPath(); g.moveTo(16, 170); g.quadraticCurveTo(96, 95, 166, 128); g.quadraticCurveTo(212, 65, 246, 86);
        g.quadraticCurveTo(200, 148, 134, 166); g.quadraticCurveTo(68, 210, 16, 170); g.fill();
        g.strokeStyle = '#ffd15c'; g.lineWidth = 3; g.stroke();
      });
      return { map, accentColor: 0x3b210c, metal: 0.58, rough: 0.34, emissive: 0x3a1204, emissiveIntensity: 0.28 };
    }
    if (id === 'doppler') {
      const map = mkTex(S, (g, s) => {
        const gr = g.createLinearGradient(0, 0, s, s);
        gr.addColorStop(0, '#041438'); gr.addColorStop(0.45, '#1254d8'); gr.addColorStop(1, '#3bc8ff');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
        for (let i = 0; i < 14; i++) {
          g.strokeStyle = i % 2 ? 'rgba(130,225,255,0.22)' : 'rgba(6,18,54,0.34)';
          g.lineWidth = 8 + (i % 4) * 4;
          g.beginPath();
          const y0 = i * 20;
          g.moveTo(-20, y0); g.bezierCurveTo(80, y0 - 30, 170, y0 + 35, s + 20, y0 - 10);
          g.stroke();
        }
      });
      return { map, accentColor: 0x0b2a78, metal: 0.92, rough: 0.16 };
    }
    if (id === 'printstream') {
      const map = mkTex(S, (g, s) => {
        const gr = g.createLinearGradient(0, 0, s, s);
        gr.addColorStop(0, '#f4f6fa'); gr.addColorStop(0.5, '#e7ecf7'); gr.addColorStop(1, '#f6f2f9');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
        g.fillStyle = '#181a1f'; g.fillRect(0, 190, s, 66);
        g.strokeStyle = '#1b1d22'; g.lineWidth = 4;
        for (const [cx, cy] of [[60, 62], [186, 126]]) {
          g.beginPath(); g.moveTo(cx - 12, cy - 12); g.lineTo(cx + 12, cy + 12);
          g.moveTo(cx + 12, cy - 12); g.lineTo(cx - 12, cy + 12); g.stroke();
        }
        g.fillStyle = 'rgba(120,180,255,0.16)';
        g.fillRect(0, 94, s, 10);
      });
      return { map, accentColor: 0x181a1f, metal: 0.25, rough: 0.24 };
    }
    if (id === 'cyber') {
      const map = mkTex(S, (g, s) => {
        g.fillStyle = '#0d111a'; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1;
        for (let i = 0; i < s; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, s); g.stroke(); g.beginPath(); g.moveTo(0, i); g.lineTo(s, i); g.stroke(); }
        g.strokeStyle = '#18e8ff'; g.lineWidth = 3.5;
        g.beginPath(); g.moveTo(0, 64); g.lineTo(92, 64); g.lineTo(128, 100); g.lineTo(s, 100); g.stroke();
        g.strokeStyle = '#ff2eb3'; g.lineWidth = 3;
        g.beginPath(); g.moveTo(0, 168); g.lineTo(116, 168); g.lineTo(154, 130); g.lineTo(s, 130); g.stroke();
      });
      return { map, accentColor: 0x111828, metal: 0.65, rough: 0.28, emissive: 0x0a4458, emissiveMap: map, emissiveIntensity: 0.85 };
    }
    if (id === 'arctic') {
      const map = mkTex(S, (g, s) => {
        g.fillStyle = '#dde7f2'; g.fillRect(0, 0, s, s);
        const cols = ['#a8bfd6', '#566d86', '#f2f7fd'];
        for (let i = 0; i < 26; i++) {
          g.fillStyle = cols[i % cols.length];
          const x = Tex.hash2(i, 1, 71) * s, y = Tex.hash2(i, 2, 71) * s;
          const r = 18 + Tex.hash2(i, 3, 71) * 34;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + r, y + r * 0.4);
          g.lineTo(x + r * 0.3, y + r * 1.1);
          g.closePath();
          g.fill();
        }
      });
      return { map, accentColor: 0x3b4d62, metal: 0.22, rough: 0.56 };
    }
    if (id === 'gold') {
      const map = mkTex(S, (g, s) => {
        const gr = g.createLinearGradient(0, 0, s, s);
        gr.addColorStop(0, '#a87616'); gr.addColorStop(0.5, '#ffd75e'); gr.addColorStop(1, '#c89222');
        g.fillStyle = gr; g.fillRect(0, 0, s, s);
        g.strokeStyle = 'rgba(255,248,200,0.22)'; g.lineWidth = 2;
        for (let y = 0; y < s; y += 6) { g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke(); }
        g.strokeStyle = 'rgba(110,68,6,0.25)'; g.lineWidth = 3;
        g.strokeRect(18, 18, s - 36, s - 36);
      });
      return { map, accentColor: 0x7c5412, metal: 0.96, rough: 0.17 };
    }
    return null;
  }

  function mats(skinId) {
    const id = BY_ID[skinId] ? skinId : 'default';
    if (id === 'default') return null;
    if (MAT_CACHE[id]) return MAT_CACHE[id];
    const spec = buildTextures(id);
    if (!spec) return null;
    const primary = new THREE.MeshStandardMaterial({
      map: spec.map,
      metalness: spec.metal,
      roughness: spec.rough,
      envMapIntensity: spec.metal > 0.7 ? 1.25 : 0.95,
      emissive: spec.emissive || 0x000000,
      emissiveMap: spec.emissiveMap || null,
      emissiveIntensity: spec.emissiveIntensity || 0,
    });
    const accent = new THREE.MeshStandardMaterial({
      color: spec.accentColor,
      metalness: Math.min(0.85, spec.metal + 0.15),
      roughness: Math.max(0.18, spec.rough + 0.1),
      envMapIntensity: 0.85,
    });
    const blade = new THREE.MeshStandardMaterial({
      map: spec.map,
      metalness: Math.max(0.72, spec.metal),
      roughness: Math.min(0.24, spec.rough),
      envMapIntensity: 1.35,
      emissive: spec.emissive || 0x000000,
      emissiveMap: spec.emissiveMap || null,
      emissiveIntensity: spec.emissiveIntensity ? spec.emissiveIntensity * 0.85 : 0,
    });
    return (MAT_CACHE[id] = { primary, accent, blade });
  }

  function normalize(id) { return BY_ID[id] ? id : 'default'; }
  function indexOf(id) { const idx = LIST.findIndex((s) => s.id === id); return idx >= 0 ? idx : 0; }
  function byIndex(idx) { return (LIST[idx] && LIST[idx].id) || 'default'; }
  function forWeapon(wid) {
    const map = Settings.data.skins;
    if (!map || typeof map !== 'object') return 'default';
    return normalize(map[wid] || 'default');
  }
  function setWeapon(wid, skinId) {
    if (!Settings.data.skins || typeof Settings.data.skins !== 'object') Settings.data.skins = {};
    const id = normalize(skinId);
    if (id === 'default') delete Settings.data.skins[wid];
    else Settings.data.skins[wid] = id;
    Settings.save();
    return id;
  }
  function applyAll(skinId, weapons) {
    if (!Settings.data.skins || typeof Settings.data.skins !== 'object') Settings.data.skins = {};
    const id = normalize(skinId);
    for (const w of weapons) {
      if (id === 'default') delete Settings.data.skins[w];
      else Settings.data.skins[w] = id;
    }
    Settings.save();
    return id;
  }

  return { LIST, BY_ID, mats, normalize, indexOf, byIndex, forWeapon, setWeapon, applyAll };
})();
