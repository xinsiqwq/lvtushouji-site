import { useEffect, useRef, useState } from 'react';
import {
  Camera,
  Geometry,
  Mat4,
  Mesh,
  Program,
  RenderTarget,
  Renderer,
  Transform,
  Vec2,
  Vec3,
} from 'ogl';
import type { ResolvedScheme } from '../../lib/theme';

type StarRingCanvasProps = {
  paused: boolean;
  theme: ResolvedScheme;
};

const R_DISK = 4.0;
const H_VOL = 0.44;
const SPIRAL_R0 = 0.18;
const SPIRAL_WINDING = 2.08;

function smoothSpiralTwist(rNorm: number): number {
  const d = rNorm - SPIRAL_R0;
  const s = 0.5 * (d + Math.sqrt(d * d + 0.008));
  return SPIRAL_WINDING * Math.log(1.0 + s / SPIRAL_R0);
}

const BAKE_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec2 position;
varying vec2 vUv;

void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

// One-time startup GPU bake of 2K Milky Way texture map:
// R = multi-scale flocculent spiral star clouds & spurs
// G = streamline-sheared ridged multifractal cosmic dust filaments
// B = compact H-II star-forming nebulae along leading dust shock fronts
// A = high-frequency diamond-dust unresolved stellar grain
const BAKE_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

varying vec2 vUv;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(
    0.211324865405187,
    0.366025403784439,
    -0.577350269189626,
    0.024390243902439
  );
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm5(vec2 p) {
  float sum = 0.0;
  float amp = 0.5;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    sum += amp * (snoise(p) * 0.5 + 0.5);
    p = rot * p * 2.07 + vec2(19.3, -7.1);
    amp *= 0.5;
  }
  return sum;
}

float ridgedDust5(vec2 p) {
  float sum = 0.0;
  float amp = 0.52;
  float weight = 1.0;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  for (int i = 0; i < 5; i++) {
    float n = 1.0 - abs(snoise(p));
    n = n * n * weight;
    weight = clamp(n * 1.45, 0.15, 1.0);
    sum += n * amp;
    p = rot * p * 2.18 + vec2(11.7, 23.4);
    amp *= 0.5;
  }
  return sum;
}

// Seam-free spiral streamline sampling (integrates along logarithmic tangent +/- h)
vec2 spiralFlowStep(vec2 p) {
  float r = length(p);
  if (r < 0.001) return vec2(1.0, 0.0);
  vec2 rad = p / r;
  vec2 circ = vec2(-rad.y, rad.x);
  // Bar inner flow transitions smoothly to ~18 deg logarithmic spiral pitch outward
  float pitch = mix(0.08, 0.305, smoothstep(0.10, 0.28, r));
  return normalize(rad * pitch + circ);
}

float shearedCloud(vec2 p, float scale) {
  vec2 flow1 = spiralFlowStep(p) * (0.042 / max(scale * 0.12, 0.5));
  vec2 p1 = p + flow1;
  vec2 p2 = p - flow1;
  return (fbm5(p1 * scale) + fbm5(p * scale) * 1.25 + fbm5(p2 * scale)) / 3.25;
}

float shearedDust(vec2 p, float scale) {
  vec2 flow = spiralFlowStep(p) * 0.011;
  float a = ridgedDust5((p - flow) * scale);
  float b = ridgedDust5(p * scale);
  float c = ridgedDust5((p + flow) * scale);
  return (a + b * 1.6 + c) / 3.6;
}

