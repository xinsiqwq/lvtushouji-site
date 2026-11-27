import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Geometry,
  Mesh,
  Program,
  RenderTarget,
  Renderer,
  Sphere,
  Texture,
  Transform,
  Vec2,
  Vec3,
} from 'ogl';
import type { ResolvedScheme } from '../../lib/theme';
import {
  SOLAR_PLANETS,
  computePlanetPosition,
  evaluateOrbitPoint,
  type SolarPlanetSpec,
} from './solar-planets';

type StarRingCanvasProps = {
  paused: boolean;
  theme?: ResolvedScheme;
  resetViewTick?: number;
  onViewModifiedChange?: (modified: boolean) => void;
  onNavigatePlanet: (planet: SolarPlanetSpec) => void;
  onReady?: () => void;
};

const BG_STAR_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute float aSize;
attribute float aSeed;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uPixelRatio;
uniform float uWarpBoost;

varying float vAlpha;
varying float vWarmth;
varying float vLandmark;

void main() {
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = max(8.0, -mvPos.z);
  float twinkle = 0.80 + 0.20 * sin(uTime * 0.9 + aSeed * 56.0);
  vAlpha = clamp(twinkle * (0.48 + 0.52 * aSeed) * (1.0 + uWarpBoost * 0.75), 0.0, 1.0);
  vWarmth = fract(aSeed * 11.73);
  vLandmark = smoothstep(0.955, 0.985, aSeed);
  gl_PointSize = clamp(aSize * uPixelRatio * (235.0 / dist) * (1.0 + uWarpBoost * 0.55), 2.0, 7.2);
}
`;

const BG_STAR_FRAGMENT = /* glsl */ `
precision highp float;

varying float vAlpha;
varying float vWarmth;
varying float vLandmark;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float core = exp(-r * r * 3.8) * 1.0;
  float halo = exp(-r * r * 1.9) * 0.34;
  float spikes = (
    exp(-abs(uv.x) * 24.0) * exp(-abs(uv.y) * 4.5) +
    exp(-abs(uv.y) * 24.0) * exp(-abs(uv.x) * 4.5)
  ) * vLandmark * 0.56;

  vec3 obBlue = vec3(0.62, 0.78, 1.00);
  vec3 afWhite = vec3(0.96, 0.98, 1.00);
  vec3 gCream = vec3(1.00, 0.90, 0.74);
  vec3 kmAmber = vec3(1.00, 0.74, 0.52);

  vec3 col = mix(obBlue, afWhite, smoothstep(0.0, 0.35, vWarmth));
  col = mix(col, gCream, smoothstep(0.45, 0.78, vWarmth));
  col = mix(col, kmAmber, smoothstep(0.80, 1.0, vWarmth));

  float alpha = clamp((core + halo + spikes) * vAlpha * 0.95, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
}
`;

const SKY_DOME_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vSkyDir;

void main() {
  vSkyDir = normalize(position);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SKY_DOME_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uNoiseTex;
uniform float uTime;
uniform float uWarpBoost;

varying vec3 vSkyDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  vec3 dir = normalize(vSkyDir);
  // Astronaut EVA ultra-clean abyssal black void (#04060A) + unmistakable counter-diagonal rifted Milky Way ribbon
  float elev = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  float sunWarm = pow(clamp(dot(dir, normalize(vec3(-0.35, 0.08, -0.93))), 0.0, 1.0), 3.0);
  vec3 voidBase = mix(vec3(0.0012, 0.0017, 0.0032), vec3(0.0032, 0.0048, 0.0082), elev * 0.72);
  vec3 col = voidBase + vec3(0.004, 0.0035, 0.0025) * sunWarm * 0.45;

  // Counter-diagonal ~60-deg galactic plane rising from lower-left-center toward upper-right
  vec3 sFwdM = normalize(vec3(0.08, -0.34, -0.935));
  vec3 sUpRefM = normalize(vec3(-0.14, 0.99, 0.0));
  vec3 sRightM = normalize(cross(sFwdM, sUpRefM));
  vec3 sUpM = cross(sRightM, sFwdM);
  vec3 gUp = normalize(-sRightM * 0.55 + sUpM * 0.83 - sFwdM * 0.05);
  vec3 gRight = normalize(cross(vec3(0.0, 1.0, 0.0), gUp));
  vec3 gFwd = cross(gUp, gRight);

  float gLat = dot(dir, gUp);
  float gLon = atan(dot(dir, gFwd), dot(dir, gRight));

  // Isotropic angular noise UV (integer tile multiples preserve 2*PI wrap seam with 1:1 cloud aspect ratio)
  vec2 mwUv = vec2(gLon * 0.1591549 + 0.5, gLat * 0.1591549 + 0.5);
  float nCoarse = texture2D(uNoiseTex, mwUv * 3.0 + vec2(0.14, 0.08)).r;
  float nCloud = texture2D(uNoiseTex, mwUv * 7.0 + vec2(0.42, 0.27)).g;
  float nRift = texture2D(uNoiseTex, mwUv * 5.0 + vec2(0.68, 0.51)).b;
  float nFine = texture2D(uNoiseTex, mwUv * 13.0 + vec2(0.19, 0.73)).a;

  // Warp galactic latitude organically so starclouds & Great Rift meander instead of forming straight streaks
  float gLatWarped = gLat + (nCoarse - 0.5) * 0.075 + (nCloud - 0.5) * 0.035;
  float outerVeil = exp(-gLat * gLat * 24.0);
  float coreBand = exp(-gLatWarped * gLatWarped * 68.0);

  // Organic meandering Great Rift dark dust clouds
  float riftOffset = (nCoarse - 0.5) * 0.065 + (nRift - 0.5) * 0.055;
  float riftBand = exp(-pow((gLat + riftOffset) * 26.0, 2.0));
  float riftMask = riftBand * smoothstep(0.32, 0.74, nRift * 0.62 + nCloud * 0.38);

  float denom = max(0.35, 1.0 + dot(dir, sFwdM));
  vec2 proj = vec2(dot(dir, sRightM), dot(dir, sUpM)) / denom;

  vec3 mwCool = vec3(0.022, 0.036, 0.072);
  vec3 mwWarm = vec3(0.072, 0.058, 0.068);
  float coreWarmth = smoothstep(-0.08, 0.32, proj.x + proj.y * 0.55) * smoothstep(0.36, 0.78, nCoarse);

  float cloudLobes = coreBand * smoothstep(0.22, 0.86, nCoarse * 0.52 + nCloud * 0.34 + nFine * 0.14);
  cloudLobes *= (1.0 - 0.82 * riftMask);
  vec3 mwColor = mix(mwCool, mwWarm, coreWarmth) * cloudLobes * 0.52 + vec3(0.005, 0.009, 0.020) * outerVeil * (0.35 + 0.65 * nCoarse);

  float cornerCalm = smoothstep(-0.22, -0.02, proj.x) + smoothstep(-0.16, 0.02, proj.y);
  float mwCalm = mix(0.20, 1.0, clamp(cornerCalm, 0.0, 1.0));
  col += mwColor * mwCalm;

  col *= 1.0 + uWarpBoost * 0.22 + 0.010 * sin(uTime * 0.18);
  vec3 aces = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  vec3 tone = pow(max(aces, vec3(0.0001)), vec3(1.0 / 2.2));
  tone += (hash12(gl_FragCoord.xy) - 0.5) * (1.2 / 255.0);
  gl_FragColor = vec4(clamp(tone, 0.0, 1.0), 1.0);
}
`;

const NOISE_GLSL = /* glsl */ `
vec4 mod289_4(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 mod289_3(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute_4(vec4 x) { return mod289_4(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

float snoise3(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289_3(i);
  vec4 p = permute_4(
    permute_4(
      permute_4(i.z + vec4(0.0, i1.z, i2.z, 1.0)) +
      i.y + vec4(0.0, i1.y, i2.y, 1.0)
    ) +
    i.x + vec4(0.0, i1.x, i2.x, 1.0)
  );
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}

float fbm3(vec3 p) {
  float value = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 4; i++) {
    value += amp * (snoise3(p) * 0.5 + 0.5);
    p = p * 2.08 + vec3(7.3, -4.1, 5.9);
    amp *= 0.5;
  }
  return value;
}

float fbm3_3(vec3 p) {
  float value = 0.0;
  float amp = 0.52;
  for (int i = 0; i < 3; i++) {
    value += amp * (snoise3(p) * 0.5 + 0.5);
    p = p * 2.08 + vec3(7.3, -4.1, 5.9);
    amp *= 0.48;
  }
  return value;
}

float fbm2(vec3 p) {
  float n0 = snoise3(p) * 0.5 + 0.5;
  float n1 = snoise3(p * 2.12 + vec3(7.3, -4.1, 5.9)) * 0.5 + 0.5;
  return n0 * 0.66 + n1 * 0.34;
}

vec3 acesFilmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}
`;

const SUN_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vLocalDir;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vLocalDir = normalize(position);
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const SUN_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 cameraPosition;
uniform float uTime;

varying vec3 vLocalDir;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
${NOISE_GLSL}

void main() {
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndv = clamp(dot(N, V), 0.0, 1.0);

  vec3 d = normalize(vLocalDir);
  float t = uTime * 0.09;
  float granLarge = fbm3_3(d * 4.8 + vec3(t, -t * 0.6, t * 0.4));
  float granFine = fbm2(d * 13.5 - vec3(t * 1.4, t * 0.8, -t));
  float plasma = granLarge * 0.62 + granFine * 0.38;

  // Cooler magnetic sunspot regions
  float spotNoise = snoise3(d * 3.1 + vec3(-t * 0.25, t * 0.18, 0.0));
  float spot = smoothstep(0.58, 0.78, spotNoise);

  // Solar limb darkening + hot incandescent chromosphere rim
  float limb = pow(ndv, 0.42);
  float rim = pow(1.0 - ndv, 3.0);

  vec3 darkCell = vec3(1.05, 0.38, 0.05);
  vec3 photosphere = vec3(1.92, 1.08, 0.26);
  vec3 brightFacula = vec3(2.85, 2.35, 1.48);

  vec3 col = mix(darkCell, photosphere, smoothstep(0.24, 0.66, plasma));
  col = mix(col, brightFacula, smoothstep(0.62, 0.90, plasma));
  col = mix(col, vec3(0.42, 0.14, 0.03), spot * 0.58);
  col *= 0.55 + 0.68 * limb;
  col += vec3(1.75, 0.62, 0.12) * rim * 0.85;

  gl_FragColor = vec4(pow(acesFilmic(col), vec3(0.90)), 1.0);
}
`;

const CORONA_HALF_EXTENT = 7.4;

const CORONA_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec2 vQuad;

void main() {
  vQuad = position / ${CORONA_HALF_EXTENT.toFixed(1)};
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 0.0, 1.0);
}
`;

const CORONA_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uTime;
varying vec2 vQuad;

void main() {
  float r = length(vQuad);
  if (r > 1.0) discard;

  // Normalized sun photosphere radius in quad space = 1.38 / 7.4 = 0.1865
  float dEdge = max(0.0, r - 0.184);
  float glowTight = exp(-dEdge * 19.0) * 1.35;
  float glowMid = exp(-dEdge * 6.2) * 0.52;
  float glowOuter = exp(-r * r * 4.2) * 0.20;

  // Delicate rotating coronal streamer rays
  float theta = atan(vQuad.y, vQuad.x);
  float rayA = 0.5 + 0.5 * sin(theta * 7.0 + uTime * 0.16);
  float rayB = 0.5 + 0.5 * cos(theta * 13.0 - uTime * 0.11 + 1.4);
  float rayC = 0.5 + 0.5 * sin(theta * 3.0 - uTime * 0.07 + 0.6);
  float rays = (pow(rayA, 3.0) * 0.50 + pow(rayB, 4.0) * 0.30 + pow(rayC, 2.0) * 0.20) * exp(-dEdge * 6.4) * 0.32;

  // Restrained horizontal anamorphic shimmer
  float anamorphic = exp(-abs(vQuad.y) * 30.0) * exp(-abs(vQuad.x) * 3.2) * 0.16;

  float intensity = (glowTight + glowMid + glowOuter + rays + anamorphic) * smoothstep(1.0, 0.38, r);
  vec3 col = mix(vec3(1.00, 0.54, 0.16), vec3(1.00, 0.92, 0.72), exp(-dEdge * 13.0));
  gl_FragColor = vec4(col, clamp(intensity, 0.0, 0.98));
}
`;

const PLANET_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uOblateY;

varying vec2 vUv;
varying vec3 vLocalDir;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalSunDir;
varying vec3 vWorldTu;
varying vec3 vWorldTv;

void main() {
  vec3 scaled = vec3(position.x, position.y * uOblateY, position.z);
  vec3 adjNorm = normalize(vec3(normal.x, normal.y / max(0.5, uOblateY), normal.z));
  vec3 localN = normalize(position);
  vec3 tU = length(localN.xz) > 0.001 ? normalize(vec3(localN.z, 0.0, -localN.x)) : vec3(1.0, 0.0, 0.0);
  vec3 tV = normalize(cross(localN, tU));

  vUv = uv;
  vLocalDir = localN;
  vec4 world = modelMatrix * vec4(scaled, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(adjNorm, 0.0)).xyz);
  vWorldTu = normalize((modelMatrix * vec4(tU, 0.0)).xyz);
  vWorldTv = normalize((modelMatrix * vec4(tV, 0.0)).xyz);

  vec3 sunDirWorld = normalize(-world.xyz);
  vLocalSunDir = normalize((vec4(sunDirWorld, 0.0) * modelMatrix).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(scaled, 1.0);
}
`;

const PLANET_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 cameraPosition;
uniform sampler2D uAlbedoTex;
uniform sampler2D uCloudTex;
uniform sampler2D uNightTex;
uniform float uTime;
uniform float uPlanetKind; // 0:Mercury, 1:Venus, 2:Earth, 3:Mars, 4:Jupiter, 5:Saturn, 6:Uranus, 7:Neptune, 8:Moon
uniform float uHover;
uniform float uHasRings;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform vec3 uRingNormal;
uniform float uRingInner;
uniform float uRingOuter;

varying vec2 vUv;
varying vec3 vLocalDir;
varying vec3 vWorldPos;
varying vec3 vWorldNormal;
varying vec3 vLocalSunDir;
varying vec3 vWorldTu;
varying vec3 vWorldTv;

vec3 acesFilmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

