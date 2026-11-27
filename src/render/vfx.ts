/**
 * Juice department: spark/ring object pools, tracer beam, floating combat
 * text, camera rig with shake/FOV-kick/combo pull-back, and the CSS speedline
 * overlay driver.
 */
import * as THREE from 'three'
import type { ViewModel } from '../core/types'

interface Spark {
  mesh: THREE.Mesh
  vx: number
  vy: number
  vz: number
  life: number
}

interface Ring {
  mesh: THREE.Mesh
  life: number
}

interface Flash {
  mesh: THREE.Mesh
  life: number
  maxLife: number
  size: number
}

export type CameraMode = 'standard' | 'wide' | 'focus' | 'overview'

interface CameraPreset {
  label: string
  y: number
  z: number
  fov: number
  lookY: number
  leadMax: number
}

export const CAMERA_MODE_ORDER: readonly CameraMode[] = ['standard', 'wide', 'focus', 'overview']

export const CAMERA_MODES: Record<CameraMode, CameraPreset> = {
  standard: { label: 'STANDARD', y: 27, z: 41, fov: 55, lookY: 4, leadMax: 4.5 },
  wide: { label: 'WIDE TACTICAL', y: 31, z: 48, fov: 64, lookY: 3.5, leadMax: 6.0 },
  focus: { label: 'COMBAT FOCUS', y: 22, z: 33, fov: 50, lookY: 4.4, leadMax: 5.0 },
  overview: { label: 'OVERVIEW', y: 44, z: 38, fov: 58, lookY: 2.0, leadMax: 4.0 },
}

export interface VfxOptions {
  fxLayer: HTMLElement
  speedlinesEl: HTMLElement
  camera: THREE.PerspectiveCamera
  shakeEnabled: () => boolean
}

export class VFX {
  private readonly camera: THREE.PerspectiveCamera
  private readonly fxLayer: HTMLElement
  private readonly speedlinesEl: HTMLElement
  private readonly shakeEnabled: () => boolean

  private readonly sparks: Spark[] = []
  private readonly sparkPool: THREE.Mesh[] = []
  private readonly rings: Ring[] = []
  private readonly ringPool: THREE.Mesh[] = []
  private readonly flashes: Flash[] = []
  private readonly flashPool: THREE.Mesh[] = []
  private readonly sparkMats = new Map<number, THREE.MeshBasicMaterial>()

  private readonly beam: THREE.Mesh
  private readonly lockRing: THREE.Mesh
  private readonly camBase = new THREE.Vector3(0, 27, 41)
  private readonly camLead = new THREE.Vector2(0, 0)
  private lowerAssist = 0
  private pulseT = 0
  private reticleT = 0
  cameraMode: CameraMode = 'standard'
  /** Camera trauma (game-feel): shake = trauma², decays in REAL time so it
   * survives hit-stop; offset is summed sines, never per-frame random. */
  private trauma = 0
  private traumaT = 0
  private kick = 0
  /** Landing-dip spring (physics on the camera base, not the body). */
  private dip = 0
  private dipV = 0
  private speedlineV = 0
  private beamT = 0