void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Smooth C-infinity unspiraled frame aligned with local galactic bar along X axis
  float d = r - 0.18;
  float s = 0.5 * (d + sqrt(d * d + 0.008));
  float rotA = -2.08 * log(1.0 + s / 0.18);
  float cA = cos(rotA);
  float sA = sin(rotA);
  vec2 unspiral = vec2(p.x * cA - p.y * sA, p.x * sA + p.y * cA);
  vec2 dirU = unspiral / max(r, 0.0001);

  // Subtle organic spiral wave warp (breaks mechanical symmetry across all arms)
  float radialBarBlend = smoothstep(0.11, 0.28, r);
  float warpA = (snoise(unspiral * 2.5 + vec2(3.2, -1.8)) * 0.65 + snoise(p * 4.2 - vec2(1.4, 2.9)) * 0.35) * radialBarBlend;
  float warpB = snoise(unspiral * 3.1 + vec2(-5.1, 4.3)) * radialBarBlend;

  // 2 Dominant Primary Arms (Scutum-Centaurus & Perseus) emerging gracefully from galactic bar tips
  float dMajor = abs(dirU.y + warpA * 0.15);
  float armWidthMajor = mix(0.28, 0.44, smoothstep(0.18, 0.88, r));
  float primaryRidge = exp(-pow(dMajor / armWidthMajor, 2.0) * 1.9);
  float primaryCore = exp(-pow(dMajor / (armWidthMajor * 0.42), 2.0) * 2.2);

  // 2 Rich Secondary Arms (Sagittarius-Carina & Norma-Outer) rotated ~84 deg in unspiral space
  vec2 secRot = vec2(dirU.x * 0.105 - dirU.y * 0.994, dirU.x * 0.994 + dirU.y * 0.105);
  float secLag = 0.24 * log(1.0 + s / 0.18);
  vec2 secLagDir = vec2(secRot.x * cos(secLag) - secRot.y * sin(secLag), secRot.x * sin(secLag) + secRot.y * cos(secLag));
  float dMinor = abs(secLagDir.y + warpB * 0.17);
  float secondaryWidth = mix(0.22, 0.36, smoothstep(0.20, 0.86, r));
  float secondaryRidge = exp(-pow(dMinor / secondaryWidth, 2.0) * 2.1) * smoothstep(0.16, 0.34, r) * 0.68;

  // Orion Local Spur & Perseus outer sub-spurs bridging mid-to-outer disk
  float orionAngle = abs(dirU.x * 0.72 + dirU.y * 0.69 + warpA * 0.14);
  float orionSpur = exp(-pow(orionAngle / 0.19, 2.0) * 2.2) * smoothstep(0.28, 0.44, r) * smoothstep(0.84, 0.56, r) * 0.46;

  float radialEnv = smoothstep(0.10, 0.23, r) * smoothstep(0.97, 0.42, r);

  // Braided flocculent star-cloud filaments using 360-deg spiral streamline advection (zero transverse arm striping)
  float cloudMacro = shearedCloud(p, 5.0);
  float cloudMid = shearedCloud(p + vec2(4.2, -3.7), 12.0);
  float cloudFine = shearedCloud(p - vec2(2.8, 6.1), 26.0);
  float cloudRibbon = shearedCloud(p + vec2(-6.3, 1.9), 8.2);
  float cloudRaw = smoothstep(0.18, 0.84, cloudMacro * 0.36 + cloudMid * 0.30 + cloudRibbon * 0.22 + cloudFine * 0.12);
  float flocculent = pow(cloudRaw, 1.35);

  float outerMist = exp(-r * r * 2.4) * mix(0.08, 0.34, cloudMid);
  float armDensity = clamp(
    (primaryRidge * 0.72 + primaryCore * 0.44 + secondaryRidge + orionSpur) * radialEnv * mix(0.18, 1.54, flocculent) +
    outerMist * smoothstep(0.97, 0.28, r),
    0.0,
    1.25
  );

  // Knife-sharp branching cosmic dust veins along concave shock fronts + fine spiderweb spurs
  float dustPhase = 0.24;
  vec2 dustDir = vec2(dirU.x * cos(dustPhase) - dirU.y * sin(dustPhase), dirU.x * sin(dustPhase) + dirU.y * cos(dustPhase));
  float dDustMajor = abs(dustDir.y + warpA * 0.14);
  float dustShockBand = exp(-pow(dDustMajor / 0.20, 2.0) * 2.2) * smoothstep(0.08, 0.22, r);

  vec2 secDustDir = vec2(secLagDir.x * 0.96 - secLagDir.y * 0.26, secLagDir.x * 0.26 + secLagDir.y * 0.96);
  float dustSecBand = exp(-pow(abs(secDustDir.y + warpB * 0.15) / 0.16, 2.0) * 2.2) * smoothstep(0.16, 0.30, r) * 0.76;

  float dustFilaments = shearedDust(p, 11.5);
  float dustWeb = ridgedDust5(p * 27.0 + vec2(cloudMacro * 1.4, -cloudMid * 1.4));
  float combinedRidges = smoothstep(0.28, 0.80, dustFilaments * 0.58 + dustWeb * 0.52);

  float barDustLanes = exp(-pow(abs(p.y + warpA * 0.045) / 0.052, 2.0)) * smoothstep(0.04, 0.12, abs(p.x)) * smoothstep(0.25, 0.14, abs(p.x)) * 0.85;
  float dustEnvelope = smoothstep(0.05, 0.14, r) * smoothstep(0.92, 0.24, r);
  float dustField = clamp((dustShockBand * 0.96 + dustSecBand + barDustLanes + primaryRidge * 0.58 + secondaryRidge * 0.52) * combinedRidges * dustEnvelope, 0.0, 1.0);

  // Crisp ruby/rose H-II star-forming knots strung like jewels along spiral ridges
  float h2Raw = max(0.0, snoise(p * 22.0 + cloudMid * 1.7)) * 0.58 + max(0.0, snoise(p * 46.0 - 5.3)) * 0.42;
  float h2Mask = pow(h2Raw, 2.85) * (primaryCore * 1.15 + secondaryRidge * 0.95 + orionSpur * 1.0) * smoothstep(0.16, 0.30, r) * smoothstep(0.90, 0.38, r);
  float h2 = clamp(h2Mask * 2.2, 0.0, 1.0);

  // Dense unresolved micro-star diamond-dust grain across bulge + spiral star-clouds
  float microStar = pow(max(0.0, snoise(p * 82.0 + 3.1)), 2.6) * 0.55 + pow(max(0.0, snoise(p * 168.0 - 9.4)), 2.6) * 0.45;
  float starGrain = clamp(microStar * 1.95 * (armDensity + exp(-r * r * 9.0) * 0.8), 0.0, 1.0);

  gl_FragColor = vec4(
    clamp(armDensity, 0.0, 1.0),
    dustField,
    h2,
    starGrain
  );
}
`;

const VOLUME_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vLocalPos;

void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function buildVolumeFragmentShader(raySteps: number): string {
  return /* glsl */ `
precision highp float;

uniform sampler2D uGalaxyTex;
uniform vec3 uLocalCamPos;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uDark;
uniform float uAspect;
uniform vec2 uPointer;
uniform float uPointerStrength;
uniform vec2 uRippleOrigin;
uniform float uRippleAge;

varying vec3 vLocalPos;

vec2 intersectBox(vec3 ro, vec3 rd, vec3 bMin, vec3 bMax) {
  vec3 invD = 1.0 / rd;
  vec3 t0 = (bMin - ro) * invD;
  vec3 t1 = (bMax - ro) * invD;
  vec3 tSmall = min(t0, t1);
  vec3 tLarge = max(t0, t1);
  float tNear = max(max(tSmall.x, tSmall.y), tSmall.z);
  float tFar = min(min(tLarge.x, tLarge.y), tLarge.z);
  return vec2(tNear, tFar);
}

// Interleaved Gradient Noise (eliminates visible raymarch slice rings)
float ign(vec2 coord) {
  return fract(52.9829189 * fract(dot(coord, vec2(0.06711056, 0.00583715))));
}

