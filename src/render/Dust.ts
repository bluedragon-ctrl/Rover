import * as THREE from 'three';

/** Half-width (tiles) of the box the dust drifts through, centred on the camera focus. */
const SPAN = 20;

/**
 * Drifting dust motes (cosmetic). The drift is computed in the vertex shader from a time
 * uniform, so nothing is uploaded per frame; motes are soft round dots, not squares.
 * Brighter by day (`setDay`). Math.random is fine: the renderer is not deterministic.
 */
export class Dust {
  readonly points: THREE.Points;
  private mat: THREE.ShaderMaterial;

  constructor(count = 500) {
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * SPAN * 2;
      pos[i * 3 + 1] = Math.random() * 3;
      pos[i * 3 + 2] = (Math.random() - 0.5) * SPAN * 2;
      phase[i] = i;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('phase', new THREE.BufferAttribute(phase, 1));
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime: { value: 0 },
        uColor: { value: new THREE.Color(0xd8b48a) },
        uOpacity: { value: 0.5 },
        /** Mote diameter in world units (tiles). */
        uSize: { value: 0.07 },
        /** Half the drawing-buffer height in pixels (perspective point size). */
        uScale: { value: 400 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
  }

  /** Call on resize with the drawing-buffer height in pixels. */
  setViewportHeight(px: number): void {
    this.mat.uniforms.uScale.value = px / 2;
  }

  /** `t` seconds; `day` 0..1. Fog uniforms are copied from the scene fog. */
  update(t: number, day: number, fog: THREE.Fog): void {
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uOpacity.value = 0.12 + 0.35 * day;
    u.fogColor.value.copy(fog.color);
    u.fogNear.value = fog.near;
    u.fogFar.value = fog.far;
  }
}

const VERT = /* glsl */ `
uniform float uTime;
uniform float uSize;
uniform float uScale;
attribute float phase;
varying float vEdge;
#include <fog_pars_vertex>

void main() {
  vec3 p = position;
  // Wind drift, wrapped to the box around the focus (same motion as the old CPU loop).
  p.x = mod(p.x + uTime * 0.6 + ${SPAN.toFixed(1)}, ${(SPAN * 2).toFixed(1)}) - ${SPAN.toFixed(1)};
  p.z = mod(p.z + uTime * 0.15 + ${SPAN.toFixed(1)}, ${(SPAN * 2).toFixed(1)}) - ${SPAN.toFixed(1)};
  p.y -= cos(uTime + phase) * 0.05;
  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float px = uSize * uScale / -mvPosition.z;
  // Never below ~1.5 px, so far motes do not shimmer; fade those instead.
  gl_PointSize = max(px, 1.5);
  vEdge = clamp(px / 1.5, 0.0, 1.0);
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vEdge;
#include <fog_pars_fragment>

void main() {
  // Soft round mote.
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.1, d) * uOpacity * vEdge;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <fog_fragment>
}
`;