// Concentric Cassini / Encke ring optical density shared with ring shader
float saturnRingDensity(float rNorm) {
  if (rNorm < uRingInner || rNorm > uRingOuter) return 0.0;
  float span = (rNorm - uRingInner) / max(0.01, uRingOuter - uRingInner);
  float cRing = smoothstep(0.0, 0.08, span) * (1.0 - smoothstep(0.20, 0.25, span)) * 0.26;
  float bRing = smoothstep(0.22, 0.28, span) * (1.0 - smoothstep(0.56, 0.60, span)) * 0.92;
  float aRing = smoothstep(0.65, 0.69, span) * (1.0 - smoothstep(0.95, 1.0, span)) * 0.68;
  float cassini = 1.0 - 0.94 * exp(-pow((span - 0.615) * 32.0, 2.0));
  float encke = 1.0 - 0.72 * exp(-pow((span - 0.875) * 58.0, 2.0));
  float fine = 0.78 + 0.22 * sin(span * 115.0) * cos(span * 43.0);
  return clamp((cRing + bRing + aRing) * cassini * encke * fine, 0.0, 0.95);
}

void main() {
  vec3 Ngeom = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(-vWorldPos);
  vec3 d = normalize(vLocalDir);

  float ndlGeom = dot(Ngeom, L);
  float ndv = clamp(dot(Ngeom, V), 0.0, 1.0);
  float fresnel = pow(1.0 - ndv, 3.2);

  // UV offset for slow super-rotating Venus atmosphere
  vec2 mainUv = uPlanetKind > 0.5 && uPlanetKind < 1.5
    ? vec2(fract(vUv.x + uTime * 0.0025), vUv.y)
    : vUv;

  vec3 texSrgb = texture2D(uAlbedoTex, mainUv).rgb;
  vec3 texLin = pow(max(texSrgb, vec3(0.0001)), vec3(2.2));

  // Earth water/land mask derived directly from NASA Blue Marble ocean chroma
  float isEarth = (uPlanetKind > 1.5 && uPlanetKind < 2.5) ? 1.0 : 0.0;
  float isRocky = (uPlanetKind < 0.5 || (uPlanetKind > 2.5 && uPlanetKind < 3.5) || uPlanetKind > 7.5) ? 1.0 : 0.0;
  float oceanChroma = smoothstep(0.025, 0.11, texSrgb.b - max(texSrgb.r * 1.15, texSrgb.g * 0.92));
  float nonIce = 1.0 - smoothstep(0.55, 0.78, min(texSrgb.r, min(texSrgb.g, texSrgb.b)));
  float waterMask = isEarth * clamp(oceanChroma * nonIce, 0.0, 1.0);
  float landMask = isEarth * (1.0 - waterMask);

  // Fast 3-tap micro-relief bump from texture luminance on sunlit rocky terrain & Earth continents
  vec3 N = Ngeom;
  float reliefWeight = max(isRocky, landMask);
  if (reliefWeight > 0.05 && ndlGeom > -0.14) {
    float du = 0.0012;
    float dv = 0.0024;
    float h0 = dot(texSrgb, vec3(0.299, 0.587, 0.114));
    float hU = dot(texture2D(uAlbedoTex, mainUv + vec2(du, 0.0)).rgb, vec3(0.299, 0.587, 0.114));
    float hV = dot(texture2D(uAlbedoTex, mainUv + vec2(0.0, dv)).rgb, vec3(0.299, 0.587, 0.114));
    float amp = (uPlanetKind < 0.5 || uPlanetKind > 7.5) ? 0.58 : (uPlanetKind > 2.5 && uPlanetKind < 3.5) ? 0.44 : 0.24;
    amp *= reliefWeight * (1.0 - waterMask);
    N = normalize(Ngeom - (vWorldTu * (hU - h0) + vWorldTv * (hV - h0)) * (amp * 3.8));
  }

  float ndlRaw = dot(N, L);
  float terminatorMask = smoothstep(-0.11, 0.13, ndlGeom);
  float diffuse = terminatorMask * max(0.0, ndlRaw * 0.94 + 0.06);
  float terminatorTwilight = exp(-pow((ndlGeom - 0.01) * 7.6, 2.0));

  // Real-time 2-sample soft penumbra ring shadow projected onto Saturn's cloud deck
  float ringShadow = 1.0;
  float ringShineBounce = 0.0;
  if (uHasRings > 0.5) {
    ringShineBounce = (1.0 - smoothstep(-0.15, 0.35, ndlGeom)) * (0.25 + 0.75 * abs(d.y));
    if (ndlGeom > -0.06) {
      float denom = dot(L, uRingNormal);
      if (abs(denom) > 0.002) {
        float tHit = dot(uPlanetCenter - vWorldPos, uRingNormal) / denom;
        if (tHit > 0.0) {
          vec3 hitPt = vWorldPos + L * tHit;
          float hitR = length(hitPt - uPlanetCenter) / max(0.01, uPlanetRadius);
          float densA = saturnRingDensity(hitR - 0.035);
          float densB = saturnRingDensity(hitR + 0.035);
          ringShadow = 1.0 - ((densA + densB) * 0.5) * 0.80;
        }
      }
    }
  }

  vec3 albedo = texLin;
  vec3 atmoTint = vec3(0.4, 0.7, 1.0);
  vec3 twilightTint = vec3(0.96, 0.54, 0.28);
  float atmoStrength = 0.0;
  float specMask = 0.0;
  float roughness = 0.24;
  vec3 nightCityGlow = vec3(0.0);

  if (uPlanetKind < 0.5 || uPlanetKind > 7.5) {
    // 0 = Mercury, 8 = Moon
    albedo = texLin * 1.08;
    atmoStrength = 0.0;
  } else if (uPlanetKind < 1.5) {
    // 1 = Venus
    albedo = texLin * vec3(1.06, 1.01, 0.94);
    atmoTint = vec3(1.00, 0.86, 0.58);
    atmoStrength = 0.58;
  } else if (uPlanetKind < 2.5) {
    // 2 = Earth: 2K Blue Marble + drifting 2K clouds + cloud shadows + GGX ocean glint + Black Marble cities
    float cloudShiftU = uTime * 0.0042;
    vec2 cloudUv = vec2(fract(vUv.x - cloudShiftU), vUv.y);
    float cloudVal = texture2D(uCloudTex, cloudUv).r;
    float cloudAlpha = smoothstep(0.11, 0.86, cloudVal);

    float duSun = dot(L, vWorldTu) * 0.0048;
    float dvSun = dot(L, vWorldTv) * 0.0048;
    float cloudShadVal = texture2D(uCloudTex, vec2(fract(cloudUv.x + duSun), clamp(cloudUv.y + dvSun, 0.002, 0.998))).r;
    float cloudShadow = smoothstep(0.18, 0.85, cloudShadVal) * (1.0 - cloudAlpha * 0.65);

    vec3 surfaceShaded = texLin * vec3(0.96, 1.02, 1.08);
    surfaceShaded = mix(surfaceShaded * 1.05, surfaceShaded * vec3(0.84, 0.96, 1.12), waterMask * 0.55);
    surfaceShaded *= (1.0 - cloudShadow * 0.44);

    albedo = mix(surfaceShaded, vec3(0.98, 0.99, 1.00), cloudAlpha * 0.90);
    specMask = waterMask * (1.0 - cloudAlpha * 0.92) * 0.85;
    roughness = 0.16;
    atmoTint = vec3(0.32, 0.67, 1.00);
    atmoStrength = 0.82;

    // NASA Black Marble city clusters along dark hemisphere
    vec3 nightSrgb = texture2D(uNightTex, vUv).rgb;
    vec3 nightLin = pow(max(nightSrgb, vec3(0.0001)), vec3(1.8));
    float nightFactor = smoothstep(0.05, -0.22, ndlGeom);
    nightCityGlow = nightLin * vec3(1.42, 1.05, 0.68) * nightFactor * (1.0 - cloudAlpha * 0.68) * 1.15;
  } else if (uPlanetKind < 3.5) {
    // 3 = Mars
    albedo = texLin * vec3(1.24, 1.04, 0.94);
    atmoTint = vec3(0.95, 0.56, 0.36);
    atmoStrength = 0.34;
  } else if (uPlanetKind < 4.5) {
    // 4 = Jupiter
    albedo = texLin * 1.22;
    atmoTint = vec3(0.94, 0.82, 0.65);
    atmoStrength = 0.28;
  } else if (uPlanetKind < 5.5) {
    // 5 = Saturn
    albedo = texLin * 1.12;
    atmoTint = vec3(0.95, 0.86, 0.66);
    atmoStrength = 0.28;
  } else if (uPlanetKind < 6.5) {
    // 6 = Uranus
    albedo = texLin * vec3(0.96, 1.04, 1.06);
    atmoTint = vec3(0.62, 0.93, 0.98);
    atmoStrength = 0.56;
  } else {
    // 7 = Neptune
    albedo = texLin * vec3(0.94, 1.00, 1.12);
    atmoTint = vec3(0.34, 0.64, 1.00);
    atmoStrength = 0.66;
  }

  // Tight Fresnel GGX ocean sun-glint
  vec3 H = normalize(L + V);
  float ndh = max(0.0, dot(N, H));
  float a2 = roughness * roughness;
  float denomGgx = ndh * ndh * (a2 - 1.0) + 1.0;
  float specular = (a2 / (3.14159 * denomGgx * denomGgx + 0.001)) * 0.14 * specMask * ringShadow * terminatorMask;

  float solarLight = diffuse * ringShadow;
  vec3 lit = albedo * (solarLight * 1.48 + 0.0055);
  lit += vec3(1.0, 0.97, 0.90) * specular;
  lit += vec3(0.76, 0.66, 0.50) * ringShineBounce * 0.048;

  // Sunset/sunrise Rayleigh atmospheric rim (strictly grazing limb — no central terminator haze stripe)
  vec3 atmoRimCol = mix(atmoTint, twilightTint, terminatorTwilight * 0.42 * (uPlanetKind > 1.5 && uPlanetKind < 3.5 ? 1.0 : 0.35));
  vec3 atmoGlow = atmoRimCol * (
    fresnel * atmoStrength * smoothstep(-0.34, 0.46, ndlGeom) +
    terminatorTwilight * atmoStrength * (0.04 + 0.24 * fresnel)
  );
  lit += atmoGlow;

  // Night city lights on Earth
  lit += nightCityGlow * 1.65;

  // Responsive rim highlight on hover
  lit += mix(atmoTint, vec3(0.54, 0.71, 0.97), 0.5) * fresnel * uHover * 0.78;

  // Linear -> ACES Filmic -> sRGB gamma
  gl_FragColor = vec4(pow(max(acesFilmic(lit), vec3(0.0001)), vec3(1.0 / 2.2)), 1.0);
}
`;

// Back-face outer 3D Rayleigh/Mie atmospheric scattering shell extending outside solid planet silhouette
const ATMOS_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec3 normal;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uOblateY;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  vec3 scaled = vec3(position.x, position.y * uOblateY, position.z);
  vec3 adjNorm = normalize(vec3(normal.x, normal.y / max(0.5, uOblateY), normal.z));
  vec4 world = modelMatrix * vec4(scaled, 1.0);
  vWorldPos = world.xyz;
  vWorldNormal = normalize((modelMatrix * vec4(adjNorm, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(scaled, 1.0);
}
`;

const ATMOS_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 cameraPosition;
uniform vec3 uAtmoColor;
uniform float uAtmoDensity;
uniform float uHover;

varying vec3 vWorldPos;
varying vec3 vWorldNormal;

void main() {
  // Back-face normal points away from camera on the shell exterior;
  // abs(dot(N, V)) = 0 at the outer atmosphere clip edge -> must decay smoothly to 0!
  vec3 N = normalize(vWorldNormal);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 L = normalize(-vWorldPos);

  float rimDepth = clamp(abs(dot(N, V)) / 0.44, 0.0, 1.0);
  float glowProfile = pow(rimDepth, 2.35);
  float sunWrap = smoothstep(-0.32, 0.52, dot(N, L));
  float forwardScatter = pow(max(0.0, dot(V, -L)), 3.0) * 0.45;

  float alpha = glowProfile * (sunWrap * 0.85 + forwardScatter + uHover * 0.28) * uAtmoDensity;
  vec3 col = uAtmoColor + vec3(0.30, 0.55, 0.90) * (uHover * 0.22);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 0.72));
}
`;

const RING_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vWorldPos;
varying vec2 vPolar; // radial norm in planet-radius multiples

void main() {
  vPolar = uv;
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const RING_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 cameraPosition;
uniform vec3 uPlanetCenter;
uniform float uPlanetRadius;
uniform float uRingInner;
uniform float uRingOuter;
uniform float uRingKind; // 0: Saturn multi-band rings, 1: Uranus narrow hairline ring
uniform float uHover;

varying vec3 vWorldPos;
varying vec2 vPolar;

void main() {
  float rRatio = length(vWorldPos - uPlanetCenter) / max(0.01, uPlanetRadius);
  if (rRatio < uRingInner || rRatio > uRingOuter) discard;

  float span = clamp((rRatio - uRingInner) / max(0.01, uRingOuter - uRingInner), 0.0, 1.0);

  vec3 ringCol;
  float density;
  if (uRingKind < 0.5) {
    // Saturn: C ring (faint dusky interior), B ring (bright cream-gold), Cassini gap, A ring + Encke gap
    float cRing = smoothstep(0.0, 0.07, span) * (1.0 - smoothstep(0.20, 0.24, span)) * 0.24;
    float bRing = smoothstep(0.22, 0.27, span) * (1.0 - smoothstep(0.56, 0.60, span)) * 0.88;
    float aRing = smoothstep(0.65, 0.69, span) * (1.0 - smoothstep(0.95, 1.0, span)) * 0.64;
    float cassini = 1.0 - 0.94 * exp(-pow((span - 0.615) * 32.0, 2.0));
    float encke = 1.0 - 0.74 * exp(-pow((span - 0.875) * 58.0, 2.0));
    float ringlets = 0.78 + 0.22 * sin(span * 118.0) * cos(span * 47.0);
    density = clamp((cRing + bRing + aRing) * cassini * encke * ringlets, 0.0, 0.92);

    vec3 innerTint = vec3(0.58, 0.53, 0.48);
    vec3 bTint = vec3(0.91, 0.83, 0.69);
    vec3 aTint = vec3(0.78, 0.73, 0.65);
    ringCol = mix(innerTint, bTint, smoothstep(0.18, 0.35, span));
    ringCol = mix(ringCol, aTint, smoothstep(0.60, 0.74, span));
  } else {
    // Uranus epsilon ringlet profile
    float epsilon = exp(-pow((span - 0.68) * 10.0, 2.0)) * 0.55;
    float innerDust = exp(-pow((span - 0.30) * 8.0, 2.0)) * 0.24;
    density = clamp(epsilon + innerDust, 0.0, 0.65);
    ringCol = vec3(0.56, 0.76, 0.84);
  }

  // Finite-Sun-radius angular eclipse penumbra + warm atmospheric refraction rim + icy phase scatter
  vec3 L = normalize(-vWorldPos);
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 oc = vWorldPos - uPlanetCenter;
  float proj = dot(-oc, L);
  float sunVis = 1.0;
  float eclipseEdge = 0.0;
  if (proj > 0.0) {
    float distSq = max(0.0, dot(oc, oc) - proj * proj);
    float penumbra = 0.085 + 0.025 * proj;
    sunVis = smoothstep(uPlanetRadius * 0.89 - penumbra, uPlanetRadius * 0.98 + penumbra, sqrt(distSq));
    eclipseEdge = smoothstep(0.05, 0.42, sunVis) * (1.0 - smoothstep(0.45, 0.95, sunVis));
  }

  float phaseScatter = 0.84 + 0.34 * pow(max(0.0, dot(V, -L)), 2.2);
  vec3 litCol = mix(ringCol, vec3(0.95, 0.45, 0.20), eclipseEdge * 0.55);
  vec3 shaded = litCol * (0.045 + 1.08 * sunVis * phaseScatter) + ringCol * uHover * 0.28;
  gl_FragColor = vec4(shaded, density * (1.0 + uHover * 0.18));
}
`;

