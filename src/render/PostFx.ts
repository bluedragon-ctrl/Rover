import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

/** MSAA samples for the scene render target (lines are the whole look, so they need it). */
const MSAA_SAMPLES = 4;

/**
 * Bloom post-processing. The threshold keeps the dim terrain grid crisp while bright
 * lines (ore, beacons, FX, lit headlight tiles) glow. Can be switched off for slow GPUs.
 *
 * The scene always renders into a multisampled target (the canvas's own antialiasing does
 * not apply to render targets, so without this every line was aliased while bloom was on).
 * Bloom off just disables the bloom pass, so both modes look the same apart from the glow.
 * Create the renderer with `antialias: false`: canvas MSAA would only cost memory.
 */
export class PostFx {
  readonly composer: EffectComposer;
  readonly bloom: UnrealBloomPass;
  private renderPass: RenderPass;

  constructor(private renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(1, size.x), Math.max(1, size.y), {
      type: THREE.HalfFloatType,
      samples: Math.min(MSAA_SAMPLES, renderer.capabilities.maxSamples),
    });
    target.texture.name = 'PostFx.scene';
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.65, 0.4, 0.42);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  get enabled(): boolean {
    return this.bloom.enabled;
  }

  set enabled(on: boolean) {
    this.bloom.enabled = on;
  }

  setSize(w: number, h: number): void {
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(w, h);
  }

  render(_scene?: THREE.Scene, _camera?: THREE.Camera): void {
    this.composer.render();
  }
}
