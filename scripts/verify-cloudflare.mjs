import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function parseOriginArg(argv) {
  const idx = argv.indexOf('--origin');
  if (idx !== -1 && argv[idx + 1]) {
    return argv[idx + 1].replace(/\/+$/, '');
  }
  const inline = argv.find((a) => a.startsWith('--origin='));
  if (inline) {
    return inline.slice('--origin='.length).replace(/\/+$/, '');
  }
  return 'https://lvtushouji.xyz';
}

async function fetchWithRetry(url, init = {}, attempts = 3) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(30_000), ...init });
    } catch (err) {
      lastError = err;
      if (i + 1 < attempts) {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  }
  throw lastError;
}

const origin = parseOriginArg(process.argv.slice(2));
const parsedOrigin = new URL(origin);

const PLANET_TEXTURES = [
  'sun.webp',
  'mercury.webp',
  'venus.webp',
  'earth-day.webp',
  'earth-clouds.webp',
  'moon.webp',
  'mars.webp',
  'jupiter.webp',
  'saturn.webp',
  'uranus.webp',
  'neptune.webp',
];

const staticRoutes = [
  '/',
  '/atlas',
  '/observatory',
  '/vault',
  '/admin',
  '/fonts/inter-400.woff2',
  '/fonts/noto-sans-sc-400-core.woff2',
  '/stellarium/vendor/stellarium-web-engine.wasm',
  ...PLANET_TEXTURES.map((name) => `/cosmos/planets/${name}`),
];

const results = [];

// 1. Static SPA routes & assets (all must be 200)
for (const route of staticRoutes) {
  const res = await fetchWithRetry(`${origin}${route}`);
  assert.equal(res.status, 200, `Expected 200 for ${route}, got ${res.status}`);

  if (route === '/') {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', '/ nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN', '/ x-frame-options');
    assert.ok(res.headers.get('content-security-policy'), '/ CSP header present');
  }

  if (route === '/fonts/inter-400.woff2' || route === '/cosmos/planets/earth-day.webp') {
    const cc = res.headers.get('cache-control') || '';
    assert.match(cc, /immutable/i, `${route} expected immutable cache-control, got ${cc}`);
  }

  await res.arrayBuffer();
  results.push({ path: route, status: res.status });
}

// 2. Public API checks
const libraryRes = await fetchWithRetry(`${origin}/api/library`);
assert.equal(libraryRes.status, 200, '/api/library');
assert.equal(libraryRes.headers.get('x-content-type-options'), 'nosniff', '/api/library nosniff');
assert.equal(libraryRes.headers.get('x-frame-options'), 'SAMEORIGIN', '/api/library x-frame-options');
assert.ok(libraryRes.headers.get('content-security-policy'), '/api/library CSP');
const etag = libraryRes.headers.get('etag');
assert.ok(etag, '/api/library ETag missing');
const libraryBody = await libraryRes.json();
assert.equal(libraryBody.access?.role, 'visitor', '/api/library access.role === visitor');
assert.equal(libraryBody.access?.protected, true, '/api/library access.protected === true');
assert.equal(Array.isArray(libraryBody.journeys) && libraryBody.journeys.length, 0, 'prod journeys empty');
assert.equal(Array.isArray(libraryBody.media) && libraryBody.media.length, 0, 'prod media empty');
results.push({ path: '/api/library', status: libraryRes.status, journeys: 0, media: 0 });

const etagRes = await fetchWithRetry(`${origin}/api/library`, {
  headers: { 'If-None-Match': etag },
});
assert.equal(etagRes.status, 304, '/api/library If-None-Match 304');
await etagRes.arrayBuffer();
results.push({ path: '/api/library (If-None-Match)', status: etagRes.status });

const authRes = await fetchWithRetry(`${origin}/api/security/auth`);
assert.equal(authRes.status, 200, '/api/security/auth');
const authBody = await authRes.json();
assert.equal(authBody.authenticated, false, 'visitor unauthenticated');
results.push({ path: '/api/security/auth', status: authRes.status, configured: Boolean(authBody.configured) });

const atlasCfgRes = await fetchWithRetry(`${origin}/api/atlas/config`);
assert.equal(atlasCfgRes.status, 200, '/api/atlas/config');
const atlasCfgBody = await atlasCfgRes.json();
assert.equal(typeof atlasCfgBody.tiandituConfigured, 'boolean', 'tiandituConfigured boolean');
results.push({ path: '/api/atlas/config', status: atlasCfgRes.status, tiandituConfigured: atlasCfgBody.tiandituConfigured });

// 3. Auth-protected & fail-closed routes
const guardedCases = [
  ['/api/admin/usage', 401],
  ['/api/admin/backup', 401],
  ['/api/files/nonexistent-check', 404],
  ['/__setup?token=invalid', 403],
];

for (const [route, expectedStatus] of guardedCases) {
  const res = await fetchWithRetry(`${origin}${route}`);
  assert.equal(res.status, expectedStatus, `Expected ${expectedStatus} for ${route}, got ${res.status}`);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${route} nosniff`);
  await res.arrayBuffer();
  results.push({ path: route, status: res.status });
}

// 4. HTTP -> HTTPS 308 redirect on Worker routes
const httpRes = await fetchWithRetry(`http://${parsedOrigin.host}/api/library`, {
  redirect: 'manual',
});
assert.equal(httpRes.status, 308, `Expected 308 HTTP redirect, got ${httpRes.status}`);
const loc = httpRes.headers.get('location') || '';
assert.ok(loc.startsWith('https://'), `Expected https Location header, got ${loc}`);
await httpRes.arrayBuffer();
results.push({ path: 'http /api/library', status: httpRes.status, location: loc });

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outPath = path.join(repoRoot, '.local-console', 'deployment-check', 'production-checks.json');
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(
  outPath,
  JSON.stringify({ checkedAt: new Date().toISOString(), origin, passed: results.length, results }, null, 2),
);

console.log(JSON.stringify({ origin, passed: results.length, results }, null, 2));