const FOG_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 position;
varying vec2 vNdc;

void main() {
  vNdc = position;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

function buildVolumetricFogFragment(fogSteps: number): string {
  return /* glsl */ `
precision highp float;

uniform vec3 uCamPos;
uniform vec3 uCamRight;
uniform vec3 uCamUp;
uniform vec3 uCamForward;
uniform float uTanHalfFov;
uniform float uAspect;
uniform float uTime;
uniform float uWarpBoost;
uniform sampler2D uNoiseTex;
uniform vec4 uBodies[9];       // [0] = Sun, [1..8] = planets (xyz, radius)
uniform vec4 uShadowBodies[4]; // Earth, Mars, Jupiter, Saturn volumetric shadow casters

varying vec2 vNdc;

float ign(vec2 coord) {
  return fract(52.9829189 * fract(dot(coord, vec2(0.06711056, 0.00583715))));
}

void main() {
  vec3 ro = uCamPos;
  vec3 rd = normalize(
    uCamForward +
    uCamRight * (vNdc.x * uTanHalfFov * uAspect) +
    uCamUp * (vNdc.y * uTanHalfFov)
  );

  // Analytical nearest solid sphere depth across Sun + all 8 planets (stops foreground fog accurately)
  float tSolid = 240.0;
  for (int i = 0; i < 9; i++) {
    vec4 b = uBodies[i];
    vec3 oc = ro - b.xyz;
    float proj = dot(oc, rd);
    float rad = b.w * 0.992;
    float disc = proj * proj - (dot(oc, oc) - rad * rad);
    if (disc > 0.0) {
      float tHit = -proj - sqrt(disc);
      if (tHit > 0.05 && tHit < tSolid) {
        tSolid = tHit;
      }
    }
  }

  // Intersect ray with outer dusty solar-ecliptic sphere (R = 34) & dense slab y in [-3.0, 3.0]
  float bSph = dot(ro, rd);
  float cSph = dot(ro, ro) - 34.0 * 34.0;
  float discSph = bSph * bSph - cSph;
  if (discSph <= 0.0) discard;
  float sqSph = sqrt(discSph);
  float tStart = max(0.25, -bSph - sqSph);
  float tEnd = min(tSolid, -bSph + sqSph);

  if (abs(rd.y) > 0.001) {
    float ty0 = (-3.0 - ro.y) / rd.y;
    float ty1 = (3.0 - ro.y) / rd.y;
    tStart = max(tStart, min(ty0, ty1));
    tEnd = min(tEnd, max(ty0, ty1));
  } else if (abs(ro.y) > 3.0) {
    discard;
  }

  if (tEnd <= tStart + 0.05) discard;

  float dt = (tEnd - tStart) / float(${fogSteps});
  float t = tStart + dt * ign(gl_FragCoord.xy);

  // Henyey-Greenstein forward scattering phase centered toward Sun
  vec3 toSunCenter = normalize(-ro);
  float hgCos = dot(rd, toSunCenter);
  float g = 0.56;
  float hgPhase = (1.0 - g * g) / pow(max(0.05, 1.0 + g * g - 2.0 * g * hgCos), 1.5);
  float forwardGain = mix(0.82, 1.72, clamp(hgPhase * 0.24, 0.0, 1.0));

  vec3 fogAccum = vec3(0.0);

  for (int s = 0; s < ${fogSteps}; s++) {
    vec3 pos = ro + rd * t;
    float rSun = length(pos);

    if (rSun > 1.50) {
      float vertDensity = exp(-abs(pos.y) / (0.36 + rSun * 0.045));

      vec2 dustUv = pos.xz * 0.028 + vec2(uTime * 0.0032, -uTime * 0.0024) + vec2(pos.y * 0.045, -pos.y * 0.038);
      vec4 nDust = texture2D(uNoiseTex, dustUv);
      float dustSwirl = 0.66 + 0.34 * mix(nDust.r, nDust.g, 0.42);

      // Seamless 360-deg azimuthal solar coronal rays cutting outward through ecliptic dust
      float invH = 1.0 / max(0.2, length(pos.xz));
      vec2 radialDir2 = pos.xz * invH;
      vec2 rayUv = radialDir2 * 0.34 + vec2(0.5 + uTime * 0.0035, 0.5 - uTime * 0.0028) + radialDir2 * (rSun * 0.0045);
      float rayNoise = texture2D(uNoiseTex, rayUv).b;
      float sunRays = 0.58 + 0.58 * pow(clamp(rayNoise, 0.0, 1.0), 1.35);

      float radialFalloff = 1.0 / (1.0 + pow(rSun * 0.142, 1.38));
      float beltDust = exp(-pow((rSun - 8.55) / 1.55, 2.0)) * 0.36;

      // Volumetric planetary crepuscular shadow shafts (Earth, Mars, Jupiter, Saturn)
      vec3 toSun = -pos / rSun;
      float shadowVis = 1.0;
      for (int j = 0; j < 4; j++) {
        vec4 sb = uShadowBodies[j];
        vec3 toPlanet = sb.xyz - pos;
        float proj = dot(toPlanet, toSun);
        if (proj > 0.0 && proj < rSun) {
          float perp = length(toPlanet - toSun * proj);
          float softR = sb.w * 1.12 + 0.022 * proj;
          shadowVis *= smoothstep(sb.w * 0.78, softR, perp);
        }
      }

      // Color gradient: golden solar wind inward -> warm asteroid belt dust -> cool zodiacal haze outward
      vec3 nearSunCol = vec3(1.00, 0.72, 0.38);
      vec3 midDustCol = vec3(0.68, 0.58, 0.56);
      vec3 outerHazeCol = vec3(0.28, 0.45, 0.72);
      vec3 scatterCol = mix(nearSunCol, midDustCol, smoothstep(2.4, 9.8, rSun));
      scatterCol = mix(scatterCol, outerHazeCol, smoothstep(9.2, 22.0, rSun));

      float sampleDens = vertDensity * dustSwirl * sunRays * (radialFalloff + beltDust) * mix(0.05, 1.0, shadowVis);
      fogAccum += scatterCol * sampleDens * dt;
    }

    t += dt;
  }

  vec3 rawFog = fogAccum * forwardGain * (0.068 + uWarpBoost * 0.042);
  vec3 finalFog = rawFog / (1.0 + rawFog * 0.78);
  gl_FragColor = vec4(finalFog, 1.0);
}
`;
}

const FOG_COMPOSITE_VERTEX = /* glsl */ `
precision highp float;

attribute vec2 position;
varying vec2 vUv;

void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const FOG_COMPOSITE_FRAGMENT = /* glsl */ `
precision highp float;

uniform sampler2D uFogTex;
uniform vec2 uTexelSize;

varying vec2 vUv;

void main() {
  vec2 d = uTexelSize * 0.65;
  vec3 fog = (
    texture2D(uFogTex, vUv + vec2(-d.x, -d.y)).rgb +
    texture2D(uFogTex, vUv + vec2( d.x, -d.y)).rgb +
    texture2D(uFogTex, vUv + vec2(-d.x,  d.y)).rgb +
    texture2D(uFogTex, vUv + vec2( d.x,  d.y)).rgb
  ) * 0.25;
  gl_FragColor = vec4(fog, 1.0);
}
`;

const ORBIT_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const ORBIT_FRAGMENT = /* glsl */ `
precision highp float;

uniform float uHighlight;

void main() {
  vec3 baseCol = vec3(0.60, 0.70, 0.86);
  vec3 hoverCol = vec3(0.54, 0.71, 0.97);
  vec3 col = mix(baseCol, hoverCol, uHighlight);
  float alpha = mix(0.14, 0.60, uHighlight);
  gl_FragColor = vec4(col, alpha);
}
`;

const DUST_VERTEX = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute float aSize;
attribute float aSeed;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uOrbitSpeed;
uniform float uPixelRatio;

varying float vShade;

void main() {
  float c = cos(uTime * uOrbitSpeed);
  float s = sin(uTime * uOrbitSpeed);
  vec3 p = vec3(
    position.x * c - position.z * s,
    position.y,
    position.x * s + position.z * c
  );
  vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPos;
  float dist = max(1.5, -mvPos.z);
  vShade = 0.45 + 0.55 * aSeed;
  gl_PointSize = clamp(aSize * uPixelRatio * (18.0 / dist), 1.0, 3.8);
}
`;

const DUST_FRAGMENT = /* glsl */ `
precision highp float;

uniform vec3 uBaseColor;
varying float vShade;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float alpha = exp(-r * r * 5.0) * vShade * 0.56;
  gl_FragColor = vec4(uBaseColor, alpha);
}
`;

function createUnitQuadGeometry(gl: Renderer['gl'], halfExtent: number) {
  const s = halfExtent;
  const positions = new Float32Array([-s, -s, s, -s, s, s, -s, -s, s, s, -s, s]);
  return new Geometry(gl, {
    position: { size: 2, data: positions },
  });
}

function createRingGeometry(
  gl: Renderer['gl'],
  innerR: number,
  outerR: number,
  segments: number,
) {
  const vertCount = (segments + 1) * 2;
  const positions = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = new Uint16Array(segments * 6);

  for (let i = 0; i <= segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    const c = Math.cos(theta);
    const s = Math.sin(theta);

    const innerIdx = i * 2;
    positions[innerIdx * 3] = c * innerR;
    positions[innerIdx * 3 + 1] = 0;
    positions[innerIdx * 3 + 2] = s * innerR;
    uvs[innerIdx * 2] = 0;
    uvs[innerIdx * 2 + 1] = i / segments;

    const outerIdx = i * 2 + 1;
    positions[outerIdx * 3] = c * outerR;
    positions[outerIdx * 3 + 1] = 0;
    positions[outerIdx * 3 + 2] = s * outerR;
    uvs[outerIdx * 2] = 1;
    uvs[outerIdx * 2 + 1] = i / segments;

    if (i < segments) {
      const base = i * 6;
      indices[base] = innerIdx;
      indices[base + 1] = outerIdx;
      indices[base + 2] = innerIdx + 2;
      indices[base + 3] = outerIdx;
      indices[base + 4] = outerIdx + 2;
      indices[base + 5] = innerIdx + 2;
    }
  }

  return new Geometry(gl, {
    position: { size: 3, data: positions },
    uv: { size: 2, data: uvs },
    index: { data: indices },
  });
}

function createOrbitLineGeometry(
  gl: Renderer['gl'],
  planet: SolarPlanetSpec,
  segments: number,
) {
  const positions = new Float32Array(segments * 3);
  const tmp = new Vec3();
  for (let i = 0; i < segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    evaluateOrbitPoint(planet, theta, tmp);
    positions[i * 3] = tmp.x;
    positions[i * 3 + 1] = tmp.y;
    positions[i * 3 + 2] = tmp.z;
  }
  return new Geometry(gl, {
    position: { size: 3, data: positions },
  });
}

function createDeepStarBuffers(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  let state = 135792468;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // Synchronize counter-diagonal galactic plane basis with SKY_DOME_FRAGMENT (~30% converge softly along the Milky Way ribbon)
  const sFwdM = new Vec3(0.08, -0.34, -0.935).normalize();
  const sUpRefM = new Vec3(-0.14, 0.99, 0.0).normalize();
  const sRightM = new Vec3().cross(sFwdM, sUpRefM).normalize();
  const sUpM = new Vec3().cross(sRightM, sFwdM);
  const gUp = new Vec3(
    -sRightM.x * 0.55 + sUpM.x * 0.83 - sFwdM.x * 0.05,
    -sRightM.y * 0.55 + sUpM.y * 0.83 - sFwdM.y * 0.05,
    -sRightM.z * 0.55 + sUpM.z * 0.83 - sFwdM.z * 0.05,
  ).normalize();
  const gRight = new Vec3().cross(new Vec3(0, 1, 0), gUp).normalize();
  const gFwd = new Vec3().cross(gUp, gRight).normalize();

  for (let i = 0; i < count; i += 1) {
    const phi = rand() * Math.PI * 2;
    const r = 165 + rand() * 70;
    if (i < count * 0.30) {
      const u = ((rand() + rand() + rand()) / 3 - 0.5) * 0.24;
      const rLat = Math.sqrt(Math.max(0, 1 - u * u));
      const c = rLat * Math.cos(phi);
      const s = rLat * Math.sin(phi);
      positions[i * 3] = (gRight.x * c + gFwd.x * s + gUp.x * u) * r;
      positions[i * 3 + 1] = (gRight.y * c + gFwd.y * s + gUp.y * u) * r;
      positions[i * 3 + 2] = (gRight.z * c + gFwd.z * s + gUp.z * u) * r;
      sizes[i] = 1.05 + rand() * 0.95;
      seeds[i] = 0.35 + rand() * 0.55;
    } else {
      const u = rand() * 2 - 1;
      const sinTheta = Math.sqrt(Math.max(0, 1 - u * u));
      positions[i * 3] = r * sinTheta * Math.cos(phi);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * sinTheta * Math.sin(phi);

      const tier = rand();
      if (tier > 0.96) {
        sizes[i] = 3.2 + rand() * 1.6;
        seeds[i] = 0.96 + rand() * 0.04;
      } else if (tier > 0.74) {
        sizes[i] = 2.0 + rand() * 1.0;
        seeds[i] = 0.62 + rand() * 0.32;
      } else {
        sizes[i] = 1.25 + rand() * 0.7;
        seeds[i] = 0.32 + rand() * 0.55;
      }
    }
  }

  return { positions, sizes, seeds };
}

function createBeltBuffers(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  let state = 42424242;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    const angle = rand() * Math.PI * 2;
    const r = 8.15 + (rand() + rand()) * 0.58;
    positions[i * 3] = Math.cos(angle) * r;
    positions[i * 3 + 1] = (rand() - 0.5) * 0.36;
    positions[i * 3 + 2] = Math.sin(angle) * r;
    sizes[i] = 0.65 + rand() * 0.85;
    seeds[i] = rand();
  }

  return { positions, sizes, seeds };
}