vec3 acesFilmic(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 ro = uLocalCamPos;
  vec3 rd = normalize(vLocalPos - ro);
  vec3 bMin = vec3(-${R_DISK.toFixed(1)}, -${H_VOL.toFixed(2)}, -${R_DISK.toFixed(1)});
  vec3 bMax = vec3(${R_DISK.toFixed(1)}, ${H_VOL.toFixed(2)}, ${R_DISK.toFixed(1)});

  vec2 hit = intersectBox(ro, rd, bMin, bMax);
  float tNear = max(0.0, hit.x);
  float tFar = hit.y;
  if (tFar <= tNear) discard;

  float dt = (tFar - tNear) / float(${raySteps});
  float jitter = ign(gl_FragCoord.xy);
  float t = tNear + dt * jitter;

  vec3 transmittance = vec3(1.0);
  vec3 radiance = vec3(0.0);
  float rawLightAcc = 0.0;

  // Light-mode archival ink plate accumulators
  vec3 inkColorAcc = vec3(0.0);
  float inkAlphaAcc = 0.0;

  float minR = 1.0;

  for (int i = 0; i < ${raySteps}; i++) {
    vec3 pos = ro + rd * t;
    float rNorm = length(pos.xz) / ${R_DISK.toFixed(1)};
    minR = min(minR, rNorm);

    if (rNorm < 0.98) {
      vec2 texUv = pos.xz / ${(R_DISK * 2.0).toFixed(1)} + 0.5;
      vec4 gData = texture2D(uGalaxyTex, texUv);

      // 3D peanut/barred central bulge & super-luminous nucleus (scaled to H_VOL = 0.44)
      float barE = length(vec2(pos.x / 0.88, pos.z / 0.30));
      float hBulge = 0.048 + 0.22 * exp(-rNorm * 3.0);
      float bulgeVert = exp(-(pos.y * pos.y) / (2.0 * hBulge * hBulge));
      float bar3D = exp(-pow(barE, 1.45) * 1.95) * bulgeVert;
      float bulgeHalo = exp(-rNorm * rNorm * 11.5) * bulgeVert * 0.62;
      float nuc = length(vec3(pos.x / 0.44, pos.y / 0.18, pos.z / 0.34));
      float nucleus3D = exp(-nuc * nuc * 4.2);

      // Thin stellar spiral disk vs razor-crisp equatorial dust plane (zero step aliasing at 26/36 steps)
      float hDisk = 0.064 + 0.040 * rNorm;
      float diskVert = exp(-(pos.y * pos.y) / (2.0 * hDisk * hDisk));
      float hDust = 0.048 + 0.018 * rNorm;
      float dustVert = exp(-(pos.y * pos.y) / (2.0 * hDust * hDust));

      // Interactive screen-space pointer proximity glow & expanding gravitational ripple
      vec4 clipPos = projectionMatrix * (modelViewMatrix * vec4(pos, 1.0));
      vec2 ndc = clipPos.xy / max(clipPos.w, 0.0001);
      vec2 ndcAspect = vec2(uAspect, 1.0);

      float ptrDist = length((ndc - uPointer) * ndcAspect);
      float ptrGlow = smoothstep(0.45, 0.0, ptrDist) * uPointerStrength * (0.22 + gData.r * 0.85 + bar3D * 0.35);

      float rplGlow = 0.0;
      if (uRippleAge >= 0.0 && uRippleAge < 2.8) {
        float rRadius = uRippleAge * 0.85;
        float dRpl = length((ndc - uRippleOrigin) * ndcAspect);
        float ring = exp(-pow((dRpl - rRadius) * 8.0, 2.0));
        float fade = 1.0 - smoothstep(0.4, 2.8, uRippleAge);
        rplGlow = ring * fade * (0.28 + gData.r * 1.05 + bar3D * 0.4);
      }

      // --- Dark Mode HDR Volumetric Radiative Transfer (rich sapphire + golden core, zero chalk washout) ---
      vec3 nucCol = vec3(1.36, 1.14, 0.86);
      vec3 barCol = vec3(1.10, 0.65, 0.30);
      vec3 innerArmCol = vec3(0.84, 0.72, 0.58);
      vec3 armBlue = vec3(0.26, 0.56, 1.14);
      vec3 armCyanWhite = vec3(0.68, 0.84, 1.12);
      vec3 h2Rose = vec3(1.48, 0.28, 0.42);

      float armBoost = gData.r * (0.74 + 0.72 * gData.a) * diskVert;
      float innerTransition = smoothstep(0.42, 0.14, rNorm) * armBoost;
      float diskGlow = exp(-rNorm * rNorm * 2.5) * diskVert * 0.16;

      vec3 armCol = mix(armBlue, armCyanWhite, clamp(gData.r * 0.78 + gData.a * 0.52, 0.0, 1.0));
      armCol = mix(armCol, innerArmCol, clamp(innerTransition * 0.72, 0.0, 0.72));

      vec3 emitDark =
        nucCol * nucleus3D * 1.50 +
        barCol * (bar3D * 1.18 + bulgeHalo * 0.78) +
        armCol * (armBoost * 1.18 + diskGlow * 0.68) +
        h2Rose * (gData.b * diskVert * 1.38) +
        vec3(0.60, 0.82, 1.15) * ((ptrGlow * 0.34 + rplGlow * 0.46) * diskVert);

      // Physical Beer-Lambert interstellar reddening along branching dark dust veins
      float dTau = gData.g * dustVert * dt * 13.5;
      vec3 sigmaDust = vec3(0.88, 1.44, 2.22); // strong blue scatter -> rich mahogany/crimson-black dust fissures
      vec3 stepExt = exp(-dTau * sigmaDust);

      radiance += transmittance * emitDark * dt * 2.25;
      rawLightAcc += (nucleus3D * 1.4 + bar3D * 1.0 + bulgeHalo * 0.55 + armBoost * 1.15 + diskGlow * 0.4) * dt * 2.25;
      transmittance *= stepExt;

      // --- Light Mode Archival Ink Plate Volumetric Accumulation ---
      float lCenterProtect = mix(0.55, 1.0, smoothstep(0.06, 0.32, rNorm));
      float dLight = (
        nucleus3D * 0.72 +
        (bar3D * 0.68 + bulgeHalo * 0.38) +
        armBoost * 1.16 +
        gData.b * diskVert * 0.92 +
        gData.g * dustVert * 1.25 * smoothstep(0.03, 0.28, gData.r + bar3D)
      ) * dt * 2.05 * lCenterProtect;

      vec3 lightSampleCol = mix(vec3(0.09, 0.29, 0.74), vec3(0.06, 0.19, 0.52), clamp(gData.r, 0.0, 1.0));
      lightSampleCol = mix(lightSampleCol, vec3(0.56, 0.27, 0.13), clamp((bar3D + bulgeHalo * 0.58 + nucleus3D) * 0.92, 0.0, 1.0));
      lightSampleCol = mix(lightSampleCol, vec3(0.76, 0.22, 0.22), clamp(gData.b * 1.4, 0.0, 0.80));
      lightSampleCol = mix(lightSampleCol, vec3(0.08, 0.11, 0.20), clamp(gData.g * 0.98, 0.0, 0.88));
      lightSampleCol += vec3(0.06, 0.28, 0.78) * ((ptrGlow * 0.16 + rplGlow * 0.24) * diskVert);

      float remain = 1.0 - inkAlphaAcc;
      float addA = clamp(dLight * remain, 0.0, 1.0);
      inkColorAcc += lightSampleCol * addA;
      inkAlphaAcc += addA;
    }

    t += dt;
  }

  float edgeFade = smoothstep(0.95, 0.62, minR);

  // ACES filmic tone map + subtle gamma lift for luminous core clarity without white washout
  vec3 hdrDark = pow(acesFilmic(radiance * 1.06), vec3(0.94));
  float lumDark = max(hdrDark.r, max(hdrDark.g, hdrDark.b));
  float dustOcc = (1.0 - dot(transmittance, vec3(0.333))) * smoothstep(0.02, 0.24, rawLightAcc);
  float alphaDark = clamp(max(lumDark * 1.38, dustOcc * 0.96), 0.0, 0.98) * edgeFade;
  vec3 outDarkCol = mix(vec3(0.04, 0.025, 0.025), hdrDark, clamp(lumDark * 2.2, 0.0, 1.0));

  vec3 outLightCol = inkAlphaAcc > 0.001 ? clamp(inkColorAcc / inkAlphaAcc, 0.0, 1.0) : vec3(0.15, 0.30, 0.60);
  float alphaLight = clamp(inkAlphaAcc * 0.76, 0.0, 0.72) * edgeFade;

  vec3 finalCol = mix(outLightCol, outDarkCol, uDark);
  float finalAlpha = mix(alphaLight, alphaDark, uDark);
  if (finalAlpha < 0.002) discard;

  gl_FragColor = vec4(finalCol, finalAlpha);
}
`;
}

const STAR_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute float aSize;
attribute float aSeed;
attribute float aBand;
attribute float aKind;
attribute float aSpike;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uPixelRatio;
uniform float uAspect;
uniform vec2 uPointer;
uniform float uPointerStrength;
uniform vec2 uRippleOrigin;
uniform float uRippleAge;

varying float vDepth;
varying float vAccent;
varying float vKind;
varying float vSpike;
varying float vTemp;
varying float vAlpha;

void main() {
  float radius = max(0.15, length(position.xz));
  float microDrift = uTime * (0.011 / (0.65 + radius * 0.6));
  float c = cos(microDrift);
  float s = sin(microDrift);
  vec3 pos = vec3(
    position.x * c - position.z * s,
    position.y,
    position.x * s + position.z * c
  );

  vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
  vec4 clipPos = projectionMatrix * mvPosition;
  vec2 ndc = clipPos.xy / max(clipPos.w, 0.0001);

  vec2 ndcAspect = vec2(uAspect, 1.0);
  vec2 toStar = (ndc - uPointer) * ndcAspect;
  float dist = length(toStar);
  float influence = smoothstep(0.45, 0.0, dist) * uPointerStrength;
  vec2 dir = dist > 0.0001 ? toStar / dist : vec2(0.0, 1.0);
  vec2 tangent = vec2(-dir.y, dir.x);
  mvPosition.xy += (dir * 0.15 + tangent * 0.14) * influence * (0.35 + 0.65 * aBand);

  float ripple = 0.0;
  if (uRippleAge >= 0.0 && uRippleAge < 2.8) {
    float rippleRadius = uRippleAge * 0.85;
    vec2 fromRipple = (ndc - uRippleOrigin) * ndcAspect;
    float dRipple = length(fromRipple);
    float ring = exp(-pow((dRipple - rippleRadius) * 8.0, 2.0));
    float decay = 1.0 - smoothstep(0.4, 2.8, uRippleAge);
    ripple = ring * decay;
    vec2 rDir = dRipple > 0.0001 ? fromRipple / dRipple : vec2(1.0, 0.0);
    mvPosition.xy += rDir * ripple * 0.13;
    mvPosition.z += ripple * 0.16;
  }

  gl_Position = projectionMatrix * mvPosition;

  float depthDist = max(1.4, -mvPosition.z);
  float bokeh = clamp(abs(depthDist - 8.4) * 0.22, 0.0, 1.0);
  vDepth = bokeh;
  vKind = aKind;
  vSpike = aSpike;
  vTemp = fract(aSeed * 13.7);
  vAccent = clamp(influence * 1.15 + ripple * 1.3, 0.0, 1.0);

  // Sub-1Hz subtle stellar scintillation (WCAG safe)
  float twinkle = 0.86 + 0.14 * sin(uTime * 0.95 + aSeed * 62.83);
  vAlpha = mix(0.92, 0.42, bokeh) * twinkle * mix(0.95, 0.56, aBand * 0.72);

  float pointSize = aSize * uPixelRatio * (15.5 / depthDist) * (1.0 + ripple * 0.28 + influence * 0.2);
  gl_PointSize = aSpike > 0.5 ? clamp(pointSize, 6.0, 26.0) : clamp(pointSize, 1.05, 6.5);
}
`;

