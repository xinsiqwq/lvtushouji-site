// Independent browser runtime. Stellarium is isolated from the React document.
import createEngine from './vendor/stellarium-web-engine.js';
import { stars, constellations, catalogTranslations } from './catalog.js';

const session = new URLSearchParams(location.search).get('session') || '';
const canvas = document.getElementById('sky');
const status = document.getElementById('status');
const degrees = 180 / Math.PI;
const radians = Math.PI / 180;
const defaultView = { yaw: 180, pitch: 42, fov: 85 };
const nativeRequest = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
const pendingFrames = new Map();
const loadedBaseTiles = new Set();
let nextFrame = 1;
let engine;
let configured = false;
let hostPaused = false;
let paused = true;
let destroyed = false;
let interval;
let requestedSelection;
let lastState = '';
let renderReady = false;
let fontsStarted = false;
let fontsLoaded = false;
const wasmAbort = new AbortController();
let configuration = { constellations: true, labels: true, grid: false, atmosphere: true, ground: true };

const translations = {
  N: '北', E: '东', S: '南', W: '西', NE: '东北', NW: '西北', SE: '东南', SW: '西南',
  North: '北', East: '东', South: '南', West: '西',
  Sun: '太阳', Moon: '月亮', Mercury: '水星', Venus: '金星', Mars: '火星', Jupiter: '木星', Saturn: '土星', Uranus: '天王星', Neptune: '海王星', Pluto: '冥王星',
  Sirius: '天狼星', Vega: '织女星', Altair: '牛郎星', Deneb: '天津四', Betelgeuse: '参宿四', Rigel: '参宿七', Polaris: '北极星', Arcturus: '大角星', Antares: '心宿二', Spica: '角宿一', Procyon: '南河三', Aldebaran: '毕宿五', Capella: '五车二',
  Orion: '猎户座', Hunter: '猎户座', 'Ursa Major': '大熊座', 'Great Bear': '大熊座', 'Ursa Minor': '小熊座', 'Little Bear': '小熊座', Cassiopeia: '仙后座', Queen: '仙后座', Andromeda: '仙女座', 'Chained Princess': '仙女座', Perseus: '英仙座', Hero: '英仙座', Cygnus: '天鹅座', Swan: '天鹅座', Lyra: '天琴座', Lyre: '天琴座', Aquila: '天鹰座', Eagle: '天鹰座', Taurus: '金牛座', Bull: '金牛座', Scorpius: '天蝎座', Scorpion: '天蝎座', Sagittarius: '人马座', Archer: '人马座', Leo: '狮子座', Lion: '狮子座', Gemini: '双子座', Twins: '双子座', Cancer: '巨蟹座', Crab: '巨蟹座', Virgo: '室女座', Virgin: '室女座', Pisces: '双鱼座', Fishes: '双鱼座', Aquarius: '宝瓶座', 'Water Bearer': '宝瓶座', Aries: '白羊座', Ram: '白羊座', Libra: '天秤座', Scales: '天秤座', Capricornus: '摩羯座', 'Sea Goat': '摩羯座', Pegasus: '飞马座', 'Winged Horse': '飞马座', Cepheus: '仙王座', King: '仙王座', Draco: '天龙座', Dragon: '天龙座', 'Canis Major': '大犬座', 'Great Dog': '大犬座', 'Canis Minor': '小犬座', 'Little Dog': '小犬座', Auriga: '御夫座', Charioteer: '御夫座', Bootes: '牧夫座', Herdsman: '牧夫座', Hercules: '武仙座', 'Corona Borealis': '北冕座', 'Northern Crown': '北冕座',
};
const starAliases = { Sirius: 'HIP 32349', Vega: 'HIP 91262', Altair: 'HIP 97649', Deneb: 'HIP 102098', Betelgeuse: 'HIP 27989', Rigel: 'HIP 24436', Polaris: 'HIP 11767', Arcturus: 'HIP 69673', Antares: 'HIP 80763', Spica: 'HIP 65474', Procyon: 'HIP 37279', Aldebaran: 'HIP 21421', Capella: 'HIP 24608' };
const constellationAliases = { Orion: 'Ori', 'Ursa Major': 'UMa', 'Ursa Minor': 'UMi', Cassiopeia: 'Cas', Andromeda: 'And', Perseus: 'Per', Cygnus: 'Cyg', Lyra: 'Lyr', Aquila: 'Aql', Taurus: 'Tau', Scorpius: 'Sco', Sagittarius: 'Sgr', Leo: 'Leo', Gemini: 'Gem', Cancer: 'Cnc', Virgo: 'Vir', Pisces: 'Psc', Aquarius: 'Aqr', Aries: 'Ari', Libra: 'Lib', Capricornus: 'Cap', Pegasus: 'Peg', Cepheus: 'Cep', Draco: 'Dra', 'Canis Major': 'CMa', 'Canis Minor': 'CMi', Auriga: 'Aur', Bootes: 'Boo', Hercules: 'Her', 'Corona Borealis': 'CrB' };
Object.assign(translations, catalogTranslations);
const translationLookup = new Map(Object.entries(translations).map(([key, value]) => [key.toLowerCase(), value]));
const translate = (_domain, text) => translationLookup.get(text.toLowerCase()) || text;
const normalizeAngle = value => ((value % 360) + 360) % 360;
const finite = value => typeof value === 'number' && Number.isFinite(value);