  constructor(scene: THREE.Scene, opts: VfxOptions) {
    this.camera = opts.camera
    this.fxLayer = opts.fxLayer
    this.speedlinesEl = opts.speedlinesEl
    this.shakeEnabled = opts.shakeEnabled

    const sparkGeo = new THREE.BoxGeometry(0.32, 0.32, 0.32)
    for (let i = 0; i < 220; i++) {
      const m = new THREE.Mesh(sparkGeo, this.mat(0xffffff))
      m.visible = false
      scene.add(m)
      this.sparkPool.push(m)
    }
    const ringGeo = new THREE.RingGeometry(0.6, 1, 40)
    for (let i = 0; i < 24; i++) {
      const m = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      m.visible = false
      scene.add(m)
      this.ringPool.push(m)
    }
    const flashGeo = new THREE.SphereGeometry(1, 10, 8)
    for (let i = 0; i < 20; i++) {
      const m = new THREE.Mesh(
        flashGeo,
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
      )
      m.visible = false
      scene.add(m)
      this.flashPool.push(m)
    }

    this.beam = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffd9a0, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.beam.visible = false
    this.beam.frustumCulled = false
    scene.add(this.beam)

    this.lockRing = new THREE.Mesh(
      new THREE.RingGeometry(0.78, 1.0, 24),
      new THREE.MeshBasicMaterial({ color: 0xf58840, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
    )
    this.lockRing.rotation.x = -Math.PI / 2
    this.lockRing.visible = false
    scene.add(this.lockRing)
  }

  private mat(color: number): THREE.MeshBasicMaterial {
    let m = this.sparkMats.get(color)
    if (!m) {
      m = new THREE.MeshBasicMaterial({ color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })
      this.sparkMats.set(color, m)
    }
    return m
  }

  sparkBurst(x: number, y: number, z: number, color: number, n = 18, power = 1): void {
    for (let i = 0; i < n; i++) {
      const mesh = this.sparkPool.pop()
      if (!mesh) return
      mesh.material = this.mat(color)
      mesh.position.set(x, y, z)
      mesh.visible = true
      const th = Math.random() * Math.PI * 2
      const ph = (Math.random() - 0.5) * Math.PI
      const v = (12 + Math.random() * 22) * power
      this.sparks.push({
        mesh,
        vx: Math.cos(th) * Math.cos(ph) * v,
        vy: Math.sin(ph) * v + 6,
        vz: Math.sin(th) * Math.cos(ph) * v,
        life: 0.6,
      })
    }
  }

  ring(x: number, z: number, color: number): void {
    const mesh = this.ringPool.pop()
    if (!mesh) return
    ;(mesh.material as THREE.MeshBasicMaterial).color.setHex(color)
    mesh.position.set(x, 0.25, z)
    mesh.visible = true
    this.rings.push({ mesh, life: 0.5 })
  }

  /** Crisp, localized impact flash that fades fast without obscuring labels. */
  impactFlash(x: number, y: number, z: number, color: number, size = 1.4, life = 0.12): void {
    const mesh = this.flashPool.pop()
    if (!mesh) return
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.color.setHex(color)
    mat.opacity = 0.85
    mesh.position.set(x, y, z)
    mesh.scale.setScalar(size)
    mesh.visible = true
    this.flashes.push({ mesh, life, maxLife: life, size })
  }

  /** Show the tracer beam from a muzzle to a target for a few frames. */
  showBeam(from: THREE.Vector3, to: THREE.Vector3, width: number): void {
    this.beam.position.copy(from).lerp(to, 0.5)
    this.beam.scale.set(width, width, from.distanceTo(to))
    this.beam.lookAt(to)
    this.beam.visible = true
    this.beamT = 0.14
  }

  text(str: string, x: number, y: number, z: number): void {
    const v = new THREE.Vector3(x, y, z).project(this.camera)
    const el = document.createElement('div')
    el.className = 'ft'
    el.textContent = str
    el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`
    el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`
    this.fxLayer.appendChild(el)
    window.setTimeout(() => el.remove(), 900)
  }

  addShake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount)
  }

  /** Trauma from a blast: attenuated by distance to the focus player. */
  blast(x: number, z: number, _r: number, focus: { x: number; z: number }): void {
    const d = Math.hypot(focus.x - x, focus.z - z)
    const falloff = Math.max(0, 1 - d / 70)
    this.addTrauma(0.45 + 0.5 * falloff)
    this.addKick(0.8 + falloff * 0.2)
  }

  /** Hard landing: a quick camera dip through a damped spring. */
  thud(): void {
    this.dipV -= 15
  }

