import * as THREE from 'three';
import { HEADLIGHT_CONE } from '../core/sensors';

/** Max rovers that cast tile light at once (uniform array size). */
export const MAX_LIGHTS = 4;

/**
 * Discrete, per-tile lighting for the terrain (not real light simulation).
 *
 * Every terrain vertex carries the centre of the tile it belongs to (`tile` attribute,
 * chunk-local x/z). The vertex shader moves that centre into scene space and decides how
 * lit the whole tile is: daylight, a rover's sensor disc, or its headlight cone. Tiles
 * therefore light up as crisp cells, the same cells the operator sees and maps: the disc and
 * cone here mirror `src/core/sensors.ts` (cone numbers are injected from HEADLIGHT_CONE).
 *
 * At night unlit tiles fade to a cold, desaturated grey ("remembered terrain") instead of
 * black; lit tiles keep their full colour and a slight boost so they bloom.
 */
export class TileLighting {
  readonly uniforms = {
    ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
    /** 0 = full night, 1 = full daylight. */
    uDay: { value: 1 },
    /** Colour grade applied to lit tiles (warm at dusk, neutral at noon). */
    uGrade: { value: new THREE.Color(1, 1, 1) },
    /** Tint of unlit night terrain. */
    uNight: { value: new THREE.Color(0.32, 0.38, 0.5) },
    uLightCount: { value: 0 },
    /** xy = rover tile centre in scene x/z, z = sensor radius in tiles, w = unused. */
    uLights: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
    /** xy = forward unit vector (scene x/z), z = 1 when the headlight cone is on, else 0. */
    uBeams: { value: Array.from({ length: MAX_LIGHTS }, () => new THREE.Vector4()) },
  };

  /** Material for the line work of chunks. */
  readonly lineMaterial: THREE.ShaderMaterial;
  /** Material for the dark opaque fills under the lines (hidden-line look). */
  readonly fillMaterial: THREE.ShaderMaterial;

  constructor() {
    this.lineMaterial = this.make(false);
    this.fillMaterial = this.make(true);
  }

  private make(fill: boolean): THREE.ShaderMaterial {
    const m = new THREE.ShaderMaterial({
      uniforms: this.uniforms, // shared object: one update drives both materials
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: true,
      vertexColors: true,
      defines: {
        ...(fill ? { FILL: 1 } : {}),
        CONE_LEN: HEADLIGHT_CONE.length.toFixed(1),
        CONE_NEAR_LEN: HEADLIGHT_CONE.nearLength.toFixed(1),
        CONE_NEAR_SPREAD: HEADLIGHT_CONE.nearSpread.toFixed(1),
        CONE_FAR_SPREAD: HEADLIGHT_CONE.farSpread.toFixed(1),
      },
    });
    if (fill) {
      // Push fills back so coplanar grid lines always win the depth test.
      m.polygonOffset = true;
      m.polygonOffsetFactor = 1;
      m.polygonOffsetUnits = 1;
      m.side = THREE.DoubleSide;
    }
    return m;
  }
}

const VERT = /* glsl */ `
#define MAX_LIGHTS ${MAX_LIGHTS}
attribute vec2 tile;
uniform int uLightCount;
uniform vec4 uLights[MAX_LIGHTS];
uniform vec4 uBeams[MAX_LIGHTS];
uniform float uDay;
varying vec3 vColor;
varying float vLit;
#include <fog_pars_vertex>

void main() {
  vColor = color;
  vec3 tc = (modelMatrix * vec4(tile.x, 0.0, tile.y, 1.0)).xyz;
  float lit = 0.0;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= uLightCount) break;
    // Whole-tile offset from the rover's tile (rounded: both are tile centres).
    vec2 d = floor(tc.xz - uLights[i].xy + 0.5);
    float r = uLights[i].z;
    float d2 = dot(d, d);
    // Same disc as sensors.inDisc / ChunkedWorld.revealCircle (r*r + r).
    if (d2 <= r * r + r) lit = max(lit, 0.95 - 0.3 * sqrt(d2) / max(r, 1.0));
    vec4 b = uBeams[i];
    if (b.z > 0.0) {
      // Same cone as sensors.inCone.
      float fwd = dot(d, b.xy);
      float lat = abs(d.x * b.y - d.y * b.x);
      float spread = fwd <= CONE_NEAR_LEN ? CONE_NEAR_SPREAD : CONE_FAR_SPREAD;
      if (fwd >= 1.0 && fwd <= CONE_LEN && lat <= spread) lit = max(lit, 1.15 - (fwd - 1.0) * 0.07);
    }
  }
  vLit = max(lit, uDay);
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uGrade;
uniform vec3 uNight;
varying vec3 vColor;
varying float vLit;
#include <fog_pars_fragment>

void main() {
  float g = dot(vColor, vec3(0.299, 0.587, 0.114));
#ifdef FILL
  vec3 dark = uNight * g * 0.8;
#else
  vec3 dark = uNight * (0.12 + g * 0.5);
#endif
  vec3 col = mix(dark, vColor * uGrade, clamp(vLit, 0.0, 1.0));
  col *= max(1.0, vLit);
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;