function createCometTailBuffers(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  let state = 8675309;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  // Position comet gracefully inside upper-center deep space of Option C frustum
  const head = new Vec3(1.5, 4.8, -13.0);
  const tailDir = new Vec3(-0.34, 0.18, -0.92).normalize();

  for (let i = 0; i < count; i += 1) {
    const t = Math.pow(i / count, 1.3);
    const spread = 0.03 + t * 0.24;
    positions[i * 3] = head.x + tailDir.x * (t * 2.8) + (rand() - 0.5) * spread;
    positions[i * 3 + 1] = head.y + tailDir.y * (t * 2.8) + (rand() - 0.5) * spread;
    positions[i * 3 + 2] = head.z + tailDir.z * (t * 2.8) + (rand() - 0.5) * spread;
    sizes[i] = i === 0 ? 3.2 : (1.0 - t * 0.72) * (0.9 + rand() * 0.9);
    seeds[i] = i < 4 ? 1.0 : Math.max(0.12, (1.0 - t) * (0.5 + 0.5 * rand()));
  }

  return { positions, sizes, seeds };
}

/** Bake a seamless 256x256 tileable RGBA FBM noise texture once on init to replace runtime 3D simplex noise in volumetric fog. */
function createTileableNoiseTexture(gl: Renderer['gl']): Texture {
  const size = 256;
  const data = new Uint8Array(size * size * 4);

  const hash2 = (ix: number, iy: number, period: number, seed: number): number => {
    const px = ((ix % period) + period) % period;
    const py = ((iy % period) + period) % period;
    let n = (px * 374761393 + py * 668265263 + seed * 1442695041) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
  };

  const smoothVal = (fx: number, fy: number, period: number, seed: number): number => {
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    const tx = fx - ix;
    const ty = fy - iy;
    const ux = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
    const uy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);

    const v00 = hash2(ix, iy, period, seed);
    const v10 = hash2(ix + 1, iy, period, seed);
    const v01 = hash2(ix, iy + 1, period, seed);
    const v11 = hash2(ix + 1, iy + 1, period, seed);
    const a = v00 + (v10 - v00) * ux;
    const b = v01 + (v11 - v01) * ux;
    return a + (b - a) * uy;
  };

  const periodicFbm = (u: number, v: number, basePeriod: number, octaves: number, seed: number): number => {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let period = basePeriod;
    for (let o = 0; o < octaves; o += 1) {
      sum += smoothVal(u * period, v * period, period, seed + o * 19) * amp;
      norm += amp;
      amp *= 0.5;
      period *= 2;
    }
    return norm > 0 ? sum / norm : 0.5;
  };

  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const idx = (y * size + x) * 4;
      data[idx] = Math.round(periodicFbm(u, v, 4, 4, 11) * 255);
      data[idx + 1] = Math.round(periodicFbm(u, v, 8, 4, 37) * 255);
      data[idx + 2] = Math.round(periodicFbm(u, v, 6, 3, 73) * 255);
      data[idx + 3] = Math.round(periodicFbm(u, v, 12, 3, 113) * 255);
    }
  }

  return new Texture(gl, {
    image: data,
    width: size,
    height: size,
    wrapS: gl.REPEAT,
    wrapT: gl.REPEAT,
    minFilter: gl.LINEAR,
    magFilter: gl.LINEAR,
    generateMipmaps: false,
    flipY: false,
  });
}

function detectSoftwareWebGL(gl: Renderer['gl']): boolean {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const rendererStr = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : '';
    const vendorStr = String(gl.getParameter(gl.RENDERER) ?? '');
    return /swiftshader|llvmpipe|softpipe|software/i.test(`${rendererStr} ${vendorStr}`);
  } catch {
    return false;
  }
}

