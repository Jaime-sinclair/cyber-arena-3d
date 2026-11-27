/**
 * Renderer wrapper: modern three.js pipeline — sRGB output, ACES tone mapping,
 * optional bloom via EffectComposer, and a software-renderer detector so CI
 * (SwiftShader) and weak GPUs automatically drop to the no-bloom path.
 */
import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

export type Quality = 'high' | 'low'

export function isSoftwareRenderer(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2') ?? c.getContext('webgl')
    if (!gl) return true
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    return /swiftshader|llvmpipe|software/i.test(r)
  } catch {
    return true
  }
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera: THREE.PerspectiveCamera
  private composer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null
  quality: Quality

  constructor(canvas: HTMLCanvasElement, wantQuality: Quality = 'high') {
    const sw = isSoftwareRenderer()
    this.quality = wantQuality === 'high' && sw ? 'low' : wantQuality
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !sw,
      powerPreference: 'high-performance',
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.12
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1500)
    this.camera.position.set(0, 27, 41)
    this.resize()
    this.setupComposer()
  }

  private setupComposer(): void {
    this.composer?.dispose()
    this.composer = null
    this.bloomPass = null
    this.renderer.shadowMap.enabled = this.quality === 'high'
    if (this.quality !== 'high') return
    const size = new THREE.Vector2(window.innerWidth, window.innerHeight)
    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloomPass = new UnrealBloomPass(size, 0.5, 0.55, 0.82)
    this.composer.addPass(this.bloomPass)
    this.composer.addPass(new OutputPass())
  }

  setQuality(q: Quality): void {
    if (q === this.quality) return
    this.quality = q
    this.setupComposer()
    this.resize()
  }

  resize(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    const dpr = this.quality === 'low' ? 1 : Math.min(window.devicePixelRatio || 1, 1.5)
    this.renderer.setPixelRatio(dpr)
    this.renderer.setSize(w, h)
    this.composer?.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  render(): void {
    if (this.composer) this.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.composer?.dispose()
    this.renderer.dispose()
  }
}