  addTrauma(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount)
  }

  addKick(amount: number): void {
    this.kick = Math.min(1, this.kick + amount)
  }

  cycleCameraMode(): CameraMode {
    const idx = CAMERA_MODE_ORDER.indexOf(this.cameraMode)
    this.cameraMode = CAMERA_MODE_ORDER[(idx + 1) % CAMERA_MODE_ORDER.length]!
    return this.cameraMode
  }

  cameraModeLabel(): string {
    return CAMERA_MODES[this.cameraMode].label
  }

  milestonePulse(): void {
    this.pulseT = 0.45
    this.addKick(0.85)
  }

  setLockReticle(x: number | null, z: number | null, radius = 2, locked = false): void {
    if (x === null || z === null) {
      this.lockRing.visible = false
      return
    }
    this.lockRing.visible = true
    this.lockRing.position.set(x, 0.22, z)
    const pulse = 1 + Math.sin(this.reticleT * (locked ? 8 : 4)) * (locked ? 0.1 : 0.05)
    this.lockRing.scale.setScalar((radius + 0.9) * pulse)
    const mat = this.lockRing.material as THREE.MeshBasicMaterial
    mat.color.setHex(locked ? 0xf58840 : 0xd8c88a)
    mat.opacity = locked ? 0.88 : 0.42
  }

  hitStop = 0

  update(
    dt: number,
    vm: ViewModel,
    focus: { x: number; z: number; y: number },
    realDt = dt,
    targetLook?: { x: number; z: number } | null,
  ): void {
    this.reticleT += realDt
    this.pulseT = Math.max(0, this.pulseT - realDt)
    // Sparks
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const s = this.sparks[i]!
      s.mesh.position.x += s.vx * dt
      s.mesh.position.y += s.vy * dt
      s.mesh.position.z += s.vz * dt
      s.vy -= 28 * dt
      s.life -= dt
      s.mesh.scale.setScalar(Math.max(0.01, s.life / 0.6))
      if (s.life <= 0 || s.mesh.position.y < 0) {
        s.mesh.visible = false
        this.sparkPool.push(s.mesh)
        this.sparks.splice(i, 1)
      }
    }
    // Rings
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i]!
      r.life -= dt
      r.mesh.scale.setScalar(1 + (1 - r.life / 0.5) * 10)
      ;(r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, r.life * 2)
      if (r.life <= 0) {
        r.mesh.visible = false
        this.ringPool.push(r.mesh)
        this.rings.splice(i, 1)
      }
    }
    // Impact flashes
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const fl = this.flashes[i]!
      fl.life -= realDt
      const p = Math.max(0, fl.life / fl.maxLife)
      fl.mesh.scale.setScalar(fl.size * (0.4 + p * 0.8))
      ;(fl.mesh.material as THREE.MeshBasicMaterial).opacity = p * 0.85
      if (fl.life <= 0) {
        fl.mesh.visible = false
        this.flashPool.push(fl.mesh)
        this.flashes.splice(i, 1)
      }
    }
    // Beam
    this.beamT = Math.max(0, this.beamT - dt)
    if (this.beamT <= 0) this.beam.visible = false

    // Camera: active mode preset + automatic threat/lower-side assistance +
    // target look-ahead + combo pull-back + trauma shake (never switches modes).
    const preset = CAMERA_MODES[this.cameraMode]
    const combo = Math.min(vm.players[0]?.combo ?? 0, 20)
    const k = 1 - Math.exp(-5.5 * realDt)

    // Measure incoming threats across all directions, especially +Z (keyboard-facing side).
    let threatSumX = 0
    let threatSumZ = 0
    let threatW = 0
    let lowerRaw = 0
    for (const e of vm.enemies) {
      const dx = e.x - focus.x
      const dz = e.z - focus.z
      const d = Math.hypot(dx, dz) || 1
      if (d < 58) {
        const w = 1 - d / 58
        threatSumX += (dx / d) * w
        threatSumZ += (dz / d) * w
        threatW += w
        if (dz > 4) lowerRaw = Math.max(lowerRaw, Math.min(1, (dz - 4) / 28) * w * 1.4)
      }
    }
    this.lowerAssist += (Math.min(1, lowerRaw) - this.lowerAssist) * (1 - Math.exp(-3.2 * realDt))

    let leadX = 0
    let leadZ = 0
    if (targetLook) {
      leadX += (targetLook.x - focus.x) * 0.14
      leadZ += (targetLook.z - focus.z) * 0.14
    }
    if (threatW > 0.05) {
      leadX += (threatSumX / threatW) * 2.2
      leadZ += (threatSumZ / threatW) * 2.2
    }
    leadZ += this.lowerAssist * 3.4
    const ld = Math.hypot(leadX, leadZ)
    if (ld > preset.leadMax) {
      leadX = (leadX / ld) * preset.leadMax
      leadZ = (leadZ / ld) * preset.leadMax
    }
    const leadK = 1 - Math.exp(-4.0 * realDt)
    this.camLead.x += (leadX - this.camLead.x) * leadK
    this.camLead.y += (leadZ - this.camLead.y) * leadK

    const pulseAmt = this.pulseT > 0 ? Math.sin((this.pulseT / 0.45) * Math.PI) : 0
    const targetY = preset.y + this.lowerAssist * 5.2 - combo * 0.1 - pulseAmt * 1.4
    const targetZ = focus.z + preset.z + this.lowerAssist * 6.0 + this.camLead.y * 0.45 - combo * 0.25

    this.camBase.x += (focus.x + this.camLead.x * 0.65 - this.camBase.x) * k
    this.camBase.y += (targetY - this.camBase.y) * k
    this.camBase.z += (targetZ - this.camBase.z) * k
    // Landing-dip spring: critically damped, snaps back to rest.
    this.dipV += (-this.dip * 90 - this.dipV * 12) * realDt
    this.dip += this.dipV * realDt
    if (Math.abs(this.dip) < 0.002 && Math.abs(this.dipV) < 0.02) {
      this.dip = 0
      this.dipV = 0
    }
    this.trauma = Math.max(0, this.trauma - 1.4 * realDt)
    const shakeAmt = this.shakeEnabled() ? this.trauma * this.trauma : 0
    this.traumaT += realDt * 30
    // Summed sines at unrelated rates: smooth, never a random buzz.
    const ox = 2.4 * shakeAmt * Math.sin(this.traumaT * 1.7)
    const oy = 1.6 * shakeAmt * Math.sin(this.traumaT * 2.3)
    this.camera.position.set(
      this.camBase.x + ox,
      this.camBase.y - this.dip + oy,
      this.camBase.z,
    )
    const targetFov = preset.fov + combo * 0.6 + this.lowerAssist * 4.5 + shakeAmt * 4.5 - pulseAmt * 2.5
    this.camera.fov += (targetFov - this.camera.fov) * k
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(
      focus.x + this.camLead.x,
      preset.lookY + focus.y * 0.4 - this.dip * 0.4,
      focus.z + this.camLead.y,
    )
    // Gentle camera roll response on lateral look-ahead + trauma shake.
    this.camera.rotation.z += 0.055 * shakeAmt * Math.sin(this.traumaT * 1.1) - this.camLead.x * 0.0025

    // Speed lines
    this.kick = Math.max(0, this.kick - realDt * 5)
    this.speedlineV += (Math.min(Math.max((combo - 3) / 12, 0), 1) * 0.7 + this.kick * 0.45 - this.speedlineV) * Math.min(1, realDt * 8)
    this.speedlinesEl.style.opacity = this.speedlineV.toFixed(2)
  }

  resetCamera(): void {
    const preset = CAMERA_MODES[this.cameraMode]
    this.camBase.set(0, preset.y, preset.z)
    this.camLead.set(0, 0)
    this.lowerAssist = 0
    this.pulseT = 0
    this.trauma = 0
    this.kick = 0
    this.dip = 0
    this.dipV = 0
  }
}