function easeInOutCubic(x: number): number {
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

const STATIC_OPTICAL_STARS = Array.from({ length: 48 }, (_, i) => {
  const s1 = Math.sin((i + 1) * 12.9898) * 43758.5453;
  const s2 = Math.sin((i + 1) * 78.233) * 43758.5453;
  const s3 = Math.sin((i + 1) * 39.425) * 43758.5453;
  const fx = s1 - Math.floor(s1);
  const fy = s2 - Math.floor(s2);
  const fz = s3 - Math.floor(s3);
  return {
    cx: Math.round(40 + fx * 1360),
    cy: Math.round(32 + fy * 776),
    r: fz > 0.82 ? 1.55 : fz > 0.45 ? 1.1 : 0.75,
    opacity: (0.35 + fz * 0.55).toFixed(2),
  };
});

/** Static SVG Option C fallback rendered under prefers-reduced-motion or when WebGL is unavailable. */
function StaticOpticalBackdrop({ onNavigatePlanet }: { onNavigatePlanet: (planet: SolarPlanetSpec) => void }) {
  const staticSpots: Array<{ planet: SolarPlanetSpec; cx: number; cy: number; r: number; fill: string }> = [
    { planet: SOLAR_PLANETS[0]!, cx: 360, cy: 255, r: 5, fill: '#9EA3AD' },
    { planet: SOLAR_PLANETS[1]!, cx: 450, cy: 278, r: 8, fill: '#E7C188' },
    { planet: SOLAR_PLANETS[2]!, cx: 585, cy: 318, r: 12, fill: '#4F92F2' },
    { planet: SOLAR_PLANETS[3]!, cx: 688, cy: 365, r: 9, fill: '#C96A48' },
    { planet: SOLAR_PLANETS[4]!, cx: 830, cy: 432, r: 28, fill: '#D6A477' },
    { planet: SOLAR_PLANETS[5]!, cx: 1005, cy: 525, r: 26, fill: '#E3CC9D' },
    { planet: SOLAR_PLANETS[6]!, cx: 1095, cy: 250, r: 14, fill: '#8AD4E0' },
    { planet: SOLAR_PLANETS[7]!, cx: 1225, cy: 288, r: 14, fill: '#416CE1' },
  ];

  return (
    <div
      aria-hidden="false"
      data-testid="star-ring-static-fallback"
      className="absolute inset-x-0 bottom-0 -top-[var(--nav-height)] overflow-hidden bg-[#05070c]"
      style={{
        background:
          'radial-gradient(45% 40% at 18% 25%, rgba(255, 198, 108, 0.22) 0%, rgba(255, 146, 56, 0.06) 36%, transparent 72%), #05070c',
      }}
    >
      <svg viewBox="0 0 1440 840" preserveAspectRatio="xMidYMid slice" className="h-full w-full">
        <defs>
          <radialGradient id="solarSunGrad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#FFFBE6" />
            <stop offset="65%" stopColor="#FFC154" />
            <stop offset="100%" stopColor="#E6691A" stopOpacity="0" />
          </radialGradient>
        </defs>
        <g fill="#E6EEF9">
          {STATIC_OPTICAL_STARS.map((star, idx) => (
            <circle key={idx} cx={star.cx} cy={star.cy} r={star.r} opacity={star.opacity} />
          ))}
        </g>
        <g opacity="0.24" fill="none" stroke="#9FB4D6" strokeWidth="1">
          {[140, 215, 310, 415, 595, 795, 965, 1110].map((rx) => (
            <ellipse key={rx} cx="250" cy="210" rx={rx} ry={rx * 0.34} transform="rotate(14 250 210)" />
          ))}
        </g>
        <circle cx="250" cy="210" r="88" fill="url(#solarSunGrad)" />
        <circle cx="250" cy="210" r="46" fill="#FFD37B" />
        {staticSpots.map(({ planet, cx, cy, r, fill }) => (
          <g
            key={planet.id}
            role="button"
            tabIndex={0}
            aria-label={`${planet.nameZh} · ${planet.portal.label}`}
            onClick={() => onNavigatePlanet(planet)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onNavigatePlanet(planet);
              }
            }}
            className="cursor-pointer outline-none"
          >
            {planet.hasRings && (
              <ellipse
                cx={cx}
                cy={cy}
                rx={r * 2.3}
                ry={r * 0.72}
                transform={`rotate(-18 ${cx} ${cy})`}
                fill="none"
                stroke="rgba(227, 204, 157, 0.72)"
                strokeWidth="7"
              />
            )}
            <circle cx={cx} cy={cy} r={r} fill={fill} />
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Photorealistic interactive 3D Solar System (OGL WebGL, depth-tested 8 planets, rings, shadows & dive-warp). */
export default function StarRingCanvas({
  paused,
  resetViewTick = 0,
  onViewModifiedChange,
  onNavigatePlanet,
  onReady,
}: StarRingCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const hoverOverlayRef = useRef<HTMLDivElement>(null);
  const reticleRingRef = useRef<HTMLDivElement>(null);
  const hoverLabelWrapRef = useRef<HTMLDivElement>(null);
  const hoverTitleRef = useRef<HTMLSpanElement>(null);
  const hoverPortalRef = useRef<HTMLSpanElement>(null);
  const hoverAuRef = useRef<HTMLSpanElement>(null);
  const edgeCueRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const focusPlanetActionRef = useRef<((planetIndex: number) => void) | null>(null);
  const warpVeilRef = useRef<HTMLDivElement>(null);

  const pausedRef = useRef(paused);
  const navigateRef = useRef(onNavigatePlanet);
  const onReadyRef = useRef(onReady);
  const onViewModifiedRef = useRef(onViewModifiedChange);
  const reportedReadyRef = useRef(false);
  navigateRef.current = onNavigatePlanet;
  onReadyRef.current = onReady;
  onViewModifiedRef.current = onViewModifiedChange;

  const [fallbackMode, setFallbackMode] = useState<'none' | 'reduced-motion' | 'no-webgl'>(() => {
    if (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return 'reduced-motion';
    }
    return 'none';
  });

  const controlsRef = useRef<{ syncLoop: () => void; resetView: () => void } | null>(null);
  pausedRef.current = paused;

  useEffect(() => {
    if (resetViewTick > 0) {
      controlsRef.current?.resetView();
    }
  }, [resetViewTick]);

  useEffect(() => {
    if (fallbackMode !== 'none' && !reportedReadyRef.current) {
      reportedReadyRef.current = true;
      onReadyRef.current?.();
    }
  }, [fallbackMode]);

  useEffect(() => {
    const mq =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    if (!mq) return;

    const handleMotionChange = () => {
      setFallbackMode((prev) => {
        if (mq.matches) return 'reduced-motion';
        return prev === 'reduced-motion' ? 'none' : prev;
      });
    };
    handleMotionChange();
    mq.addEventListener('change', handleMotionChange);
    return () => mq.removeEventListener('change', handleMotionChange);
  }, []);

  useEffect(() => {
    controlsRef.current?.syncLoop();
  }, [paused]);

  useEffect(() => {
    if (fallbackMode !== 'none') return;
    const container = containerRef.current;
    if (!container) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const probeCanvas = document.createElement('canvas');
    const contextAttrs: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
    };
    const gl2 = probeCanvas.getContext('webgl2', contextAttrs);
    const gl1 = gl2 ? null : probeCanvas.getContext('webgl', contextAttrs);
    if (!gl2 && !gl1) {
      setFallbackMode('no-webgl');
      return;
    }

    let renderer: Renderer | null = null;
    try {
      renderer = new Renderer({
        canvas: probeCanvas,
        webgl: gl2 ? 2 : 1,
        alpha: true,
        antialias: true,
        depth: true,
        premultipliedAlpha: true,
        dpr,
        powerPreference: 'high-performance',
      });
    } catch {
      setFallbackMode('no-webgl');
      return;
    }

    const gl = renderer.gl;
    if (!gl) {
      setFallbackMode('no-webgl');
      return;
    }

    const canvas = gl.canvas;
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.touchAction = 'pan-y';
    container.innerHTML = '';
    container.appendChild(canvas);

    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1.0);

    const isSoftware = detectSoftwareWebGL(gl);
    if (isSoftware) {
      renderer.dpr = 1;
    }
    const sphereW = isSoftware ? 36 : 56;
    const sphereH = isSoftware ? 22 : 34;
    const ringSegs = isSoftware ? 56 : 84;
    const orbitSegs = isSoftware ? 112 : 148;
    const bgStarCount = isSoftware ? 2800 : 4600;
    const beltCount = isSoftware ? 800 : 1400;
    const fogSteps = isSoftware ? 10 : 16;
    const fogScale = isSoftware ? 0.25 : 0.34;

    const camera = new Camera(gl, { fov: 42, near: 0.08, far: 450 });
    const scene = new Transform();

    const disposables: Array<{ remove: () => void }> = [];
    const noiseTex = createTileableNoiseTexture(gl);
    let disposed = false;
    let renderFrameFn: (() => void) | null = null;
    const signalReady = () => {
      if (!disposed && !reportedReadyRef.current) {
        reportedReadyRef.current = true;
        onReadyRef.current?.();
      }
    };
    const readyFailsafeTimer = window.setTimeout(signalReady, 1800);

    // 0. Option 2 Astronaut Void Sky Dome + Preloaded NASA 2K/1K PBR Planet Textures
    const isWebgl2 = renderer.isWebgl2;
    const skyDomeGeo = new Sphere(gl, { radius: 280, widthSegments: 28, heightSegments: 18 });
    const skyDomeProgram = new Program(gl, {
      vertex: SKY_DOME_VERTEX,
      fragment: SKY_DOME_FRAGMENT,
      transparent: false,
      cullFace: gl.FRONT,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uNoiseTex: { value: noiseTex },
        uTime: { value: 0 },
        uWarpBoost: { value: 0 },
      },
    });
    const skyDomeMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: skyDomeGeo,
      program: skyDomeProgram,
      frustumCulled: false,
      renderOrder: 1,
    });
    skyDomeMesh.setParent(scene);
    disposables.push(skyDomeGeo, skyDomeProgram);

    type PlanetTexKey =
      | 'mercury'
      | 'venus'
      | 'earth'
      | 'mars'
      | 'jupiter'
      | 'saturn'
      | 'uranus'
      | 'neptune'
      | 'moon'
      | 'earthClouds'
      | 'earthNight';

    const planetTextureSpecs: Record<PlanetTexKey, { url: string; fallback: [number, number, number, number] }> = {
      mercury: { url: '/cosmos/planets/mercury.webp', fallback: [150, 146, 140, 255] },
      venus: { url: '/cosmos/planets/venus.webp', fallback: [215, 180, 120, 255] },
      earth: { url: '/cosmos/planets/earth-day.webp', fallback: [30, 80, 160, 255] },
      mars: { url: '/cosmos/planets/mars.webp', fallback: [190, 95, 55, 255] },
      jupiter: { url: '/cosmos/planets/jupiter.webp', fallback: [210, 175, 140, 255] },
      saturn: { url: '/cosmos/planets/saturn.webp', fallback: [220, 195, 150, 255] },
      uranus: { url: '/cosmos/planets/uranus.webp', fallback: [150, 220, 232, 255] },
      neptune: { url: '/cosmos/planets/neptune.webp', fallback: [45, 95, 210, 255] },
      moon: { url: '/cosmos/planets/moon.webp', fallback: [145, 145, 148, 255] },
      earthClouds: { url: '/cosmos/planets/earth-clouds.webp', fallback: [0, 0, 0, 255] },
      earthNight: { url: '/cosmos/planets/earth-night.webp', fallback: [0, 0, 0, 255] },
    };

    const planetTextures: Texture[] = [];
    const planetImages: HTMLImageElement[] = [];
    const planetTexEntries = Object.entries(planetTextureSpecs) as Array<
      [PlanetTexKey, { url: string; fallback: [number, number, number, number] }]
    >;
    let settledTexCount = 0;

    const finalizePlanetTex = (loadedTex: Texture | null, loadedImg: HTMLImageElement | null) => {
      if (disposed) return;
      if (loadedTex && loadedImg) {
        loadedTex.image = loadedImg;
        loadedTex.needsUpdate = true;
      }
      settledTexCount += 1;
      if (settledTexCount >= planetTexEntries.length) {
        window.clearTimeout(readyFailsafeTimer);
        renderFrameFn?.();
        signalReady();
      } else if (loadedTex) {
        renderFrameFn?.();
      }
    };

    const planetTexById = {} as Record<PlanetTexKey, Texture>;
    for (const [key, spec] of planetTexEntries) {
      const tex = new Texture(gl, {
        image: new Uint8Array(spec.fallback),
        width: 1,
        height: 1,
        wrapS: gl.REPEAT,
        wrapT: gl.CLAMP_TO_EDGE,
        minFilter: isWebgl2 ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
        magFilter: gl.LINEAR,
        generateMipmaps: isWebgl2,
        flipY: true,
      });
      planetTextures.push(tex);
      planetTexById[key] = tex;

      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (disposed) return;
        if (typeof img.decode === 'function') {
          img.decode().catch(() => undefined).finally(() => finalizePlanetTex(tex, img));
        } else {
          finalizePlanetTex(tex, img);
        }
      };
      img.onerror = () => {
        finalizePlanetTex(null, null);
      };
      img.src = spec.url;
      planetImages.push(img);
    }

    // 1. Deep-Space Blackbody Starfield (depthTest true, depthWrite false -> occluded by opaque planets)
    const starBuf = createDeepStarBuffers(bgStarCount);
    const bgStarGeo = new Geometry(gl, {
      position: { size: 3, data: starBuf.positions },
      aSize: { size: 1, data: starBuf.sizes },
      aSeed: { size: 1, data: starBuf.seeds },
    });
    const bgStarProgram = new Program(gl, {
      vertex: BG_STAR_VERTEX,
      fragment: BG_STAR_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: dpr },
        uWarpBoost: { value: 0 },
      },
    });
    bgStarProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const bgStarMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: bgStarGeo,
      program: bgStarProgram,
      frustumCulled: false,
      renderOrder: 0,
    });
    bgStarMesh.setParent(scene);
    disposables.push(bgStarGeo, bgStarProgram);

    // Shared sphere geometries
    const unitSphere = new Sphere(gl, {
      radius: 1,
      widthSegments: sphereW,
      heightSegments: sphereH,
    });
    const sunSphere = new Sphere(gl, {
      radius: 1.38,
      widthSegments: sphereW,
      heightSegments: sphereH,
    });
    const moonSphere = new Sphere(gl, {
      radius: 0.115,
      widthSegments: 24,
      heightSegments: 16,
    });
    disposables.push(unitSphere, sunSphere, moonSphere);

    // 2. Dynamic Solar Photosphere + Camera-Facing Outer Corona Billboard
    const sunProgram = new Program(gl, {
      vertex: SUN_VERTEX,
      fragment: SUN_FRAGMENT,
      transparent: false,
      cullFace: gl.BACK,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        uTime: { value: 0 },
      },
    });
    const sunMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: sunSphere,
      program: sunProgram,
      frustumCulled: false,
      renderOrder: 0,
    });
    sunMesh.setParent(scene);
    disposables.push(sunProgram);

    const coronaGeo = createUnitQuadGeometry(gl, CORONA_HALF_EXTENT);
    const coronaProgram = new Program(gl, {
      vertex: CORONA_VERTEX,
      fragment: CORONA_FRAGMENT,
      transparent: true,
      cullFace: false,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
      },
    });
    coronaProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const coronaMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: coronaGeo,
      program: coronaProgram,
      frustumCulled: false,
      renderOrder: 1,
    });
    coronaMesh.setParent(scene);
    disposables.push(coronaGeo, coronaProgram);

    // 3. Main Asteroid Belt + Distant Drifting Comet
    const beltBuf = createBeltBuffers(beltCount);
    const beltGeo = new Geometry(gl, {
      position: { size: 3, data: beltBuf.positions },
      aSize: { size: 1, data: beltBuf.sizes },
      aSeed: { size: 1, data: beltBuf.seeds },
    });
    const beltProgram = new Program(gl, {
      vertex: DUST_VERTEX,
      fragment: DUST_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uOrbitSpeed: { value: 0.028 },
        uPixelRatio: { value: dpr },
        uBaseColor: { value: new Vec3(0.68, 0.62, 0.56) },
      },
    });
    beltProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const beltMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: beltGeo,
      program: beltProgram,
      frustumCulled: false,
      renderOrder: 1,
    });
    beltMesh.setParent(scene);
    disposables.push(beltGeo, beltProgram);

    const cometBuf = createCometTailBuffers(96);
    const cometGeo = new Geometry(gl, {
      position: { size: 3, data: cometBuf.positions },
      aSize: { size: 1, data: cometBuf.sizes },
      aSeed: { size: 1, data: cometBuf.seeds },
    });
    const cometProgram = new Program(gl, {
      vertex: DUST_VERTEX,
      fragment: DUST_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uOrbitSpeed: { value: 0.008 },
        uPixelRatio: { value: dpr },
        uBaseColor: { value: new Vec3(0.76, 0.90, 1.0) },
      },
    });
    cometProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const cometMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: cometGeo,
      program: cometProgram,
      frustumCulled: false,
      renderOrder: 1,
    });
    cometMesh.setParent(scene);
    disposables.push(cometGeo, cometProgram);

    // 4. Shared Programs for Planets (1 shader for all 8 + Moon), Rings, & Orbits
    const ringNormalVec = new Vec3(0, 1, 0);
    const activePlanetCenter = new Vec3(0, 0, 0);

    const planetProgram = new Program(gl, {
      vertex: PLANET_VERTEX,
      fragment: PLANET_FRAGMENT,
      transparent: false,
      cullFace: gl.BACK,
      depthTest: true,
      depthWrite: true,
      uniforms: {
        uAlbedoTex: { value: planetTexById.earth },
        uCloudTex: { value: planetTexById.earthClouds },
        uNightTex: { value: planetTexById.earthNight },
        uTime: { value: 0 },
        uOblateY: { value: 1.0 },
        uPlanetKind: { value: 2 },
        uHover: { value: 0 },
        uHasRings: { value: 0 },
        uPlanetCenter: { value: activePlanetCenter },
        uPlanetRadius: { value: 0.44 },
        uRingNormal: { value: ringNormalVec },
        uRingInner: { value: 1.26 },
        uRingOuter: { value: 2.52 },
      },
    });
    disposables.push(planetProgram);

    const ringCenterVec = new Vec3(0, 0, 0);
    const ringProgram = new Program(gl, {
      vertex: RING_VERTEX,
      fragment: RING_FRAGMENT,
      transparent: true,
      cullFace: false,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uPlanetCenter: { value: ringCenterVec },
        uPlanetRadius: { value: 0.94 },
        uRingInner: { value: 1.26 },
        uRingOuter: { value: 2.52 },
        uRingKind: { value: 0 },
        uHover: { value: 0 },
      },
    });
    ringProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    disposables.push(ringProgram);

    const orbitProgram = new Program(gl, {
      vertex: ORBIT_VERTEX,
      fragment: ORBIT_FRAGMENT,
      transparent: true,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uHighlight: { value: 0 },
      },
    });
    orbitProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    disposables.push(orbitProgram);

    const activeAtmoColor = new Vec3(0.36, 0.7, 1.0);
    const atmosProgram = new Program(gl, {
      vertex: ATMOS_VERTEX,
      fragment: ATMOS_FRAGMENT,
      transparent: true,
      cullFace: gl.FRONT,
      depthTest: true,
      depthWrite: false,
      uniforms: {
        uOblateY: { value: 1.0 },
        uAtmoColor: { value: activeAtmoColor },
        uAtmoDensity: { value: 0.5 },
        uHover: { value: 0 },
      },
    });
    atmosProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    disposables.push(atmosProgram);

    const PLANET_ATMOS_PROPS: Record<string, { scale: number; density: number; color: [number, number, number] }> = {
      venus: { scale: 1.11, density: 0.56, color: [1.0, 0.84, 0.54] },
      earth: { scale: 1.13, density: 0.78, color: [0.36, 0.72, 1.0] },
      mars: { scale: 1.09, density: 0.36, color: [0.94, 0.55, 0.4] },
      jupiter: { scale: 1.065, density: 0.32, color: [0.94, 0.82, 0.64] },
      saturn: { scale: 1.075, density: 0.36, color: [0.95, 0.86, 0.66] },
      uranus: { scale: 1.1, density: 0.56, color: [0.62, 0.93, 0.98] },
      neptune: { scale: 1.11, density: 0.68, color: [0.36, 0.65, 1.0] },
    };

    const fogBodies: [number, number, number, number][] = Array.from({ length: 9 }, () => [0, 0, 0, 1]);
    fogBodies[0] = [0, 0, 0, 1.38];
    const fogShadowBodies: [number, number, number, number][] = Array.from({ length: 4 }, () => [0, 0, 0, 1]);
    const fogCamPos = new Vec3();
    const fogCamRight = new Vec3(1, 0, 0);
    const fogCamUp = new Vec3(0, 1, 0);
    const fogCamForward = new Vec3(0, 0, -1);

    const fogRT = new RenderTarget(gl, {
      width: 320,
      height: 200,
      depth: false,
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR,
      wrapS: gl.CLAMP_TO_EDGE,
      wrapT: gl.CLAMP_TO_EDGE,
    });
    const fogScene = new Transform();
    const fogTexelSize = new Vec2(1 / 320, 1 / 200);

    const fogGeo = createUnitQuadGeometry(gl, 1.0);
    const fogProgram = new Program(gl, {
      vertex: FOG_VERTEX,
      fragment: buildVolumetricFogFragment(fogSteps),
      transparent: false,
      cullFace: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uCamPos: { value: fogCamPos },
        uCamRight: { value: fogCamRight },
        uCamUp: { value: fogCamUp },
        uCamForward: { value: fogCamForward },
        uTanHalfFov: { value: 0.344 },
        uAspect: { value: 1.6 },
        uTime: { value: 0 },
        uWarpBoost: { value: 0 },
        uNoiseTex: { value: noiseTex },
        uBodies: { value: fogBodies },
        uShadowBodies: { value: fogShadowBodies },
      },
    });
    const fogRayMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: fogGeo,
      program: fogProgram,
      frustumCulled: false,
    });
    fogRayMesh.setParent(fogScene);

    const fogCompositeProgram = new Program(gl, {
      vertex: FOG_COMPOSITE_VERTEX,
      fragment: FOG_COMPOSITE_FRAGMENT,
      transparent: true,
      cullFace: false,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFogTex: { value: fogRT.texture },
        uTexelSize: { value: fogTexelSize },
      },
    });
    fogCompositeProgram.setBlendFunc(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    const fogCompositeMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: fogGeo,
      program: fogCompositeProgram,
      frustumCulled: false,
      renderOrder: 3,
    });
    fogCompositeMesh.setParent(scene);
    disposables.push(fogGeo, fogProgram, fogCompositeProgram);

    // 5. Instantiate All 8 Planets, Tilt Holders, Rings, Orbits, & Earth's Moon
    type PlanetRuntime = {
      spec: SolarPlanetSpec;
      index: number;
      orbitNode: Transform;
      tiltNode: Transform;
      spinMesh: Mesh;
      worldPos: Vec3;
      hoverSmooth: number;
      ringTiltUp: Vec3;
      moonPivot?: Transform;
    };

    const hoverValues = new Float32Array(SOLAR_PLANETS.length);
    const planetRuntimes: PlanetRuntime[] = [];

    for (let idx = 0; idx < SOLAR_PLANETS.length; idx += 1) {
      const spec = SOLAR_PLANETS[idx]!;

      const orbitGeo = createOrbitLineGeometry(gl, spec, orbitSegs);
      disposables.push(orbitGeo);
      const orbitMesh = new Mesh(gl, {
        mode: gl.LINE_LOOP,
        geometry: orbitGeo,
        program: orbitProgram,
        frustumCulled: false,
        renderOrder: 1,
      });
      orbitMesh.onBeforeRender(() => {
        orbitProgram.uniforms.uHighlight.value = hoverValues[idx] ?? 0;
      });
      orbitMesh.setParent(scene);

      const orbitNode = new Transform();
      orbitNode.setParent(scene);

      const tiltNode = new Transform();
      tiltNode.rotation.z = spec.axialTilt;
      if (spec.id === 'saturn') {
        tiltNode.rotation.x = 0.14;
      }
      tiltNode.setParent(orbitNode);

      const spinMesh = new Mesh(gl, {
        mode: gl.TRIANGLES,
        geometry: unitSphere,
        program: planetProgram,
        frustumCulled: false,
        renderOrder: 0,
      });
      spinMesh.scale.set(spec.radius, spec.radius, spec.radius);
      spinMesh.setParent(tiltNode);

      const runtime: PlanetRuntime = {
        spec,
        index: idx,
        orbitNode,
        tiltNode,
        spinMesh,
        worldPos: new Vec3(),
        hoverSmooth: 0,
        ringTiltUp: new Vec3(0, 1, 0),
      };

      spinMesh.onBeforeRender(() => {
        planetProgram.uniforms.uAlbedoTex.value = planetTexById[spec.id] ?? planetTexById.earth;
        planetProgram.uniforms.uPlanetKind.value = spec.shaderKind;
        planetProgram.uniforms.uOblateY.value = spec.id === 'saturn' ? 0.91 : 1.0;
        planetProgram.uniforms.uHover.value = hoverValues[idx] ?? 0;
        planetProgram.uniforms.uHasRings.value = spec.hasRings ? 1 : 0;
        if (spec.hasRings) {
          activePlanetCenter.copy(runtime.worldPos);
          planetProgram.uniforms.uPlanetRadius.value = spec.radius;
          planetProgram.uniforms.uRingInner.value = spec.ringInner ?? 1.26;
          planetProgram.uniforms.uRingOuter.value = spec.ringOuter ?? 2.52;
          ringNormalVec.copy(runtime.ringTiltUp);
        }
      });

      if ((spec.hasRings || spec.hasThinRing) && spec.ringInner && spec.ringOuter) {
        const ringGeo = createRingGeometry(
          gl,
          spec.radius * spec.ringInner,
          spec.radius * spec.ringOuter,
          ringSegs,
        );
        disposables.push(ringGeo);
        const ringMesh = new Mesh(gl, {
          mode: gl.TRIANGLES,
          geometry: ringGeo,
          program: ringProgram,
          frustumCulled: false,
          renderOrder: 2,
        });
        ringMesh.setParent(tiltNode);
        ringMesh.onBeforeRender(() => {
          ringCenterVec.copy(runtime.worldPos);
          ringProgram.uniforms.uPlanetRadius.value = spec.radius;
          ringProgram.uniforms.uRingInner.value = spec.ringInner!;
          ringProgram.uniforms.uRingOuter.value = spec.ringOuter!;
          ringProgram.uniforms.uRingKind.value = spec.hasRings ? 0 : 1;
          ringProgram.uniforms.uHover.value = hoverValues[idx] ?? 0;
        });
      }

      if (spec.hasMoon) {
        const moonPivot = new Transform();
        moonPivot.rotation.z = 0.09;
        moonPivot.setParent(orbitNode);
        const moonMesh = new Mesh(gl, {
          mode: gl.TRIANGLES,
          geometry: moonSphere,
          program: planetProgram,
          frustumCulled: false,
          renderOrder: 0,
        });
        moonMesh.position.set(spec.radius * 2.45, 0, 0);
        moonMesh.setParent(moonPivot);
        moonMesh.onBeforeRender(() => {
          planetProgram.uniforms.uAlbedoTex.value = planetTexById.moon;
          planetProgram.uniforms.uPlanetKind.value = 8;
          planetProgram.uniforms.uOblateY.value = 1.0;
          planetProgram.uniforms.uHover.value = hoverValues[idx] ?? 0;
          planetProgram.uniforms.uHasRings.value = 0;
        });
        runtime.moonPivot = moonPivot;
      }

      const atmosProps = PLANET_ATMOS_PROPS[spec.id];
      if (atmosProps) {
        const atmosMesh = new Mesh(gl, {
          mode: gl.TRIANGLES,
          geometry: unitSphere,
          program: atmosProgram,
          frustumCulled: false,
          renderOrder: 2,
        });
        const rAtmo = spec.radius * atmosProps.scale;
        atmosMesh.scale.set(rAtmo, rAtmo, rAtmo);
        atmosMesh.setParent(tiltNode);
        atmosMesh.onBeforeRender(() => {
          atmosProgram.uniforms.uOblateY.value = spec.id === 'saturn' ? 0.91 : 1.0;
          activeAtmoColor.set(atmosProps.color[0], atmosProps.color[1], atmosProps.color[2]);
          atmosProgram.uniforms.uAtmoDensity.value = atmosProps.density;
          atmosProgram.uniforms.uHover.value = hoverValues[idx] ?? 0;
        });
      }

      planetRuntimes.push(runtime);
    }

    // Classic Option C Low-Elevation Asymmetric Ecliptic Flyby Camera
    let viewWidth = Math.max(container.clientWidth, 320);
    let viewHeight = Math.max(container.clientHeight, 240);
    let currentAspect = viewWidth / viewHeight;
    let baseFov = 38;
    const baseCamPos = new Vec3(5.2, 5.2, 21.8);
    const baseCamTarget = new Vec3(7.2, -2.1, 3.2);

    const syncCameraBaseForAspect = () => {
      camera.up.set(0, 1, 0);
      if (currentAspect < 0.85) {
        const stretch = Math.min(1.5, 0.85 / Math.max(currentAspect, 0.44));
        baseCamPos.set(3.4, 7.6 * Math.sqrt(stretch), 28.5 * stretch);
        baseCamTarget.set(5.4, -1.6, 3.0);
        baseFov = 42;
      } else {
        baseCamPos.set(5.2, 5.2, 21.8);
        baseCamTarget.set(7.2, -2.1, 3.2);
        baseFov = 38;
      }
    };

    let cachedRect: DOMRect | null = null;
    let rectDirty = true;
    const markRectDirty = () => {
      rectDirty = true;
    };

    const resize = () => {
      if (!renderer || !container) return;
      viewWidth = Math.max(container.clientWidth, 320);
      viewHeight = Math.max(container.clientHeight, 240);
      currentAspect = viewWidth / viewHeight;
      rectDirty = true;
      syncCameraBaseForAspect();
      renderer.setSize(viewWidth, viewHeight);
      camera.perspective({ aspect: currentAspect, fov: baseFov });
      const activeDpr = renderer.dpr;
      bgStarProgram.uniforms.uPixelRatio.value = activeDpr;
      beltProgram.uniforms.uPixelRatio.value = activeDpr;
      cometProgram.uniforms.uPixelRatio.value = activeDpr;
      const fogW = Math.max(192, Math.round(viewWidth * fogScale));
      const fogH = Math.max(120, Math.round(viewHeight * fogScale));
      fogRT.setSize(fogW, fogH);
      fogTexelSize.set(1 / fogW, 1 / fogH);
    };
    resize();

    // Pointer, drag, zoom, pan/focus, picking, & dive-warp state
    const pointerNdc = new Vec2(2, 2); // starts offscreen
    let pointerInside = false;
    let dragYawTarget = 0;
    let dragPitchTarget = 0;
    let dragYawCurrent = 0;
    let dragPitchCurrent = 0;
    let panOffsetXTarget = 0;
    let panOffsetXCurrent = 0;
    let zoomTarget = 0;
    let zoomCurrent = 0;
    let zoomFocusIndex = -1;
    let pinchPrevDist: number | null = null;
    let lastViewModified = false;
    let lastZoomAttr = '0.00';
    canvas.dataset.zoom = lastZoomAttr;
    let focusPlanetIndex = -1;
    let focusHoldUntil = 0;
    let parallaxXCurrent = 0;
    let parallaxYCurrent = 0;

    let pointerDown = false;
    let downX = 0;
    let downY = 0;
    let movedSinceDown = 0;
    let hoveredIndex = -1;
    let lastShownHoverIndex = -2;

    type DiveState = {
      planet: SolarPlanetSpec;
      index: number;
      elapsed: number;
      duration: number;
      startPos: Vec3;
      startTarget: Vec3;
      startFov: number;
      triggeredNav: boolean;
      recovering: boolean;
      recoverElapsed: number;
    };
    let dive: DiveState | null = null;

    // Reusable scratch math objects (zero per-frame heap allocations)
    const tmpRight = new Vec3();
    const tmpUp = new Vec3();
    const tmpForward = new Vec3();
    const tmpRayDir = new Vec3();
    const tmpOc = new Vec3();
    const tmpCamOrigin = new Vec3();
    const tmpRingPt = new Vec3();
    const tmpProj = new Vec3();
    const curCamPos = new Vec3();
    const curCamTarget = new Vec3();
    const zoomBasePos = new Vec3();
    const zoomBaseTarget = new Vec3();
    const zoomGoalPos = new Vec3();
    const zoomGoalTarget = new Vec3();
    const zoomDir = new Vec3();
    const approachDir = new Vec3();
    const diveGoalPos = new Vec3();

    const syncViewModified = () => {
      const modified =
        Math.abs(zoomTarget) > 0.03 ||
        Math.abs(dragYawTarget) > 0.8 ||
        Math.abs(dragPitchTarget) > 0.5;
      if (modified !== lastViewModified) {
        lastViewModified = modified;
        onViewModifiedRef.current?.(modified);
      }
    };

    const initialSpinLon: Partial<Record<SolarPlanetSpec['id'], number>> = {
      earth: -1.42,
      jupiter: 0.55,
      mars: -0.45,
    };

    const updateBodiesAtElapsed = (t: number) => {
      sunMesh.rotation.y = t * 0.04;
      for (const item of planetRuntimes) {
        computePlanetPosition(item.spec, t, item.orbitNode.position);
        const initLon = initialSpinLon[item.spec.id] ?? 0;
        item.spinMesh.rotation.y = initLon + t * item.spec.spinSpeed;
        if (item.moonPivot) {
          item.moonPivot.rotation.y = t * 0.48;
        }
      }
      scene.updateMatrixWorld(true);
      for (const item of planetRuntimes) {
        item.orbitNode.worldMatrix.getTranslation(item.worldPos);
        // Extract tilted Y-axis normal cleanly from tiltNode worldMatrix column 1 (m[4], m[5], m[6])
        const wm = item.tiltNode.worldMatrix;
        item.ringTiltUp.set(wm[4]!, wm[5]!, wm[6]!).normalize();
      }
    };

    const pickPlanetAtNdc = (ndcX: number, ndcY: number): number => {
      if (Math.abs(ndcX) > 1.05 || Math.abs(ndcY) > 1.05) return -1;
      const cm = camera.worldMatrix;
      tmpCamOrigin.set(cm[12]!, cm[13]!, cm[14]!);
      tmpRight.set(cm[0]!, cm[1]!, cm[2]!);
      tmpUp.set(cm[4]!, cm[5]!, cm[6]!);
      tmpForward.set(-cm[8]!, -cm[9]!, -cm[10]!);

      const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      tmpRayDir
        .copy(tmpForward)
        .add(tmpRight.clone().scale(ndcX * tanHalfFov * camera.aspect))
        .add(tmpUp.clone().scale(ndcY * tanHalfFov))
        .normalize();

      let bestIdx = -1;
      let bestDist = Infinity;

      for (const item of planetRuntimes) {
        const rHit = item.spec.radius * item.spec.hitScale;
        tmpOc.sub(item.worldPos, tmpCamOrigin);
        const proj = tmpOc.dot(tmpRayDir);
        if (proj > 0.1) {
          const perpSq = tmpOc.squaredLen() - proj * proj;
          if (perpSq <= rHit * rHit) {
            const tHit = proj - Math.sqrt(Math.max(0, rHit * rHit - perpSq));
            if (tHit > 0.05 && tHit < bestDist) {
              bestDist = tHit;
              bestIdx = item.index;
            }
          }
        }

        // Expand hit volume accurately onto Saturn's tilted rings
        if (item.spec.hasRings && item.spec.ringInner && item.spec.ringOuter) {
          const denom = tmpRayDir.dot(item.ringTiltUp);
          if (Math.abs(denom) > 0.005) {
            const tPlane = tmpOc.sub(item.worldPos, tmpCamOrigin).dot(item.ringTiltUp) / denom;
            if (tPlane > 0.1 && tPlane < bestDist) {
              tmpRingPt
                .copy(tmpRayDir)
                .scale(tPlane)
                .add(tmpCamOrigin)
                .sub(item.worldPos);
              const dRing = tmpRingPt.len();
              if (
                dRing >= item.spec.radius * (item.spec.ringInner * 0.9) &&
                dRing <= item.spec.radius * (item.spec.ringOuter * 1.06)
              ) {
                bestDist = tPlane;
                bestIdx = item.index;
              }
            }
          }
        }
      }

      return bestIdx;
    };

    let hudVisible = false;
    let lastCursor = '';

    const syncHoverHud = () => {
      const overlayEl = hoverOverlayRef.current;
      const ringEl = reticleRingRef.current;
      if (!overlayEl || !ringEl) return;

      if (hoveredIndex < 0 || (dive && !dive.recovering)) {
        if (hudVisible) {
          overlayEl.style.opacity = '0';
          hudVisible = false;
        }
        const nextCursor = pointerDown && movedSinceDown > 6 ? 'grabbing' : 'grab';
        if (lastCursor !== nextCursor) {
          canvas.style.cursor = nextCursor;
          lastCursor = nextCursor;
        }
        return;
      }

      const item = planetRuntimes[hoveredIndex];
      if (!item) return;

      if (lastShownHoverIndex !== hoveredIndex) {
        lastShownHoverIndex = hoveredIndex;
        if (hoverTitleRef.current) {
          hoverTitleRef.current.textContent = item.spec.nameZh;
        }
        if (hoverPortalRef.current) {
          hoverPortalRef.current.textContent = item.spec.portal.label;
        }
        if (hoverAuRef.current) {
          hoverAuRef.current.textContent = item.spec.auLabel;
        }
      }

      tmpProj.copy(item.worldPos).applyMatrix4(camera.projectionViewMatrix);
      const px = (tmpProj.x * 0.5 + 0.5) * viewWidth;
      const py = (-tmpProj.y * 0.5 + 0.5) * viewHeight;

      const camDist = Math.max(1.2, item.worldPos.distance(camera.worldPosition));
      const tanHalfFov = Math.tan((camera.fov * Math.PI) / 360);
      const effectiveR = item.spec.hasRings ? item.spec.radius * 2.15 : item.spec.radius * 1.38;
      const screenDiameter = Math.max(
        34,
        Math.min(180, ((effectiveR * 2) / (camDist * tanHalfFov)) * (viewHeight * 0.5)),
      );

      ringEl.style.width = `${screenDiameter.toFixed(1)}px`;
      ringEl.style.height = `${screenDiameter.toFixed(1)}px`;
      if (hoverLabelWrapRef.current) {
        hoverLabelWrapRef.current.style.top = `${(screenDiameter * 0.5 + 10).toFixed(1)}px`;
      }
      overlayEl.style.transform = `translate3d(${px.toFixed(1)}px, ${py.toFixed(1)}px, 0)`;
      if (!hudVisible) {
        overlayEl.style.opacity = '1';
        hudVisible = true;
      }
      if (lastCursor !== 'pointer') {
        canvas.style.cursor = 'pointer';
        lastCursor = 'pointer';
      }
    };

    const edgeCueBuffer: Array<{ index: number; y: number }> = [];
    const edgeCueVisible = new Uint8Array(SOLAR_PLANETS.length);

    const syncOffscreenEdgeHud = () => {
      const els = edgeCueRefs.current;
      const cm = camera.worldMatrix;
      tmpCamOrigin.set(cm[12]!, cm[13]!, cm[14]!);
      tmpRight.set(cm[0]!, cm[1]!, cm[2]!);
      tmpForward.set(-cm[8]!, -cm[9]!, -cm[10]!);

      if (dive && !dive.recovering) {
        for (let i = 0; i < planetRuntimes.length; i += 1) {
          const el = els[i];
          if (el && edgeCueVisible[i]) {
            el.style.opacity = '0';
            el.style.visibility = 'hidden';
            el.style.pointerEvents = 'none';
            el.tabIndex = -1;
            edgeCueVisible[i] = 0;
          }
        }
        return;
      }

      const minY = 92;
      const maxY = Math.max(minY + 40, viewHeight - 170);
      edgeCueBuffer.length = 0;

      for (let i = 0; i < planetRuntimes.length; i += 1) {
        const item = planetRuntimes[i]!;
        tmpOc.sub(item.worldPos, tmpCamOrigin);
        const zView = tmpOc.dot(tmpForward);
        const xSide = tmpOc.dot(tmpRight);
        tmpProj.copy(item.worldPos).applyMatrix4(camera.projectionViewMatrix);

        const isOffLeft = (zView > 0.15 && tmpProj.x < -0.94) || (zView <= 0.15 && xSide < 0);
        if (isOffLeft) {
          const rawY = zView > 0.15 ? (-tmpProj.y * 0.5 + 0.5) * viewHeight : viewHeight * 0.42;
          edgeCueBuffer.push({
            index: i,
            y: Math.max(minY, Math.min(maxY, rawY)),
          });
        } else {
          const el = els[i];
          if (el && edgeCueVisible[i]) {
            el.style.opacity = '0';
            el.style.visibility = 'hidden';
            el.style.pointerEvents = 'none';
            el.tabIndex = -1;
            edgeCueVisible[i] = 0;
          }
        }
      }

      if (edgeCueBuffer.length === 0) return;

      edgeCueBuffer.sort((a, b) => a.y - b.y);
      const minGap = 38;
      for (let k = 1; k < edgeCueBuffer.length; k += 1) {
        const prev = edgeCueBuffer[k - 1]!;
        const cur = edgeCueBuffer[k]!;
        if (cur.y - prev.y < minGap) {
          cur.y = prev.y + minGap;
        }
      }
      const last = edgeCueBuffer[edgeCueBuffer.length - 1]!;
      if (last.y > maxY) {
        last.y = maxY;
        for (let k = edgeCueBuffer.length - 2; k >= 0; k -= 1) {
          const next = edgeCueBuffer[k + 1]!;
          const cur = edgeCueBuffer[k]!;
          if (next.y - cur.y < minGap) {
            cur.y = Math.max(minY, next.y - minGap);
          }
        }
      }

      for (const cue of edgeCueBuffer) {
        const el = els[cue.index];
        if (!el) continue;
        el.style.transform = `translate3d(0, ${cue.y.toFixed(1)}px, 0)`;
        if (!edgeCueVisible[cue.index]) {
          el.style.opacity = '1';
          el.style.visibility = 'visible';
          el.style.pointerEvents = 'auto';
          el.tabIndex = 0;
          edgeCueVisible[cue.index] = 1;
        }
      }
    };

    let rafId: number | null = null;
    let lastTs = performance.now();
    let elapsed = 0;
    let inViewport = true;

    const renderFrame = () => {
      if (!renderer || disposed) return;
      updateBodiesAtElapsed(elapsed);

      if (dive) {
        if (!dive.recovering) {
          const p = Math.min(1, dive.elapsed / dive.duration);
          const eased = easeInOutCubic(p);
          const targetPlanet = planetRuntimes[dive.index]!;
          const pPos = targetPlanet.worldPos;

          // Aim camera gracefully onto sunlit limb of the clicked planet
          approachDir.copy(pPos).negate().normalize();
          const standOff = targetPlanet.spec.radius * (targetPlanet.spec.hasRings ? 3.2 : 2.35);
          diveGoalPos
            .copy(pPos)
            .add(approachDir.clone().scale(standOff * 0.72))
            .add(new Vec3(0, targetPlanet.spec.radius * 0.35, standOff * 0.76));

          curCamPos.set(
            dive.startPos.x + (diveGoalPos.x - dive.startPos.x) * eased,
            dive.startPos.y + (diveGoalPos.y - dive.startPos.y) * eased,
            dive.startPos.z + (diveGoalPos.z - dive.startPos.z) * eased,
          );
          curCamTarget.set(
            dive.startTarget.x + (pPos.x - dive.startTarget.x) * eased,
            dive.startTarget.y + (pPos.y - dive.startTarget.y) * eased,
            dive.startTarget.z + (pPos.z - dive.startTarget.z) * eased,
          );

          const punchFov = dive.startFov + 13 * Math.pow(p, 1.4);
          if (Math.abs(camera.fov - punchFov) > 0.05) {
            camera.perspective({ aspect: currentAspect, fov: punchFov });
          }
          bgStarProgram.uniforms.uWarpBoost.value = Math.sin(p * Math.PI) * 1.4 + p * 0.8;

          if (warpVeilRef.current) {
            const veilOpacity = Math.max(0, Math.min(1, (p - 0.68) / 0.30));
            warpVeilRef.current.style.background = `radial-gradient(circle at 50% 50%, color-mix(in srgb, ${dive.planet.warpTint} 34%, #0b0c0e) 0%, #0b0c0e 82%)`;
            warpVeilRef.current.style.opacity = veilOpacity.toFixed(3);
          }

          camera.position.copy(curCamPos);
          camera.lookAt(curCamTarget);
        } else {
          // Smooth return recovery if clicking Jupiter (/#labs stays on HomePage)
          const rp = Math.min(1, dive.recoverElapsed / 0.45);
          if (warpVeilRef.current) {
            warpVeilRef.current.style.opacity = (1 - rp).toFixed(3);
          }
          bgStarProgram.uniforms.uWarpBoost.value = Math.max(0, 1 - rp);
          if (Math.abs(camera.fov - baseFov) > 0.05) {
            camera.perspective({
              aspect: currentAspect,
              fov: camera.fov + (baseFov - camera.fov) * 0.2,
            });
          }
          const panCamX = panOffsetXCurrent + dragYawCurrent;
          const panLookX = panOffsetXCurrent + dragYawCurrent * 0.65;
          curCamTarget.set(baseCamTarget.x + panLookX, baseCamTarget.y, baseCamTarget.z);
          camera.position.set(
            baseCamPos.x + panCamX + parallaxXCurrent,
            baseCamPos.y + dragPitchCurrent + parallaxYCurrent,
            baseCamPos.z,
          );
          camera.lookAt(curCamTarget);
          if (rp >= 1) {
            dive = null;
          }
        }
      } else {
        const activeFov =
          zoomCurrent >= 0
            ? baseFov - zoomCurrent * 5.0
            : baseFov + Math.min(4.0, -zoomCurrent * 4.0);
        if (Math.abs(camera.fov - activeFov) > 0.05) {
          camera.perspective({ aspect: currentAspect, fov: activeFov });
        }
        bgStarProgram.uniforms.uWarpBoost.value = 0;
        if (warpVeilRef.current && warpVeilRef.current.style.opacity !== '0') {
          warpVeilRef.current.style.opacity = '0';
        }
        const panCamX = panOffsetXCurrent + dragYawCurrent;
        const panLookX = panOffsetXCurrent + dragYawCurrent * 0.65;
        zoomBaseTarget.set(baseCamTarget.x + panLookX, baseCamTarget.y, baseCamTarget.z);
        zoomBasePos.set(
          baseCamPos.x + panCamX + parallaxXCurrent,
          baseCamPos.y + dragPitchCurrent + parallaxYCurrent,
          baseCamPos.z,
        );

        const focusItem =
          zoomCurrent > 0 && zoomFocusIndex >= 0 ? planetRuntimes[zoomFocusIndex] : undefined;
        if (focusItem) {
          const pPos = focusItem.worldPos;
          const standOff = Math.max(
            focusItem.spec.radius * (focusItem.spec.hasRings ? 3.8 : 3.2),
            0.78,
          );
          zoomGoalTarget.set(
            pPos.x + focusItem.spec.radius * 0.16,
            pPos.y - focusItem.spec.radius * 0.04,
            pPos.z,
          );
          zoomGoalPos.set(
            pPos.x - standOff * 0.34 + dragYawCurrent * 0.14,
            pPos.y + standOff * 0.22 + dragPitchCurrent * 0.14,
            pPos.z + standOff * 0.92,
          );
          const tz = zoomCurrent * zoomCurrent * (3 - 2 * zoomCurrent);
          curCamTarget.set(
            zoomBaseTarget.x + (zoomGoalTarget.x - zoomBaseTarget.x) * tz,
            zoomBaseTarget.y + (zoomGoalTarget.y - zoomBaseTarget.y) * tz,
            zoomBaseTarget.z + (zoomGoalTarget.z - zoomBaseTarget.z) * tz,
          );
          curCamPos.set(
            zoomBasePos.x + (zoomGoalPos.x - zoomBasePos.x) * tz,
            zoomBasePos.y + (zoomGoalPos.y - zoomBasePos.y) * tz,
            zoomBasePos.z + (zoomGoalPos.z - zoomBasePos.z) * tz,
          );
        } else {
          zoomDir.sub(zoomBasePos, zoomBaseTarget);
          const distScale =
            zoomCurrent >= 0
              ? Math.max(0.24, 1.0 - zoomCurrent * 0.76)
              : 1.0 - zoomCurrent * 1.32;
          curCamTarget.copy(zoomBaseTarget);
          curCamPos.copy(zoomBaseTarget).add(zoomDir.scale(distScale));
          const sunDist = curCamPos.len();
          if (sunDist > 0.001 && sunDist < 3.4) {
            curCamPos.scale(3.4 / sunDist);
          }
        }

        const zoomAttr = zoomCurrent.toFixed(2);
        if (zoomAttr !== lastZoomAttr) {
          lastZoomAttr = zoomAttr;
          canvas.dataset.zoom = zoomAttr;
        }
        camera.position.copy(curCamPos);
        camera.lookAt(curCamTarget);
      }

      // Face solar corona billboard symmetrically at Sun origin & keep cosmic sky dome centered on camera
      coronaMesh.position.set(0, 0, 0);
      coronaMesh.quaternion.copy(camera.quaternion);
      skyDomeMesh.position.copy(camera.position);
      skyDomeProgram.uniforms.uTime.value = elapsed;
      skyDomeProgram.uniforms.uWarpBoost.value = bgStarProgram.uniforms.uWarpBoost.value;

      camera.updateMatrixWorld();

      // Sync volumetric ecliptic fog uniforms & solid planet shadow casters
      const cm = camera.worldMatrix;
      fogCamPos.set(cm[12]!, cm[13]!, cm[14]!);
      fogCamRight.set(cm[0]!, cm[1]!, cm[2]!);
      fogCamUp.set(cm[4]!, cm[5]!, cm[6]!);
      fogCamForward.set(-cm[8]!, -cm[9]!, -cm[10]!);
      fogProgram.uniforms.uTanHalfFov.value = Math.tan((camera.fov * Math.PI) / 360);
      fogProgram.uniforms.uAspect.value = currentAspect;
      fogProgram.uniforms.uWarpBoost.value = bgStarProgram.uniforms.uWarpBoost.value;

      for (let i = 0; i < planetRuntimes.length; i += 1) {
        const item = planetRuntimes[i]!;
        const slot = fogBodies[i + 1]!;
        slot[0] = item.worldPos.x;
        slot[1] = item.worldPos.y;
        slot[2] = item.worldPos.z;
        slot[3] = item.spec.radius;
      }
      // Earth(2), Mars(3), Jupiter(4), Saturn(5) -> volumetric shadow shaft casters
      const shadowIndices = [2, 3, 4, 5] as const;
      for (let s = 0; s < 4; s += 1) {
        const item = planetRuntimes[shadowIndices[s]!]!;
        const slot = fogShadowBodies[s]!;
        slot[0] = item.worldPos.x;
        slot[1] = item.worldPos.y;
        slot[2] = item.worldPos.z;
        slot[3] = item.spec.radius;
      }

      if (pointerInside && !dive) {
        hoveredIndex = pickPlanetAtNdc(pointerNdc.x, pointerNdc.y);
      } else if (!pointerInside) {
        hoveredIndex = -1;
      }

      renderer.render({
        scene: fogScene,
        target: fogRT,
        update: false,
        sort: false,
        frustumCull: false,
        clear: true,
      });
      renderer.render({ scene, camera });
      syncHoverHud();
      syncOffscreenEdgeHud();
    };
    renderFrameFn = renderFrame;

    const tick = (now: number) => {
      rafId = null;
      if (disposed || pausedRef.current || document.hidden || !inViewport) return;

      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      elapsed += dt;

      const targetPx = pointerInside ? pointerNdc.x * 0.65 : 0;
      const targetPy = pointerInside ? pointerNdc.y * 0.35 : 0;
      parallaxXCurrent += (targetPx - parallaxXCurrent) * Math.min(1, dt * 4.2);
      parallaxYCurrent += (targetPy - parallaxYCurrent) * Math.min(1, dt * 4.2);

      if (focusPlanetIndex >= 0) {
        if (elapsed > focusHoldUntil) {
          focusPlanetIndex = -1;
          panOffsetXTarget = 0;
        } else {
          const targetItem = planetRuntimes[focusPlanetIndex];
          if (targetItem) {
            panOffsetXTarget = Math.max(
              -22,
              Math.min(2, targetItem.worldPos.x - (baseCamTarget.x - 4.0)),
            );
          }
        }
      }
      panOffsetXCurrent += (panOffsetXTarget - panOffsetXCurrent) * Math.min(1, dt * 3.8);
      zoomCurrent += (zoomTarget - zoomCurrent) * Math.min(1, dt * 7.5);
      if (Math.abs(zoomCurrent) <= 0.01 && zoomTarget === 0) {
        zoomCurrent = 0;
      }

      dragYawCurrent += (dragYawTarget - dragYawCurrent) * Math.min(1, dt * 6);
      dragPitchCurrent += (dragPitchTarget - dragPitchCurrent) * Math.min(1, dt * 6);
      if (!pointerDown && !pointerInside && focusPlanetIndex < 0 && Math.abs(zoomTarget) <= 0.03) {
        dragYawTarget *= Math.max(0, 1 - dt * 1.1);
        dragPitchTarget *= Math.max(0, 1 - dt * 1.1);
        syncViewModified();
      }

      for (let i = 0; i < planetRuntimes.length; i += 1) {
        const targetH = i === hoveredIndex ? 1 : 0;
        const nextH = (hoverValues[i] ?? 0) + (targetH - (hoverValues[i] ?? 0)) * Math.min(1, dt * 10);
        hoverValues[i] = nextH;
      }

      sunProgram.uniforms.uTime.value = elapsed;
      coronaProgram.uniforms.uTime.value = elapsed;
      planetProgram.uniforms.uTime.value = elapsed;
      bgStarProgram.uniforms.uTime.value = elapsed;
      beltProgram.uniforms.uTime.value = elapsed;
      cometProgram.uniforms.uTime.value = elapsed;
      fogProgram.uniforms.uTime.value = elapsed;

      if (dive) {
        if (!dive.recovering) {
          dive.elapsed += dt;
          if (dive.elapsed >= dive.duration && !dive.triggeredNav) {
            dive.triggeredNav = true;
            const target = dive.planet;
            if (target.portal.href.startsWith('/#')) {
              dive.recovering = true;
              dive.recoverElapsed = 0;
            }
            navigateRef.current(target);
          }
        } else {
          dive.recoverElapsed += dt;
        }
      }

      renderFrame();
      rafId = window.requestAnimationFrame(tick);
    };

    const stopLoop = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
    };

    const syncLoop = () => {
      if (disposed) return;
      if (pausedRef.current || document.hidden || !inViewport) {
        stopLoop();
        return;
      }
      if (rafId === null) {
        lastTs = performance.now();
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const resetView = () => {
      zoomTarget = 0;
      zoomFocusIndex = -1;
      dragYawTarget = 0;
      dragPitchTarget = 0;
      panOffsetXTarget = 0;
      focusPlanetIndex = -1;
      syncViewModified();
      if (pausedRef.current) {
        zoomCurrent = 0;
        dragYawCurrent = 0;
        dragPitchCurrent = 0;
        panOffsetXCurrent = 0;
        renderFrame();
      } else {
        syncLoop();
      }
    };

    controlsRef.current = { syncLoop, resetView };

    const toNdc = (clientX: number, clientY: number) => {
      if (rectDirty || !cachedRect) {
        cachedRect = canvas.getBoundingClientRect();
        rectDirty = false;
      }
      const rect = cachedRect;
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      return { x, y, inside: x >= -1 && x <= 1 && y >= -1 && y <= 1 };
    };

    const startDive = (planetIndex: number) => {
      const runtime = planetRuntimes[planetIndex];
      if (!runtime) return;

      const reduced =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (reduced || pausedRef.current) {
        navigateRef.current(runtime.spec);
        return;
      }

      focusPlanetIndex = -1;
      dive = {
        planet: runtime.spec,
        index: planetIndex,
        elapsed: 0,
        duration: 0.78,
        startPos: camera.position.clone(),
        startTarget: curCamTarget.clone(),
        startFov: camera.fov,
        triggeredNav: false,
        recovering: false,
        recoverElapsed: 0,
      };
      hoveredIndex = -1;
      syncHoverHud();
      syncLoop();
    };

    focusPlanetActionRef.current = (planetIndex: number) => {
      if (disposed || dive) return;
      const runtime = planetRuntimes[planetIndex];
      if (!runtime) return;

      focusPlanetIndex = planetIndex;
      focusHoldUntil = elapsed + 6.5;
      panOffsetXTarget = Math.max(
        -22,
        Math.min(2, runtime.worldPos.x - (baseCamTarget.x - 4.0)),
      );
      if (pausedRef.current) {
        panOffsetXCurrent = panOffsetXTarget;
        renderFrame();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || dive) return;
      pointerDown = true;
      downX = event.clientX;
      downY = event.clientY;
      movedSinceDown = 0;
      const pos = toNdc(event.clientX, event.clientY);
      if (pos && pos.inside) {
        pointerNdc.set(pos.x, pos.y);
        pointerInside = true;
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      const pos = toNdc(event.clientX, event.clientY);
      if (!pos || !pos.inside) {
        pointerInside = false;
        hoveredIndex = -1;
        syncHoverHud();
        return;
      }
      pointerInside = true;
      pointerNdc.set(pos.x, pos.y);

      if (pointerDown) {
        const dx = event.clientX - downX;
        const dy = event.clientY - downY;
        movedSinceDown = Math.max(movedSinceDown, Math.hypot(dx, dy));
        if (movedSinceDown > 6) {
          focusPlanetIndex = -1;
          panOffsetXTarget = 0;
          dragYawTarget = Math.max(-16, Math.min(8, dragYawTarget + event.movementX * -0.032));
          dragPitchTarget = Math.max(-2.8, Math.min(3.2, dragPitchTarget + event.movementY * 0.018));
          syncViewModified();
        }
      }

      if (pausedRef.current) {
        hoveredIndex = pickPlanetAtNdc(pointerNdc.x, pointerNdc.y);
        hoverValues.fill(0);
        if (hoveredIndex >= 0) hoverValues[hoveredIndex] = 1;
        renderFrame();
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      if (!pointerDown) return;
      pointerDown = false;
      if (movedSinceDown <= 6 && !dive) {
        const pos = toNdc(event.clientX, event.clientY);
        if (pos && pos.inside) {
          const hitIdx = pickPlanetAtNdc(pos.x, pos.y);
          if (hitIdx >= 0) {
            startDive(hitIdx);
          }
        }
      }
      syncHoverHud();
    };

    const onPointerLeave = () => {
      pointerInside = false;
      pointerDown = false;
      hoveredIndex = -1;
      syncHoverHud();
    };

    const onWheel = (event: WheelEvent) => {
      if (dive || window.scrollY > 24) return;
      event.preventDefault();
      const rawDy =
        event.deltaMode === 1
          ? event.deltaY * 32
          : event.deltaMode === 2
            ? event.deltaY * 320
            : event.deltaY;
      if (!Number.isFinite(rawDy) || rawDy === 0) return;

      const step = -Math.sign(rawDy) * Math.min(Math.abs(rawDy), 180) * 0.0014;
      const pos = toNdc(event.clientX, event.clientY);
      if (pos && pos.inside) {
        pointerInside = true;
        pointerNdc.set(pos.x, pos.y);
      }
      const hitIdx = pos && pos.inside ? pickPlanetAtNdc(pos.x, pos.y) : -1;
      if (step > 0 && hitIdx >= 0 && (zoomFocusIndex < 0 || zoomTarget < 0.25)) {
        zoomFocusIndex = hitIdx;
      }
      zoomTarget = Math.max(-0.65, Math.min(1.0, zoomTarget + step));
      if (zoomTarget <= 0.04) {
        zoomFocusIndex = -1;
      }
      syncViewModified();
      if (pausedRef.current) {
        zoomCurrent = zoomTarget;
        renderFrame();
      } else {
        syncLoop();
      }
    };

    const getPinchDist = (touches: TouchList): number | null => {
      if (touches.length < 2) return null;
      const a = touches[0]!;
      const b = touches[1]!;
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    };

    const onTouchStart = (event: TouchEvent) => {
      if (dive || event.touches.length !== 2) {
        pinchPrevDist = null;
        return;
      }
      event.preventDefault();
      pinchPrevDist = getPinchDist(event.touches);
    };

    const onTouchMove = (event: TouchEvent) => {
      if (dive || event.touches.length !== 2) return;
      event.preventDefault();
      const dist = getPinchDist(event.touches);
      if (dist === null) return;
      if (pinchPrevDist !== null) {
        const delta = (dist - pinchPrevDist) * 0.0045;
        zoomTarget = Math.max(-0.65, Math.min(1.0, zoomTarget + delta));
        if (zoomTarget <= 0.04) {
          zoomFocusIndex = -1;
        }
        syncViewModified();
        if (pausedRef.current) {
          zoomCurrent = zoomTarget;
          renderFrame();
        } else {
          syncLoop();
        }
      }
      pinchPrevDist = dist;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) {
        pinchPrevDist = null;
      }
    };

    const onDblClick = () => {
      if (dive) return;
      resetView();
    };

    const onVisibilityChange = () => {
      syncLoop();
    };

    const onContextLost = (event: Event) => {
      event.preventDefault();
      stopLoop();
      setFallbackMode('no-webgl');
    };

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            resize();
            renderFrame();
          })
        : null;
    resizeObserver?.observe(container);

    const viewportObserver =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver(
            (entries) => {
              const entry = entries[0];
              if (!entry) return;
              inViewport = entry.isIntersecting;
              syncLoop();
            },
            { threshold: 0.01 },
          )
        : null;
    viewportObserver?.observe(container);

    canvas.addEventListener('pointerdown', onPointerDown, { passive: true });
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerup', onPointerUp, { passive: true });
    window.addEventListener('scroll', markRectDirty, { passive: true });
    canvas.addEventListener('pointerleave', onPointerLeave, { passive: true });
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd, { passive: true });
    canvas.addEventListener('touchcancel', onTouchEnd, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    canvas.addEventListener('webglcontextlost', onContextLost);

    renderFrame();
    syncLoop();

    return () => {
      disposed = true;
      window.clearTimeout(readyFailsafeTimer);
      for (const im of planetImages) {
        im.onload = null;
        im.onerror = null;
      }
      controlsRef.current = null;
      focusPlanetActionRef.current = null;
      stopLoop();
      resizeObserver?.disconnect();
      viewportObserver?.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('scroll', markRectDirty);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDblClick);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      for (const item of disposables) {
        item.remove();
      }
      gl.deleteFramebuffer(fogRT.buffer);
      gl.deleteTexture(fogRT.texture.texture);
      gl.deleteTexture(noiseTex.texture);
      for (const tex of planetTextures) {
        gl.deleteTexture(tex.texture);
      }
      const loseContext = gl.getExtension('WEBGL_lose_context');
      loseContext?.loseContext();
      if (canvas.parentNode === container) {
        container.removeChild(canvas);
      }
    };
  }, [fallbackMode]);

  if (fallbackMode !== 'none') {
    return <StaticOpticalBackdrop onNavigatePlanet={onNavigatePlanet} />;
  }

  return (
    <>
      <div
        ref={containerRef}
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 -top-[var(--nav-height)] overflow-hidden"
      />

      {/* Screen-projected hovering planet targeting reticle & badge (updated via DOM transforms, 0 React re-renders) */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -top-[var(--nav-height)] z-10 overflow-hidden"
      >
        <div
          ref={hoverOverlayRef}
          className="pointer-events-none absolute top-0 left-0 opacity-0 transition-opacity duration-150"
          style={{ transform: 'translate3d(-9999px, -9999px, 0)' }}
        >
          <div
            ref={reticleRingRef}
            className="-translate-x-1/2 -translate-y-1/2 rounded-full border border-white/45 shadow-[0_0_24px_rgba(138,180,248,0.28)] transition-[width,height] duration-150"
            style={{ width: '56px', height: '56px' }}
          />
          <div
            ref={hoverLabelWrapRef}
            className="absolute left-0 -translate-x-1/2"
            style={{ top: '38px' }}
          >
            <div className="flex items-center gap-1.5 rounded-full border border-white/15 bg-[#0b0c0e]/85 px-3 py-1 text-[12px] whitespace-nowrap text-[#e3e3e3] shadow-lg backdrop-blur-md">
              <span ref={hoverTitleRef} className="font-medium text-white" />
              <span className="text-white/35">·</span>
              <span ref={hoverPortalRef} className="text-[#8ab4f8]" />
              <span ref={hoverAuRef} className="tabular-nums-mono ml-0.5 text-[11px] text-[#9aa0a6]" />
            </div>
          </div>
        </div>
      </div>

      {/* Left-edge off-screen planet bearing indicators (click to smoothly glide camera leftward to track planet) */}
      <div
        aria-label="屏外天体方位导览"
        className="pointer-events-none absolute inset-x-0 bottom-0 -top-[var(--nav-height)] z-20 overflow-hidden"
      >
        {SOLAR_PLANETS.map((planet, index) => (
          <button
            key={planet.id}
            ref={(el) => {
              edgeCueRefs.current[index] = el;
            }}
            type="button"
            tabIndex={-1}
            data-testid={`offscreen-planet-cue-${planet.id}`}
            aria-label={`将视角移向${planet.nameZh}（${planet.portal.label}）`}
            onClick={() => focusPlanetActionRef.current?.(index)}
            className="absolute top-0 left-4 inline-flex items-center gap-2 rounded-full border border-white/15 bg-[#0b0c0e]/60 px-2.5 py-1 text-[11px] text-[#f1f3f4]/92 backdrop-blur-md transition-[opacity,border-color,background-color] duration-200 hover:border-white/30 hover:bg-[#101420]/80 sm:left-7"
            style={{
              opacity: 0,
              visibility: 'hidden',
              pointerEvents: 'none',
              transform: 'translate3d(0, -200px, 0)',
            }}
          >
            <span aria-hidden="true" className="text-[12px] leading-none text-white/70">
              &lsaquo;
            </span>
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full"
              style={{
                backgroundColor: planet.warpTint,
                boxShadow: `0 0 6px ${planet.warpTint}88`,
              }}
            />
            <span aria-hidden="true" className="h-px w-2.5 bg-white/22" />
            <span className="tracking-[0.04em]">{planet.nameZh}</span>
            <span className="tabular-nums-mono text-[10px] tracking-[0.06em] text-white/55">
              {planet.auLabel}
            </span>
          </button>
        ))}
      </div>

      {/* Atmospheric dive-warp fade veil triggered at the climax of a 780ms planet click dive */}
      <div
        ref={warpVeilRef}
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 -top-[var(--nav-height)] z-30 opacity-0 transition-opacity duration-150"
      />
    </>
  );
}