const STAR_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uDark;

varying float vDepth;
varying float vAccent;
varying float vKind;
varying float vSpike;
varying float vTemp;
varying float vAlpha;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;

  float core = exp(-r * r * 18.0);
  float halo = exp(-r * r * 3.8) * (0.26 + 0.14 * vDepth);

  // Whisper-thin 4-point diffraction spikes only on brightest supergiant stars
  float spike = 0.0;
  if (vSpike > 0.5) {
    float sx = exp(-abs(uv.x) * 34.0) * exp(-abs(uv.y) * 4.5);
    float sy = exp(-abs(uv.y) * 34.0) * exp(-abs(uv.x) * 4.5);
    spike = (sx + sy) * 0.62 * (1.0 - smoothstep(0.65, 1.0, r));
  }

  float shape = clamp(core + halo + spike, 0.0, 1.25);

  // Planck blackbody-inspired star colors
  vec3 hotOB = vec3(0.66, 0.82, 1.00);
  vec3 whiteA = vec3(0.95, 0.97, 1.00);
  vec3 warmFG = vec3(1.00, 0.92, 0.77);
  vec3 goldK = vec3(0.98, 0.76, 0.49);
  vec3 roseH2 = vec3(0.98, 0.54, 0.52);

  vec3 armSpec = mix(hotOB, whiteA, smoothstep(0.25, 0.7, vTemp));
  armSpec = mix(armSpec, warmFG, smoothstep(0.75, 1.0, vTemp));
  vec3 bulgeSpec = mix(warmFG, goldK, smoothstep(0.2, 0.9, vTemp));

  float tArm = smoothstep(0.08, 0.42, vKind) * (1.0 - smoothstep(0.48, 0.78, vKind));
  float tKnot = smoothstep(0.46, 0.72, vKind) * (1.0 - smoothstep(0.78, 0.94, vKind));
  float tHalo = smoothstep(0.82, 0.98, vKind);

  vec3 darkCol = mix(bulgeSpec, armSpec, tArm);
  darkCol = mix(darkCol, roseH2, tKnot * 0.85);
  darkCol = mix(darkCol, vec3(0.78, 0.82, 0.90), tHalo);
  darkCol = mix(darkCol, vec3(1.0), core * 0.65);

  vec3 lightCol = mix(vec3(0.56, 0.28, 0.14), vec3(0.06, 0.27, 0.72), tArm);
  lightCol = mix(lightCol, vec3(0.74, 0.26, 0.22), tKnot);
  lightCol = mix(lightCol, vec3(0.24, 0.30, 0.42), tHalo);

  vec3 baseCol = mix(lightCol, darkCol, uDark);
  vec3 accentCol = mix(vec3(0.06, 0.34, 0.86), vec3(0.85, 0.92, 1.0), uDark);
  vec3 color = mix(baseCol, accentCol, vAccent * 0.42);

  float themeGain = mix(0.72, 0.86, uDark);
  float alpha = shape * vAlpha * (themeGain + vAccent * 0.25);

  gl_FragColor = vec4(color, clamp(alpha, 0.0, 0.92));
}
`;

const BG_VERTEX_SHADER = /* glsl */ `
precision highp float;