function publish(type, values = {}) {
  if (!destroyed && parent !== window) parent.postMessage({ source: 'travel-sky-engine', session, type, ...values }, location.origin);
}
function reportError(code, message, fatal = false) {
  if (fatal) { status.hidden = false; status.textContent = message; hostPaused = true; updatePause(); }
  publish('error', { error: { code, message }, fatal });
}
function scheduleFrame(id, item) {
  item.nativeId = nativeRequest(time => {
    if (!pendingFrames.has(id)) return;
    item.nativeId = null;
    if (paused || destroyed) return;
    pendingFrames.delete(id);
    item.callback(time);
  });
}
window.requestAnimationFrame = callback => {
  const id = nextFrame++;
  const item = { callback, nativeId: null };
  pendingFrames.set(id, item);
  if (!paused && !destroyed) scheduleFrame(id, item);
  return id;
};
window.cancelAnimationFrame = id => {
  const item = pendingFrames.get(id);
  if (item?.nativeId !== null) nativeCancel(item?.nativeId);
  pendingFrames.delete(id);
};
function updatePause() {
  const next = hostPaused || !configured || document.visibilityState !== 'visible' || destroyed;
  if (next === paused) return;
  paused = next;
  for (const [id, item] of pendingFrames) {
    if (paused) { if (item.nativeId !== null) nativeCancel(item.nativeId); item.nativeId = null; }
    else if (item.nativeId === null) scheduleFrame(id, item);
  }
}

// Count real successful preload responses. Readiness is completed only after a
// rendered engine reports that the actual star progress bar is complete.
const nativeOpen = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(method, url, ...rest) {
  let resource;
  try { resource = new URL(url, location.href); } catch { resource = null; }
  if (resource?.origin === location.origin && /\/data\/stars\/Norder0\/Dir0\/Npix\d+\.eph$/.test(resource.pathname)) {
    this.addEventListener('load', () => {
      if (this.status === 200 && this.response && (this.response.byteLength || this.response.length)) loadedBaseTiles.add(resource.pathname);
    }, { once: true });
  }
  return nativeOpen.call(this, method, url, ...rest);
};

function selectionState() {
  const selected = engine.core.selection;
  if (!selected) { requestedSelection = undefined; return null; }
  const names = selected.designations();
  const identity = requestedSelection?.pointer === selected.v ? requestedSelection : null;
  const id = identity?.id || names.find(name => name.startsWith('HIP ')) || names.find(name => name.startsWith('CON ')) || names.find(name => name.startsWith('NAME ')) || names[0] || String(selected.id);
  const nativeName = names.find(name => name.startsWith('NAME '))?.slice(5) || id;
  const name = identity?.name || translate('sky', nativeName);
  const data = selected.jsonData;
  const kind = data?.model || (id.startsWith('HIP ') ? 'star' : id.startsWith('CON ') ? 'constellation' : 'planet');
  const result = { id, name, kind };
  const magnitude = selected.getInfo('vmag');
  if (finite(magnitude)) result.magnitude = magnitude;
  const direction = selected.getInfo('radec');
  if (Array.isArray(direction)) {
    const radec = engine.c2s(direction);
    const azalt = engine.c2s(engine.convertFrame(engine.observer, 'ICRF', 'OBSERVED', direction));
    if (finite(radec[0]) && finite(radec[1])) { result.ra = normalizeAngle(radec[0] * degrees); result.dec = radec[1] * degrees; }
    if (finite(azalt[0]) && finite(azalt[1])) { result.azimuth = normalizeAngle(azalt[0] * degrees); result.altitude = azalt[1] * degrees; }
  }
  return result;
}
function currentState() {
  const core = engine.core;
  const observer = engine.observer;
  const bars = core.progressbars;
  const starProgress = Array.isArray(bars) ? bars.find(bar => bar.id === 'stars' || bar.label === 'Stars') : null;
  const starsLoaded = loadedBaseTiles.size === 12 && core.fps > 0 && (!starProgress || (starProgress.total > 0 && starProgress.value >= starProgress.total));
  // Once the actual renderer and catalogue are ready, pause/resume preserves readiness.
  if (starsLoaded && fontsLoaded) renderReady = true;
  return {
    lat: observer.latitude * degrees, lng: observer.longitude * degrees,
    date: new Date(Math.round((observer.utc - 40587) * 86400000)).toISOString(),
    yaw: normalizeAngle(observer.yaw * degrees), pitch: observer.pitch * degrees, fov: core.fov * degrees,
    constellations: Boolean(core.constellations.lines_visible), labels: Boolean(core.constellations.labels_visible && core.stars.hints_visible && core.planets.hints_visible),
    grid: Boolean(core.lines.azimuthal.visible), atmosphere: Boolean(core.atmosphere.visible), ground: Boolean(core.landscapes.visible),
    ready: renderReady, starsLoaded, paused, selected: selectionState(),
  };
}
function reportState(force = false, type = 'state') {
  if (!engine || destroyed) return;
  try {
    // core.rend is allocated by the first real core_render call, not onReady.
    if (!fontsStarted && engine.core.fps > 0) {
      fontsStarted = true;
      Promise.all([
        engine.setFont('regular', new URL('./vendor/TravelSkySans-Regular.ttf', location.href).href),
        engine.setFont('bold', new URL('./vendor/TravelSkySans-Semibold.ttf', location.href).href),
      ]).then(() => { fontsLoaded = true; reportState(true); }).catch(error => reportError('font_failed', error.message, true));
    }
    const state = currentState();
    const serialized = JSON.stringify(state);
    if (force || serialized !== lastState) { lastState = serialized; publish(type, { state }); }
    if (state.ready) status.hidden = true;
  } catch (error) { reportError('state_unavailable', error.message, false); }
}
function setView(payload = {}) {
  engine.core.lock = 0;
  if (payload.yaw !== undefined) { if (!finite(payload.yaw)) throw new Error('方位角无效。'); engine.observer.yaw = normalizeAngle(payload.yaw) * radians; }
  if (payload.pitch !== undefined) { if (!finite(payload.pitch)) throw new Error('仰角无效。'); engine.observer.pitch = Math.max(-89, Math.min(89, payload.pitch)) * radians; }
  if (payload.fov !== undefined) { if (!finite(payload.fov)) throw new Error('视野角无效。'); engine.core.fov = Math.max(2, Math.min(150, payload.fov)) * radians; }
}
function configure(payload) {
  if (!finite(payload.lat) || payload.lat < -90 || payload.lat > 90 || !finite(payload.lng) || payload.lng < -180 || payload.lng > 180) throw new Error('观测经纬度无效。');
  if (typeof payload.date !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(payload.date) || !Number.isFinite(Date.parse(payload.date))) throw new Error('观测时间需要有效 ISO 日期。');
  const core = engine.core;
  core.time_speed = 0;
  engine.observer.latitude = payload.lat * radians;
  engine.observer.longitude = payload.lng * radians;
  engine.observer.utc = Date.parse(payload.date) / 86400000 + 40587;
  for (const key of ['constellations', 'labels', 'grid', 'atmosphere', 'ground']) if (typeof payload[key] === 'boolean') configuration[key] = payload[key];
  core.constellations.lines_visible = configuration.constellations;
  core.constellations.labels_visible = configuration.labels;
  core.stars.hints_visible = configuration.labels;
  core.planets.hints_visible = configuration.labels;
  core.lines.azimuthal.visible = configuration.grid;
  core.atmosphere.visible = configuration.atmosphere;
  core.landscapes.visible = configuration.ground;
  core.landscapes.fog_visible = false;
  configured = true;
  updatePause();
}
function resolveIdentifier(value) {
  let id = value.trim();
  const star = stars.find(item => [item.english, `NAME ${item.english}`, item.name, item.id].some(alias => alias.toLowerCase() === id.toLowerCase()));
  if (star) {
    // The bundled entry for delta UMa has its Bayer designation, but no Megrez name.
    const alternatives = { Megrez: ['* del UMa'], Mizar: ['* zet UMa', '* zet01 UMa', '* zet02 UMa'], Alkaid: ['* eta UMa', 'Benetnasch'] };
    return { id: star.id, candidates: [star.id, star.english, `NAME ${star.english}`, ...(alternatives[star.english] || [])], name: star.name };
  }
  if (/^CON\s+/i.test(id)) {
    const name = id.replace(/^CON\s+(?:western\s+)?/i, '');
    const alias = constellations.find(item => [item.english, item.iau, item.name].some(value => value.toLowerCase() === name.toLowerCase()));
    if (alias) return { id: alias.id, candidates: [alias.engineId, alias.id], name: alias.name };
    id = `CON western ${name}`;
  }
  return { id, candidates: [id], name: translate('sky', id.replace(/^NAME\s+/i, '')) };
}
function chooseTarget(payload) {
  if (payload.id === '') { engine.core.selection = 0; engine.core.lock = 0; requestedSelection = undefined; return; }
  if (typeof payload.id !== 'string' || !payload.id.trim() || payload.id.length > 100) throw new Error('天体标识无效。');
  const target = resolveIdentifier(payload.id);
  let object;
  for (const candidate of target.candidates) { object = engine.getObj(candidate); if (object) break; }
  if (!object) { reportError('target_not_found', '在本地星表中没有找到该天体。', false); return; }
  engine.core.selection = object;
  requestedSelection = { pointer: object.v, id: target.id, name: typeof payload.name === 'string' ? payload.name.slice(0, 100) : target.name };
  engine.pointAndLock(object, payload.instant ? 0 : 0.8);
  object.destroy();
}