attribute vec3 position;
attribute float aSize;
attribute float aSeed;

uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uTime;
uniform float uPixelRatio;

varying float vAlpha;
varying float vWarmth;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float dist = max(2.0, -mvPosition.z);
  float twinkle = 0.82 + 0.18 * sin(uTime * 0.7 + aSeed * 50.0);
  vAlpha = twinkle * (0.28 + 0.56 * aSeed);
  vWarmth = fract(aSeed * 7.13);
  gl_PointSize = clamp(aSize * uPixelRatio * (10.5 / dist), 1.0, 3.8);
}
`;

const BG_FRAGMENT_SHADER = /* glsl */ `
precision highp float;

uniform float uDark;

varying float vAlpha;
varying float vWarmth;

void main() {
  vec2 uv = gl_PointCoord - vec2(0.5);
  float r = length(uv) * 2.0;
  if (r > 1.0) discard;
  float shape = exp(-r * r * 6.0);
  vec3 darkCol = mix(vec3(0.76, 0.84, 0.99), vec3(0.99, 0.90, 0.75), smoothstep(0.65, 1.0, vWarmth));
  vec3 lightCol = mix(vec3(0.14, 0.31, 0.62), vec3(0.45, 0.30, 0.22), smoothstep(0.65, 1.0, vWarmth));
  vec3 color = mix(lightCol, darkCol, uDark);
  float alpha = shape * vAlpha * mix(0.28, 0.65, uDark);
  gl_FragColor = vec4(color, alpha);
}
`;

function createVolumeBoxGeometry(gl: Renderer['gl']) {
  const rx = R_DISK;
  const ry = H_VOL;
  const rz = R_DISK;

  // 8 vertices of AABB:
  // 0: (-,-,-), 1: (+,-,-), 2: (+,+,-), 3: (-,+,-)
  // 4: (-,-,+), 5: (+,-,+), 6: (+,+,+), 7: (-,+,+)
  // Outward-facing CCW triangles so cullFace: gl.BACK draws ONLY front surface toward camera
  const v = [
    [-rx, -ry, -rz],
    [rx, -ry, -rz],
    [rx, ry, -rz],
    [-rx, ry, -rz],
    [-rx, -ry, rz],
    [rx, -ry, rz],
    [rx, ry, rz],
    [-rx, ry, rz],
  ] as const;

  const tris = [
    4, 5, 6, 4, 6, 7, // +Z front
    1, 0, 3, 1, 3, 2, // -Z back
    3, 7, 6, 3, 6, 2, // +Y top
    0, 1, 5, 0, 5, 4, // -Y bottom
    1, 2, 6, 1, 6, 5, // +X right
    0, 4, 7, 0, 7, 3, // -X left
  ];

  const positions = new Float32Array(tris.length * 3);
  for (let i = 0; i < tris.length; i += 1) {
    const corner = v[tris[i]!]!;
    positions[i * 3] = corner[0];
    positions[i * 3 + 1] = corner[1];
    positions[i * 3 + 2] = corner[2];
  }

  return new Geometry(gl, {
    position: { size: 3, data: positions },
  });
}

function createGalaxyStarBuffers(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);
  const bands = new Float32Array(count);
  const kinds = new Float32Array(count);
  const spikes = new Float32Array(count);

  let state = 20261124;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const gauss = () => {
    const u1 = Math.max(1e-6, rand());
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  // Pre-seed 36 OB star-cloud clumps matching the 2K primary spiral arms
  const clusterCenters: Array<{ theta: number; rNorm: number }> = [];
  for (let c = 0; c < 36; c += 1) {
    const armOffset = c % 2 === 0 ? 0 : Math.PI;
    const rNorm = 0.21 + (c / 36) * 0.62 + (rand() - 0.5) * 0.035;
    const theta = armOffset + smoothSpiralTwist(rNorm) + (rand() - 0.5) * 0.065;
    clusterCenters.push({ theta, rNorm });
  }

  for (let i = 0; i < count; i += 1) {
    const roll = rand();
    let x = 0;
    let y = 0;
    let z = 0;
    let band = 0;
    let kind = 0.35;
    let isHeroStar = false;

    if (roll < 0.20) {
      // 3D peanut/barred central bulge & galactic bar along local X axis
      const along = gauss() * 0.195 * R_DISK;
      const across = gauss() * 0.068 * R_DISK;
      x = along;
      z = across;
      const rNorm = Math.min(1, Math.hypot(x, z) / R_DISK);
      const hBulge = 0.045 + 0.26 * Math.exp(-rNorm * 3.4);
      y = gauss() * hBulge;
      band = rNorm;
      kind = rand() < 0.14 ? 0.22 : 0.0;
    } else if (roll < 0.72) {
      // 2 Primary spiral arms tightly following smoothSpiralTwist(rNorm)
      const isCluster = rand() < 0.28;
      let rNorm: number;
      let theta: number;

      if (isCluster) {
        const cluster = clusterCenters[Math.floor(rand() * clusterCenters.length)]!;
        rNorm = Math.max(0.16, Math.min(0.92, cluster.rNorm + gauss() * 0.02));
        theta = cluster.theta + gauss() * 0.046;
        kind = rand() < 0.35 ? 0.68 : 0.36;
        isHeroStar = rand() < 0.015;
      } else {
        const armOffset = rand() < 0.5 ? 0 : Math.PI;
        const t = Math.pow(rand(), 0.75);
        rNorm = Math.max(0.14, Math.min(0.94, 0.16 + t * 0.75 + gauss() * 0.022));
        theta = armOffset + smoothSpiralTwist(rNorm) + (0.048 + 0.082 * t) * gauss();
        kind = t < 0.12 ? 0.16 : rand() < 0.10 ? 0.66 : 0.36;
        isHeroStar = rand() < 0.004;
      }

      const radius = rNorm * R_DISK;
      x = Math.cos(theta) * radius;
      z = Math.sin(theta) * radius;
      y = gauss() * (0.025 + 0.032 * (1 - rNorm));
      band = rNorm;
    } else if (roll < 0.88) {
      // 2 Secondary arms (Sagittarius / Norma rotated ~84 deg = 1.466 rad) + Orion Local Spur
      const isOrion = rand() < 0.22;
      if (isOrion) {
        const rNorm = 0.30 + rand() * 0.40;
        const theta = 0.72 + smoothSpiralTwist(rNorm) + gauss() * 0.062;
        const radius = rNorm * R_DISK;
        x = Math.cos(theta) * radius;
        z = Math.sin(theta) * radius;
        y = gauss() * 0.032;
        band = rNorm;
        kind = 0.40;
      } else {
        const armOffset = (rand() < 0.5 ? 0 : Math.PI) + 1.466;
        const t = Math.pow(rand(), 0.82);
        const rNorm = Math.max(0.18, Math.min(0.91, 0.18 + t * 0.70 + gauss() * 0.03));
        const theta = armOffset + smoothSpiralTwist(rNorm) * 1.12 + gauss() * (0.075 + 0.10 * t);
        const radius = rNorm * R_DISK;
        x = Math.cos(theta) * radius;
        z = Math.sin(theta) * radius;
        y = gauss() * 0.036;
        band = rNorm;
        kind = rand() < 0.12 ? 0.66 : 0.42;
      }
      isHeroStar = rand() < 0.003;
    } else {
      // Outer galactic stellar halo & globular cluster mist
      const angle = rand() * Math.PI * 2;
      const rNorm = 0.20 + Math.pow(rand(), 0.74) * 0.78;
      const radius = rNorm * R_DISK;
      x = Math.cos(angle) * radius;
      z = Math.sin(angle) * radius;
      y = gauss() * (0.08 + 0.22 * rand());
      band = Math.min(1, rNorm);
      kind = 0.94;
      isHeroStar = rand() < 0.004;
    }

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    // Power-law astronomical magnitude hierarchy: vast diamond-dust micro-stars + rare bright flares
    if (isHeroStar) {
      sizes[i] = 3.2 + rand() * 1.8;
      spikes[i] = 1.0;
    } else {
      const magRoll = rand();
      sizes[i] =
        magRoll > 0.93
          ? 1.45 + rand() * 0.75
          : magRoll > 0.65
            ? 0.82 + rand() * 0.48
            : 0.44 + rand() * 0.36;
      spikes[i] = 0.0;
    }

    seeds[i] = rand();
    bands[i] = band;
    kinds[i] = kind;
  }

  return { positions, sizes, seeds, bands, kinds, spikes };
}

function createDeepFieldBuffers(count: number) {
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  const seeds = new Float32Array(count);

  let state = 987654321;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };

  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (rand() - 0.5) * 24.0;
    positions[i * 3 + 1] = (rand() - 0.5) * 20.0;
    positions[i * 3 + 2] = -2.4 - rand() * 7.2;
    sizes[i] = rand() > 0.92 ? 1.7 + rand() * 1.1 : 0.65 + rand() * 0.85;
    seeds[i] = rand();
  }

  return { positions, sizes, seeds };
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

function StaticOpticalBackdrop({ theme }: { theme: ResolvedScheme }) {
  const dark = theme === 'dark';
  const armStroke = dark ? 'rgba(138, 180, 248, 0.30)' : 'rgba(26, 95, 200, 0.24)';
  const spurStroke = dark ? 'rgba(196, 220, 255, 0.16)' : 'rgba(26, 95, 200, 0.14)';
  const coreFill = dark ? 'rgba(246, 226, 196, 0.18)' : 'rgba(148, 78, 46, 0.14)';

  return (
    <div
      aria-hidden="true"
      data-testid="star-ring-static-fallback"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        background: dark
          ? 'radial-gradient(56% 42% at 50% 50%, rgba(240, 196, 136, 0.14) 0%, rgba(124, 176, 250, 0.08) 38%, transparent 74%)'
          : 'radial-gradient(56% 42% at 50% 50%, rgba(145, 76, 44, 0.11) 0%, rgba(26, 86, 192, 0.07) 38%, transparent 74%)',
      }}
    >
      <svg
        viewBox="0 0 1200 720"
        preserveAspectRatio="xMidYMid slice"
        className="h-full w-full opacity-85"
      >
        <g transform="translate(600 360) rotate(-13) scale(1 0.61)">
          <path
            d="M 110 0 C 210 18, 305 110, 260 225 C 210 350, -35 420, -255 345"
            fill="none"
            stroke={armStroke}
            strokeWidth="14"
            strokeLinecap="round"
          />
          <path
            d="M -110 0 C -210 -18, -305 -110, -260 -225 C -210 -350, 35 -420, 255 -345"
            fill="none"
            stroke={armStroke}
            strokeWidth="14"
            strokeLinecap="round"
          />
          <path
            d="M 105 12 C 180 75, 210 180, 145 275"
            fill="none"
            stroke={spurStroke}
            strokeWidth="6"
            strokeDasharray="6 10"
          />
          <path
            d="M -105 -12 C -180 -75, -210 -180, -145 -275"
            fill="none"
            stroke={spurStroke}
            strokeWidth="6"
            strokeDasharray="6 10"
          />
          <ellipse cx="0" cy="0" rx="128" ry="48" fill={coreFill} />
          <ellipse
            cx="0"
            cy="0"
            rx="380"
            ry="380"
            fill="none"
            stroke={dark ? 'rgba(227, 227, 227, 0.08)' : 'rgba(31, 31, 31, 0.08)'}
          />
        </g>
      </svg>
    </div>
  );
}

/** 2-Stage 2K Pre-Baked + 3D Volumetric Raymarched Milky Way with Beer-Lambert reddening & 48K stars. */
export default function StarRingCanvas({ paused, theme }: StarRingCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const themeRef = useRef(theme);
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

  const controlsRef = useRef<{
    syncLoop: () => void;
    setDark: (dark: number) => void;
  } | null>(null);

  pausedRef.current = paused;
  themeRef.current = theme;

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
    controlsRef.current?.setDark(theme === 'dark' ? 1 : 0);
  }, [theme]);

  useEffect(() => {
    controlsRef.current?.syncLoop();
  }, [paused]);

  useEffect(() => {
    if (fallbackMode !== 'none') return;
    const container = containerRef.current;
    if (!container) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const probeCanvas = document.createElement('canvas');
    const contextAttrs: WebGLContextAttributes = {
      alpha: true,
      antialias: true,
      depth: false,
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
        depth: false,
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
    container.innerHTML = '';
    container.appendChild(canvas);

    gl.clearColor(0, 0, 0, 0);

    const isSoftware = detectSoftwareWebGL(gl);
    const maxTexSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048);
    const bakeSize = Math.min(isSoftware ? 1024 : 2048, maxTexSize);
    const raySteps = isSoftware ? 26 : 36;
    const galaxyStarCount = isSoftware ? 24000 : 48000;
    const bgStarCount = isSoftware ? 1800 : 2400;

    // Stage 0: One-time startup GPU bake of 2K/1K Milky Way multi-channel map into offscreen RenderTarget
    const bakeTarget = new RenderTarget(gl, {
      width: bakeSize,
      height: bakeSize,
      depth: false,
      stencil: false,
      wrapS: gl.CLAMP_TO_EDGE,
      wrapT: gl.CLAMP_TO_EDGE,
      minFilter: gl.LINEAR,
      magFilter: gl.LINEAR,
    });
    const bakeGeometry = new Geometry(gl, {
      position: {
        size: 2,
        data: new Float32Array([-1, -1, 3, -1, -1, 3]),
      },
    });
    const bakeProgram = new Program(gl, {
      vertex: BAKE_VERTEX_SHADER,
      fragment: BAKE_FRAGMENT_SHADER,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      cullFace: false,
    });
    const bakeMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: bakeGeometry,
      program: bakeProgram,
      frustumCulled: false,
    });
    renderer.render({ scene: bakeMesh, target: bakeTarget, clear: true });

    // Generate trilinear mipmaps cleanly while keeping OGL Texture internal state synced
    bakeTarget.texture.bind();
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    bakeTarget.texture.minFilter = gl.LINEAR_MIPMAP_LINEAR;
    (bakeTarget.texture as unknown as { state: { minFilter: number } }).state.minFilter =
      gl.LINEAR_MIPMAP_LINEAR;
    renderer.bindFramebuffer({ target: gl.FRAMEBUFFER, buffer: null });

    bakeGeometry.remove();
    bakeProgram.remove();

    const camera = new Camera(gl, { fov: 38, near: 0.1, far: 64 });
    const scene = new Transform();

    const galaxyTilt = new Transform();
    galaxyTilt.position.y = 0.12;
    galaxyTilt.rotation.x = 0.62;
    galaxyTilt.rotation.z = -0.20;
    galaxyTilt.setParent(scene);

    const galaxySpin = new Transform();
    const initialSpin = -0.18;
    galaxySpin.rotation.y = initialSpin;
    galaxySpin.setParent(galaxyTilt);

    const pointerTarget = new Vec2(0, 0);
    const pointerCurrent = new Vec2(0, 0);
    let pointerActive = false;
    let pointerStrength = 0;

    const rippleOrigin = new Vec2(0, 0);
    let rippleAge = 99;

    const localCamPos = new Vec3(0, 0, 8);
    const invGalaxyMat = new Mat4();

    const initialDark = themeRef.current === 'dark' ? 1 : 0;
    const initialRatio = Math.min(window.devicePixelRatio || 1, 2);

    // Stage 1: Real-time 3D volumetric raymarched galactic bulge, bar, spiral arms & Beer-Lambert dust
    const volumeGeometry = createVolumeBoxGeometry(gl);
    const volumeProgram = new Program(gl, {
      vertex: VOLUME_VERTEX_SHADER,
      fragment: buildVolumeFragmentShader(raySteps),
      transparent: true,
      cullFace: gl.BACK,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uGalaxyTex: { value: bakeTarget.texture },
        uLocalCamPos: { value: localCamPos },
        uTime: { value: 0 },
        uDark: { value: initialDark },
        uAspect: { value: 1.6 },
        uPointer: { value: pointerCurrent },
        uPointerStrength: { value: 0 },
        uRippleOrigin: { value: rippleOrigin },
        uRippleAge: { value: 99 },
      },
    });
    volumeProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const volumeMesh = new Mesh(gl, {
      mode: gl.TRIANGLES,
      geometry: volumeGeometry,
      program: volumeProgram,
      frustumCulled: false,
      renderOrder: 0,
    });
    volumeMesh.setParent(galaxySpin);

    // Stage 2: 48,000 / 24,000 high-density 3D spiral stars & OB star clusters
    const starData = createGalaxyStarBuffers(galaxyStarCount);
    const starGeometry = new Geometry(gl, {
      position: { size: 3, data: starData.positions },
      aSize: { size: 1, data: starData.sizes },
      aSeed: { size: 1, data: starData.seeds },
      aBand: { size: 1, data: starData.bands },
      aKind: { size: 1, data: starData.kinds },
      aSpike: { size: 1, data: starData.spikes },
    });
    const starProgram = new Program(gl, {
      vertex: STAR_VERTEX_SHADER,
      fragment: STAR_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: initialRatio },
        uDark: { value: initialDark },
        uAspect: { value: 1.6 },
        uPointer: { value: pointerCurrent },
        uPointerStrength: { value: 0 },
        uRippleOrigin: { value: rippleOrigin },
        uRippleAge: { value: 99 },
      },
    });
    const starMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: starGeometry,
      program: starProgram,
      frustumCulled: false,
      renderOrder: 1,
    });
    starMesh.setParent(galaxySpin);

    // Stage 3: Full-viewport deep-field night sky stars
    const bgData = createDeepFieldBuffers(bgStarCount);
    const bgGeometry = new Geometry(gl, {
      position: { size: 3, data: bgData.positions },
      aSize: { size: 1, data: bgData.sizes },
      aSeed: { size: 1, data: bgData.seeds },
    });
    const bgProgram = new Program(gl, {
      vertex: BG_VERTEX_SHADER,
      fragment: BG_FRAGMENT_SHADER,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uPixelRatio: { value: initialRatio },
        uDark: { value: initialDark },
      },
    });
    const bgMesh = new Mesh(gl, {
      mode: gl.POINTS,
      geometry: bgGeometry,
      program: bgProgram,
      frustumCulled: false,
      renderOrder: -1,
    });
    bgMesh.setParent(scene);

    const applyStarBlendForTheme = (darkVal: number) => {
      if (darkVal >= 0.5) {
        starProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        bgProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      } else {
        starProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
        bgProgram.setBlendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      }
    };
    applyStarBlendForTheme(initialDark);

    let currentAspect = 1.6;
    let baseZ = 7.15;

    const resize = () => {
      if (!renderer || !container) return;
      const width = Math.max(container.clientWidth, 320);
      const height = Math.max(container.clientHeight, 240);
      currentAspect = width / height;
      baseZ = currentAspect < 1.15 ? 7.15 * Math.min(2.65, 1.30 / Math.max(currentAspect, 0.46)) : 7.15;
      galaxyTilt.position.y = currentAspect < 0.9 ? 0.06 : 0.10;
      galaxyTilt.rotation.z = currentAspect < 0.9 ? -0.52 : -0.18;
      galaxyTilt.rotation.x = currentAspect < 0.9 ? 0.54 : 0.58;

      renderer.setSize(width, height);
      camera.perspective({ aspect: currentAspect });
      volumeProgram.uniforms.uAspect.value = currentAspect;
      starProgram.uniforms.uAspect.value = currentAspect;
      starProgram.uniforms.uPixelRatio.value = renderer.dpr;
      bgProgram.uniforms.uPixelRatio.value = renderer.dpr;
    };
    resize();

    let rafId: number | null = null;
    let lastTs = performance.now();
    let elapsed = 0;
    let disposed = false;

    const renderFrame = () => {
      if (!renderer || disposed) return;
      galaxySpin.rotation.y = initialSpin + elapsed * 0.042;
      bgMesh.rotation.y = elapsed * 0.004;
      camera.position.set(
        pointerCurrent.x * 0.64 * pointerStrength,
        pointerCurrent.y * 0.42 * pointerStrength,
        baseZ - Math.abs(pointerCurrent.x) * 0.18 * pointerStrength,
      );
      camera.lookAt([0, 0, 0]);

      // Update world matrices first so volumetric ray origin uLocalCamPos is 100% in sync
      scene.updateMatrixWorld(true);
      invGalaxyMat.inverse(galaxySpin.worldMatrix);
      localCamPos.copy(camera.position).applyMatrix4(invGalaxyMat);

      renderer.render({ scene, camera });
    };

    const tick = (now: number) => {
      rafId = null;
      if (disposed || pausedRef.current || document.hidden) return;

      const dt = Math.min(0.05, Math.max(0.001, (now - lastTs) / 1000));
      lastTs = now;
      elapsed += dt;

      pointerCurrent.x += (pointerTarget.x - pointerCurrent.x) * Math.min(1, dt * 6);
      pointerCurrent.y += (pointerTarget.y - pointerCurrent.y) * Math.min(1, dt * 6);
      const targetStrength = pointerActive ? 1 : 0;
      pointerStrength += (targetStrength - pointerStrength) * Math.min(1, dt * 4.5);

      if (rippleAge < 3.0) {
        rippleAge += dt;
      }

      volumeProgram.uniforms.uTime.value = elapsed;
      volumeProgram.uniforms.uPointerStrength.value = pointerStrength;
      volumeProgram.uniforms.uRippleAge.value = rippleAge;

      starProgram.uniforms.uTime.value = elapsed;
      starProgram.uniforms.uPointerStrength.value = pointerStrength;
      starProgram.uniforms.uRippleAge.value = rippleAge;

      bgProgram.uniforms.uTime.value = elapsed;

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
      if (pausedRef.current || document.hidden) {
        stopLoop();
        return;
      }
      if (rafId === null) {
        lastTs = performance.now();
        rafId = window.requestAnimationFrame(tick);
      }
    };

    controlsRef.current = {
      syncLoop,
      setDark(dark: number) {
        applyStarBlendForTheme(dark);
        volumeProgram.uniforms.uDark.value = dark;
        starProgram.uniforms.uDark.value = dark;
        bgProgram.uniforms.uDark.value = dark;
        renderFrame();
      },
    };

    const toNdc = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const x = ((clientX - rect.left) / rect.width) * 2 - 1;
      const y = -(((clientY - rect.top) / rect.height) * 2 - 1);
      return { x, y, inside: x >= -1.1 && x <= 1.1 && y >= -1.1 && y <= 1.1 };
    };

    const onPointerMove = (event: PointerEvent) => {
      const pos = toNdc(event.clientX, event.clientY);
      if (!pos || !pos.inside) {
        pointerActive = false;
        return;
      }
      pointerTarget.set(pos.x, pos.y);
      pointerActive = true;
    };

    const onPointerLeave = () => {
      pointerActive = false;
    };

    const onPointerDown = (event: PointerEvent) => {
      const pos = toNdc(event.clientX, event.clientY);
      if (!pos || !pos.inside) return;
      rippleOrigin.set(pos.x, pos.y);
      rippleAge = 0;
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

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointerleave', onPointerLeave, { passive: true });
    document.addEventListener('visibilitychange', onVisibilityChange);
    canvas.addEventListener('webglcontextlost', onContextLost);

    renderFrame();
    syncLoop();

    return () => {
      disposed = true;
      controlsRef.current = null;
      stopLoop();
      resizeObserver?.disconnect();
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointerleave', onPointerLeave);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      canvas.removeEventListener('webglcontextlost', onContextLost);
      volumeGeometry.remove();
      volumeProgram.remove();
      starGeometry.remove();
      starProgram.remove();
      bgGeometry.remove();
      bgProgram.remove();
      if (bakeTarget.texture?.texture) {
        gl.deleteTexture(bakeTarget.texture.texture);
      }
      if (bakeTarget.buffer) {
        gl.deleteFramebuffer(bakeTarget.buffer);
      }
      const loseContext = gl.getExtension('WEBGL_lose_context');
      loseContext?.loseContext();
      if (canvas.parentNode === container) {
        container.removeChild(canvas);
      }
    };
  }, [fallbackMode]);

  if (fallbackMode !== 'none') {
    return <StaticOpticalBackdrop theme={theme} />;
  }

  return (
    <div
      ref={containerRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    />
  );
}