const commandQueue = [];
function execute(command, payload = {}) {
  if (command === 'pause') { hostPaused = true; updatePause(); reportState(true); return; }
  if (command === 'resume') { hostPaused = false; updatePause(); reportState(true); return; }
  if (!engine) { commandQueue.push({ command, payload }); return; }
  try {
    if (command === 'configure') configure(payload);
    else if (command === 'target') chooseTarget(payload);
    else if (command === 'view') setView(payload);
    else if (command === 'reset') { engine.core.selection = 0; requestedSelection = undefined; setView(defaultView); }
    else { reportError('unknown_command', '星图指令无法识别。', false); return; }
    reportState(true);
  } catch (error) { reportError('invalid_command', error.message, false); }
}
window.addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent || parent === window) return;
  const data = event.data;
  if (!data || data.source !== 'travel-sky-host' || data.session !== session || typeof data.command !== 'string') return;
  if (data.payload !== undefined && (!data.payload || typeof data.payload !== 'object' || Array.isArray(data.payload))) { reportError('invalid_command', '星图参数无效。'); return; }
  execute(data.command, data.payload);
});
document.addEventListener('visibilitychange', updatePause);
canvas.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); publish('close'); return; }
  if (!engine || paused) return;
  const step = event.shiftKey ? 10 : 3;
  const view = {};
  if (event.key === 'ArrowLeft') view.yaw = engine.observer.yaw * degrees - step;
  else if (event.key === 'ArrowRight') view.yaw = engine.observer.yaw * degrees + step;
  else if (event.key === 'ArrowUp') view.pitch = engine.observer.pitch * degrees + step;
  else if (event.key === 'ArrowDown') view.pitch = engine.observer.pitch * degrees - step;
  else if (event.key === '+' || event.key === '=') view.fov = engine.core.fov * degrees / 1.15;
  else if (event.key === '-' || event.key === '_') view.fov = engine.core.fov * degrees * 1.15;
  else return;
  event.preventDefault();
  setView(view);
  reportState(true);
});
// The old engine listens for legacy mousewheel events. Forward modern wheels
// directly so trackpads and contemporary browsers retain the same zoom math.
canvas.addEventListener('wheel', event => {
  if (!engine || paused) return;
  event.preventDefault();
  const rectangle = canvas.getBoundingClientRect();
  const factor = Math.exp(-Math.max(-300, Math.min(300, event.deltaY)) * 0.0015);
  engine._core_on_zoom(factor, event.clientX - rectangle.left, event.clientY - rectangle.top);
}, { passive: false });
canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); reportError('webgl_context_lost', '星图绘制上下文已中断，请重新打开星图。', true); });
window.addEventListener('pagehide', () => {
  destroyed = true;
  wasmAbort.abort();
  updatePause();
  clearInterval(interval);
  pendingFrames.clear();
  const handle = engine?.GL?.currentContext?.handle;
  if (handle) engine.GL.deleteContext(handle);
  engine = undefined;
}, { once: true });
window.addEventListener('unhandledrejection', event => {
  // Unexpected engine faults remain visible to browser diagnostics. Resource
  // bootstrap failures are caught by the controlled loader below.
  reportError('engine_failed', '星图资源加载失败，请重新打开星图。', true);
});

async function bootstrap() {
  try {
    const wasmFile = new URL('./vendor/stellarium-web-engine.wasm', location.href).href;
    // This legacy factory's streaming branch drops its fetch promise. Own the
    // request here, then wasmBinary makes the factory use its non-fetch path.
    const response = await fetch(wasmFile, { credentials: 'same-origin', signal: wasmAbort.signal });
    if (!response.ok) throw new Error('Local WASM response failed.');
    const wasmBinary = new Uint8Array(await response.arrayBuffer());
    if (!WebAssembly.validate(wasmBinary)) throw new Error('Local WASM binary is invalid.');
    if (destroyed) return;
    await createEngine({
      wasmFile,
      wasmBinary,
      canvas,
      translateFn: translate,
      onReady(instance) {
        if (destroyed) return;
        engine = instance;
        const core = engine.core;
        core.time_speed = 0;
        core.constellations.show_only_pointed = false;
        core.constellations.images_visible = false;
        core.constellations.bounds_visible = false;
        core.constellations.illustrations_bscale = 0;
        core.lines.azimuthal.color = [0.49, 0.58, 0.68, 0.35];
        core.lines.equatorial.visible = false;
        core.lines.equatorial_jnow.visible = false;
        setView(defaultView);
        core.stars.addDataSource({ url: new URL('./data/stars', location.href).href });
        core.skycultures.addDataSource({ url: new URL('./data/skycultures/western', location.href).href, key: 'western' });
        core.landscapes.addDataSource({ url: new URL('./data/landscapes/guereins', location.href).href, key: 'guereins' });
        interval = setInterval(() => { if (!paused) reportState(); }, 200);
        reportState(true, 'ready');
        for (const item of commandQueue.splice(0)) execute(item.command, item.payload);
      },
    });
  } catch {
    if (!destroyed) reportError('engine_failed', '星图资源加载失败，请重新打开星图。', true);
  }
}
bootstrap();
