/**
 * GLB actors: the compressed artist models (Mixamo rigs) brought to life with
 * a fully procedural animation layer — walk/run cycles, aim poses, recoil,
 * hit flinches, deaths, and spring-driven secondary motion on cloth/horn/
 * rope/chain bones. Guns are auto-fitted: barrel orientation and grip
 * position are derived from the mesh itself, then aligned so the weapon
 * points down the holder's forward axis exactly when the aim pose is active.
 */
import * as THREE from 'three'
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js'
import { ACTOR_H } from '../core/constants'
import { assets, type TemplateKey } from './assets'
import type { ActorAnimState, ActorView } from './actor'

export type GlbRole = 'PLAYER' | 'PLAYER2' | 'RUNNER' | 'GRUNT' | 'FLANKER' | 'ELITE' | 'BOSS'

interface RoleConfig {
  template: TemplateKey
  scale: number
  /** Weapon auto-fit: fraction of the character's height for the gun length. */
  gun?: { key: TemplateKey; lenFrac: number }
  lean: number
  swing: number
  bob: number
  stepRate: number
  tint?: number
  tintAmount?: number
  secondaryGain: number
}

const ROLES: Record<GlbRole, RoleConfig> = {
  PLAYER: { template: 'player', scale: 1, gun: { key: 'gunRifle', lenFrac: 0.55 }, lean: 0.12, swing: 0.85, bob: 1, stepRate: 0.85, secondaryGain: 1 },
  PLAYER2: { template: 'player', scale: 1, gun: { key: 'gunRifle', lenFrac: 0.55 }, lean: 0.12, swing: 0.85, bob: 1, stepRate: 0.85, tint: 0xb0a070, tintAmount: 0.32, secondaryGain: 1 },
  RUNNER: { template: 'runner', scale: 0.82, lean: 0.28, swing: 1.25, bob: 1.12, stepRate: 1.05, secondaryGain: 1.1 },
  GRUNT: { template: 'grunt', scale: 1.16, lean: 0.08, swing: 0.85, bob: 1.2, stepRate: 0.68, tint: 0x3b3532, tintAmount: 0.22, secondaryGain: 0.9 },
  FLANKER: { template: 'runner', scale: 0.94, gun: { key: 'gunPistol', lenFrac: 0.24 }, lean: 0.2, swing: 1.05, bob: 1.0, stepRate: 0.95, tint: 0x3b6e68, tintAmount: 0.26, secondaryGain: 1.15 },
  ELITE: { template: 'grunt', scale: 1.15, gun: { key: 'gunSmg', lenFrac: 0.30 }, lean: 0.08, swing: 0.85, bob: 0.9, stepRate: 0.8, tint: 0x9a5a2a, tintAmount: 0.18, secondaryGain: 1 },
  BOSS: { template: 'boss', scale: 2.3, lean: 0.16, swing: 0.6, bob: 1.5, stepRate: 0.62, secondaryGain: 1.4 },
}

/* ---------- Mixamo bone names ---------- */

const M = 'mixamorig_'
const BONE_MAP: Record<string, string> = {
  hips: `${M}Hips`,
  spine: `${M}Spine`,
  spine1: `${M}Spine1`,
  spine2: `${M}Spine2`,
  neck: `${M}Neck`,
  head: `${M}Head`,
  shoulderL: `${M}LeftShoulder`,
  armL: `${M}LeftArm`,
  foreL: `${M}LeftForeArm`,
  handL: `${M}LeftHand`,
  shoulderR: `${M}RightShoulder`,
  armR: `${M}RightArm`,
  foreR: `${M}RightForeArm`,
  handR: `${M}RightHand`,
  uplegL: `${M}LeftUpLeg`,
  legL: `${M}LeftLeg`,
  footL: `${M}LeftFoot`,
  uplegR: `${M}RightUpLeg`,
  legR: `${M}RightLeg`,
  footR: `${M}RightFoot`,
}

const SECONDARY_RE = /skirt|cloth|rope|chain|armour|armor|horn/i
const FINGER_RE = /Hand(Thumb|Index|Middle|Ring|Pinky)\d/

/** Clone a material with a color tint (never mutates the shared template). */
function tintMat(m: THREE.Material, tint: THREE.Color, amount: number): THREE.Material {
  const c = m.clone() as THREE.MeshStandardMaterial
  if (c.isMeshStandardMaterial) c.color.lerp(tint, amount)
  return c
}

/** A controllable bone: rest pose + parent-space axes for world-X/Z swings. */
interface BoneCtl {
  bone: THREE.Bone
  restQ: THREE.Quaternion
  restP: THREE.Vector3
  px: THREE.Vector3
  pz: THREE.Vector3
}

/** Spring-driven secondary bone (cloth, ropes, chains, horns). */
interface JiggleBone {
  bone: THREE.Bone
  restQ: THREE.Quaternion
  px: THREE.Vector3
  pz: THREE.Vector3
  ox: number
  oz: number
  vx: number
  vz: number
  gain: number
}

const _q1 = new THREE.Quaternion()
const _q2 = new THREE.Quaternion()
const _v1 = new THREE.Vector3()
const _v2 = new THREE.Vector3()
const _xAxis = new THREE.Vector3(1, 0, 0)
const _zAxis = new THREE.Vector3(0, 0, 1)

/** Set bone local rotation = Rz(a) * Rx(b) * restQ (parent-space swings). */
function swing(b: BoneCtl, x: number, z: number): void {
  b.bone.quaternion.setFromAxisAngle(b.px, x).premultiply(_q1.setFromAxisAngle(b.pz, z)).multiply(b.restQ)
}

export class GlbActor implements ActorView {
  readonly root = new THREE.Group()
  dead = false

  private readonly inner: THREE.Group
  private readonly cfg: RoleConfig
  private readonly charH: number
  private readonly j: Partial<Record<keyof typeof BONE_MAP, BoneCtl>> = {}
  private readonly jiggle: JiggleBone[] = []
  private readonly modelScale: number
  private readonly muzzleNode = new THREE.Object3D()
  private hipsRestY = 0
  private muzzleFlash: THREE.Mesh | null = null
  private gunMount: THREE.Group | null = null
  private aimArmQ = new THREE.Quaternion()
  private aimForeQ = new THREE.Quaternion()
  private aimArmLQ = new THREE.Quaternion()
  private aimForeLQ = new THREE.Quaternion()

  private phase = Math.random() * 6
  private t = Math.random() * 6
  private spawnT = 0
  private hurtT = 0
  private shotAt = -1e9
  private deadT = 0
  private moveW = 0
  private aimW = 0
  private strafeW = 0
  private staggerW = 0
  private windupW = 0
  private recoverW = 0
  private prevSin = 0
  private readonly seed = Math.random() * 10
  private prevWorldPos = new THREE.Vector3()
  private velLocal = new THREE.Vector3()

  constructor(role: GlbRole) {
    const cfg = ROLES[role]
    this.cfg = cfg
    const template = assets.get(cfg.template)
    if (!template) throw new Error(`template ${cfg.template} unavailable`)

    this.inner = cloneSkeleton(template.scene) as THREE.Group
    this.root.add(this.inner)
    this.root.name = `glb:${role}`

    // Model height → world height, feet on the ground.
    this.charH = template.height
    this.modelScale = (ACTOR_H * cfg.scale) / template.height
    this.inner.scale.setScalar(this.modelScale)
    this.inner.position.y = -template.minY * this.modelScale

    this.applyTint()
    this.mapBones()
    this.applyBasePose()
    this.snapshotBones()
    if (cfg.gun) this.attachGun(cfg.gun.key, cfg.gun.lenFrac)
    this.addMuzzleFlash()
    this.root.scale.setScalar(0.25)
  }

  /* ------------------------------------------------ setup ------------------------------------------------ */

  private applyTint(): void {
    if (!this.cfg.tint) return
    const tint = new THREE.Color(this.cfg.tint)
    const amount = this.cfg.tintAmount ?? 0.3
    this.inner.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      // Preserve the material shape: swapping a single material for an array
      // on a geometry without groups renders nothing.
      if (Array.isArray(mesh.material)) {
        mesh.material = mesh.material.map(m => tintMat(m, tint, amount))
      } else {
        mesh.material = tintMat(mesh.material, tint, amount)
      }
    })
  }

  private mapBones(): void {
    for (const [ctlName, mixName] of Object.entries(BONE_MAP)) {
      const bone = this.inner.getObjectByName(mixName)
      if (bone instanceof THREE.Bone) {
        this.j[ctlName as keyof typeof BONE_MAP] = { bone, restQ: new THREE.Quaternion(), restP: new THREE.Vector3(), px: new THREE.Vector3(), pz: new THREE.Vector3() }
      }
    }
    // Secondary bones: cloth/skirt/rope/chain/horn chains animate with springs.
    const roots: THREE.Bone[] = []
    this.inner.traverse(o => {
      if (o instanceof THREE.Bone && SECONDARY_RE.test(o.name)) {
        // Only chain roots (parent not secondary) drive the spring; children
        // follow the parent transform naturally.
        if (!(o.parent instanceof THREE.Bone) || !SECONDARY_RE.test(o.parent.name)) roots.push(o)
      }
    })
    for (const bone of roots) {
      const stiff = /horn/i.test(bone.name) ? 0.15 : 0.55 + Math.random() * 0.25
      this.jiggle.push({
        bone,
        restQ: new THREE.Quaternion(),
        px: new THREE.Vector3(),
        pz: new THREE.Vector3(),
        ox: 0, oz: 0, vx: 0, vz: 0,
        gain: stiff,
      })
      // Include the rest of each secondary chain as followers with light sway.
      let p: THREE.Object3D | null = bone
      while ((p = p.children.find(c => c instanceof THREE.Bone && SECONDARY_RE.test(c.name)) ?? null)) {
        this.jiggle.push({ bone: p as THREE.Bone, restQ: new THREE.Quaternion(), px: new THREE.Vector3(), pz: new THREE.Vector3(), ox: 0, oz: 0, vx: 0, vz: 0, gain: 0.12 })
      }
    }
  }

  /** T-pose → relaxed combat stance (arms down, slight elbow bend, finger curl). */
  private applyBasePose(): void {
    this.root.updateMatrixWorld(true)
    // Arms: rotate from T-pose down to the sides (around world Z).
    this.rotWorldZ(this.j.armL, -1.16)
    this.rotWorldZ(this.j.armR, 1.16)
    this.root.updateMatrixWorld(true)
    // Gentle elbow bend forward.
    this.rotWorldX(this.j.foreL, -0.22)
    this.rotWorldX(this.j.foreR, -0.3)
    this.root.updateMatrixWorld(true)
    // Relaxed finger curl (subtle).
    this.inner.traverse(o => {
      if (o instanceof THREE.Bone && FINGER_RE.test(o.name)) {
        const r = o.rotation
        r.x += o.name.includes('Thumb') ? 0.18 : 0.32
      }
    })
    // Slight natural leg spread.
    this.rotWorldZ(this.j.uplegL, -0.06)
    this.rotWorldZ(this.j.uplegR, 0.06)
  }

  /** Rotate a bone around the current WORLD Z axis (used for the base pose). */
  private rotWorldZ(b: BoneCtl | undefined, angle: number): void {
    if (!b) return
    const pw = b.bone.parent!.getWorldQuaternion(_q1)
    const axis = _v1.copy(_zAxis).applyQuaternion(pw.clone().invert())
    b.bone.quaternion.premultiply(_q2.setFromAxisAngle(axis, angle))
  }

  /** Rotate a bone around the current WORLD X axis (used for the base pose). */
  private rotWorldX(b: BoneCtl | undefined, angle: number): void {
    if (!b) return
    const pw = b.bone.parent!.getWorldQuaternion(_q1)
    const axis = _v1.copy(_xAxis).applyQuaternion(pw.clone().invert())
    b.bone.quaternion.premultiply(_q2.setFromAxisAngle(axis, angle))
  }

  /** Snapshot rest poses and precompute swing axes for every animated bone. */
  private snapshotBones(): void {
    this.root.updateMatrixWorld(true)
    for (const ctl of Object.values(this.j)) {
      if (!ctl) continue
      ctl.restQ.copy(ctl.bone.quaternion)
      ctl.restP.copy(ctl.bone.position)
      const pw = ctl.bone.parent!.getWorldQuaternion(_q1).clone()
      ctl.px.copy(_xAxis).applyQuaternion(pw.clone().invert())
      ctl.pz.copy(_zAxis).applyQuaternion(pw.clone().invert())
    }
    for (const s of this.jiggle) {
      s.restQ.copy(s.bone.quaternion)
      const pw = s.bone.parent!.getWorldQuaternion(_q1).clone()
      s.px.copy(_xAxis).applyQuaternion(pw.clone().invert())
      s.pz.copy(_zAxis).applyQuaternion(pw.clone().invert())
    }
    const hips = this.j.hips
    this.hipsRestY = hips ? hips.restP.y : 0
  }

  /* ------------------------------------------------ guns ------------------------------------------------ */

  /**
   * Auto-fit a weapon, fully data-driven. The optimized GLBs have inconsistent
   * units and axes (pistol: meters/X-aligned, SMG+rifle: cm, X or Z aligned),
   * so nothing is assumed: the long axis, the thin (muzzle) end and the
   * thickest (grip) cross-section are all measured from the geometry, then
   * the gun is rotated muzzle→+Z, parked grip-at-origin on the right hand,
   * and scaled to a fraction of this character's height. The mount is locked
   * while the arm holds the aim pose, so the barrel points exactly down the
   * holder's forward axis whenever the character aims.
   */
  private attachGun(key: TemplateKey, lenFrac: number): void {
    const tpl = assets.get(key)
    if (!tpl || !this.j.handR || !this.j.armR || !this.j.foreR) return

    // --- collect meshes; keep only the dominant cluster (some exports carry
    // stray meshes far from the gun body that would wreck the bbox) ---
    tpl.scene.updateMatrixWorld(true)
    const meshes: THREE.Mesh[] = []
    tpl.scene.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) meshes.push(mesh)
    })
    if (!meshes.length) return
    let main = meshes[0]!
    let mainVerts = -1
    const boxes = new Map<THREE.Mesh, THREE.Box3>()
    for (const mesh of meshes) {
      const b = new THREE.Box3().setFromObject(mesh)
      boxes.set(mesh, b)
      const n = (mesh.geometry.attributes.position as THREE.BufferAttribute).count
      if (n > mainVerts) { mainVerts = n; main = mesh }
    }
    const mainBox = boxes.get(main)!
    const mainSize = mainBox.getSize(new THREE.Vector3())
    const reach = Math.max(mainSize.x, mainSize.y, mainSize.z) * 0.9
    const mainCenter = mainBox.getCenter(new THREE.Vector3())
    const keep = meshes.filter(m => {
      if (m === main) return true
      const c = boxes.get(m)!.getCenter(new THREE.Vector3())
      return c.distanceTo(mainCenter) <= reach
    })
    const box = mainBox.clone()
    for (const m of keep) box.union(boxes.get(m)!)
    const keepSet = new Set(keep)

    // --- measure the weapon in template/world space ---
    const size = box.getSize(new THREE.Vector3())
    const axes = ['x', 'y', 'z'] as const
    const ai = size.x >= size.y && size.x >= size.z ? 0 : size.y >= size.z ? 1 : 2
    const longAxis = axes[ai]!
    const longSize = Math.max(1e-6, size[longAxis])
    const BANDS = 24
    const perp = new Float32Array(BANDS) // mean perpendicular radius per band
    const counts = new Float32Array(BANDS)
    const cx = (box.min.x + box.max.x) / 2
    const cy = (box.min.y + box.max.y) / 2
    const cz = (box.min.z + box.max.z) / 2
    tpl.scene.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh || !keepSet.has(mesh)) return
      const pos = mesh.geometry.attributes.position as THREE.BufferAttribute
      for (let i = 0; i < pos.count; i++) {
        _v1.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
        const along = _v1[longAxis]
        const band = Math.min(BANDS - 1, Math.max(0, Math.floor(((along - box.min[longAxis]) / longSize) * BANDS)))
        // Perpendicular distance from the long axis.
        perp[band] += longAxis === 'x' ? Math.hypot(_v1.y - cy, _v1.z - cz)
          : longAxis === 'y' ? Math.hypot(_v1.x - cx, _v1.z - cz)
            : Math.hypot(_v1.x - cx, _v1.y - cy)
        counts[band]++
      }
    })
    for (let i = 0; i < BANDS; i++) perp[i] = counts[i] > 0 ? perp[i]! / counts[i]! : 0

    // Muzzle = the thinner end (average of 3 bands at each extreme).
    const negT = (perp[0]! + perp[1]! + perp[2]!) / 3
    const posT = (perp[BANDS - 1]! + perp[BANDS - 2]! + perp[BANDS - 3]!) / 3
    const muzzlePositive = posT <= negT
    // Grip = thickest populated band.
    let gripBand = 0
    let best = -1
    for (let i = 0; i < BANDS; i++) {
      if (perp[i]! > best) { best = perp[i]!; gripBand = i }
    }

    // Points on the long axis: grip center and muzzle tip (template space).
    const gripPt = new THREE.Vector3(cx, cy, cz)
    gripPt[longAxis] = box.min[longAxis] + ((gripBand + 0.5) / BANDS) * longSize
    const muzzlePt = new THREE.Vector3(cx, cy, cz)
    muzzlePt[longAxis] = muzzlePositive ? box.max[longAxis] : box.min[longAxis]

    // --- orient: long axis (toward muzzle) → +Z ---
    const dir = new THREE.Vector3(longAxis === 'x' ? 1 : 0, longAxis === 'y' ? 1 : 0, longAxis === 'z' ? 1 : 0)
    if (!muzzlePositive) dir.negate()
    const q = new THREE.Quaternion().setFromUnitVectors(dir, _zAxis)

    // --- scale: weapon length as a fraction of the character's height ---
    const gs = (lenFrac * this.charH) / longSize

    const gun = tpl.scene.clone(true)
    gun.traverse(o => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      // Hide strays that were excluded from the analysis cluster.
      const src = meshes.find(m => m.name === mesh.name && m.geometry === mesh.geometry)
      if (src && !keepSet.has(src)) mesh.visible = false
      else { mesh.castShadow = true; mesh.frustumCulled = false }
    })
    const gunInner = new THREE.Group()
    gunInner.add(gun)
    gunInner.quaternion.copy(q)
    gunInner.scale.setScalar(gs)
    // Park the grip point at the mount origin.
    gunInner.position.copy(gripPt).multiplyScalar(gs).applyQuaternion(q).negate()

    this.gunMount = new THREE.Group()
    this.gunMount.name = 'gunMount'
    this.gunMount.add(gunInner)

    // --- align: pose the arm at aim, then lock the mount to world identity ---
    const aim = this.computeAimPose()
    const armR = this.j.armR!
    const foreR = this.j.foreR!
    armR.bone.quaternion.copy(aim.arm)
    foreR.bone.quaternion.copy(aim.fore)
    this.root.updateMatrixWorld(true)
    const handQ = this.j.handR.bone.getWorldQuaternion(_q1)
    this.gunMount.quaternion.copy(handQ.invert())
    this.j.handR.bone.add(this.gunMount)
    // Restore the relaxed stance (computeAimPose also saved the aim quats).
    armR.bone.quaternion.copy(armR.restQ)
    foreR.bone.quaternion.copy(foreR.restQ)

    // Muzzle node at the barrel tip (mount space).
    this.muzzleNode.position.copy(muzzlePt).sub(gripPt).multiplyScalar(gs).applyQuaternion(q)
    this.gunMount.add(this.muzzleNode)
  }

  /**
   * Aim pose in holder space: right arm swung forward on a pure world-X
   * rotation (no twist), left arm reaching across to the grip. Pure-X means
   * the hand's aim↔rest rotation is twist-free, so a gun mount locked at the
   * aim pose points forward while aiming and straight down while at rest.
   */
  private computeAimPose(): { arm: THREE.Quaternion; fore: THREE.Quaternion; armL: THREE.Quaternion; foreL: THREE.Quaternion } {
    const xRot = (ctl: BoneCtl | undefined, angle: number, out: THREE.Quaternion): void => {
      out.setFromAxisAngle(ctl?.px ?? _xAxis, angle).multiply(ctl?.restQ ?? out)
    }
    // Right arm: swing forward ~75°, slight extra elbow bend.
    xRot(this.j.armR, -1.31, this.aimArmQ)
    xRot(this.j.foreR, -0.18, this.aimForeQ)
    // Left arm: forward swing plus an inward roll so the hand crosses to the grip.
    _q1.setFromAxisAngle(this.j.armL?.px ?? _xAxis, -1.22)
    _q2.setFromAxisAngle(this.j.armL?.pz ?? _zAxis, -0.5)
    this.aimArmLQ.copy(_q2).multiply(_q1).multiply(this.j.armL?.restQ ?? this.aimArmLQ)
    _q1.setFromAxisAngle(this.j.foreL?.px ?? _xAxis, -0.35)
    this.aimForeLQ.copy(_q1).multiply(this.j.foreL?.restQ ?? this.aimForeLQ)
    return { arm: this.aimArmQ, fore: this.aimForeQ, armL: this.aimArmLQ, foreL: this.aimForeLQ }
  }

  private addMuzzleFlash(): void {
    const flashMat = new THREE.MeshBasicMaterial({ color: 0xbff6ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
    // Flash size in model units (≈cm) so it reads at ACTOR_H scale in world.
    const flash = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8), flashMat)
    flash.visible = false
    flash.name = 'muzzleFlash'
    this.muzzleNode.add(flash)
    this.muzzleFlash = flash
    if (!this.gunMount) {
      // No weapon: hang the flash off the right hand instead.
      const hand = this.j.handR ?? this.j.hips
      hand?.bone.add(this.muzzleNode)
      this.muzzleNode.position.set(0, -8, 3)
    }
  }

  /* ------------------------------------------------ API ------------------------------------------------ */

  hit(): void {
    this.hurtT = 0.4
  }

  shoot(): void {
    this.shotAt = performance.now()
    if (this.muzzleFlash) {
      this.muzzleFlash.visible = true
      this.muzzleFlash.scale.setScalar(0.7 + Math.random() * 0.9)
    }
  }

  die(): void {
    this.dead = true
  }

  reset(): void {
    this.dead = false
    this.deadT = 0
    this.spawnT = 0
    this.hurtT = 0
    this.moveW = 0
    this.aimW = 0
    this.strafeW = 0
    this.staggerW = 0
    this.windupW = 0
    this.recoverW = 0
    this.root.rotation.x = 0
    this.root.scale.setScalar(0.25)
    for (const ctl of Object.values(this.j)) {
      if (!ctl) continue
      ctl.bone.quaternion.copy(ctl.restQ)
      ctl.bone.position.copy(ctl.restP)
    }
    for (const s of this.jiggle) {
      s.bone.quaternion.copy(s.restQ)
      s.ox = s.oz = s.vx = s.vz = 0
    }
  }

  muzzle(out = new THREE.Vector3()): THREE.Vector3 {
    if (this.gunMount) return this.muzzleNode.getWorldPosition(out)
    const hand = this.j.handR ?? this.j.hips
    if (hand) return hand.bone.getWorldPosition(out)
    return this.root.getWorldPosition(out)
  }

  /* ------------------------------------------------ frame ------------------------------------------------ */

  update(dt: number, st: ActorAnimState): void {
    const cfg = this.cfg
    this.t += dt
    const k = 1 - Math.exp(-dt * 12)

    if (this.spawnT < 1) {
      this.spawnT = Math.min(1, this.spawnT + dt / 0.36)
      const u = 1 - this.spawnT
      const back = 1 + 0.12 * Math.sin(this.spawnT * Math.PI) * u
      this.root.scale.setScalar((0.25 + 0.75 * (1 - u * u * u)) * back)
    } else {
      this.root.scale.setScalar(1)
    }

    // Smoothed weights.
    const alive = !this.dead
    this.moveW += ((st.moving && alive ? 1 : 0) - this.moveW) * k
    this.aimW += (((st.aiming || (st.windup ?? 0) > 0) && alive ? 1 : 0) - this.aimW) * (1 - Math.exp(-dt * 10))
    this.strafeW += (((st.strafe ?? 0) * (alive ? 1 : 0)) - this.strafeW) * k
    this.staggerW += ((st.stagger && alive ? 1 : 0) - this.staggerW) * (1 - Math.exp(-dt * 16))
    this.windupW += (((st.windup ?? 0) * (alive ? 1 : 0)) - this.windupW) * (1 - Math.exp(-dt * 14))
    this.recoverW += (((st.recover ?? 0) * (alive ? 1 : 0)) - this.recoverW) * (1 - Math.exp(-dt * 12))

    const moving = this.moveW > 0.02
    if (moving) this.phase += dt * Math.max(2, st.speed * cfg.stepRate * Math.max(0.35, this.moveW))
    const p = this.phase
    const s = Math.sin(p)
    if (alive && !st.air && this.moveW > 0.35 && ((this.prevSin <= 0 && s > 0) || (this.prevSin >= 0 && s < 0))) {
      st.onStep?.()
    }
    this.prevSin = s

    const rec = Math.max(0, 1 - (performance.now() - this.shotAt) / 130)
    if (this.muzzleFlash && rec < 0.08) this.muzzleFlash.visible = false
    this.hurtT = Math.max(0, this.hurtT - dt)
    const hurt = Math.max(this.staggerW * 0.85, this.hurtT > 0 ? Math.sin((this.hurtT / 0.4) * Math.PI) : 0)
    const breathe = Math.sin(this.t * 1.7 + this.seed) * 0.025
    const w = this.moveW * cfg.swing

    /* ---- death: tip over backwards and let go ---- */
    if (this.dead) {
      this.deadT += dt
      const q = Math.min(1, this.deadT / 0.85) ** 2
      this.root.rotation.x += (-1.42 * q - this.root.rotation.x) * (1 - Math.exp(-dt * 9))
      const hips = this.j.hips
      if (hips) {
        hips.bone.position.y = hips.restP.y - q * this.hipsRestY * 0.12
        swing(hips, 0.12 * q, 0.1 * q)
      }
      this.relaxPose(q)
      this.updateJiggle(dt, 0.4)
      return
    }

    /* ---- hips: bob + sway + strafe roll ---- */
    const hips = this.j.hips
    const strafeRoll = this.strafeW * 0.14
    if (hips) {
      const bob = Math.abs(s) * this.hipsRestY * 0.028 * cfg.bob * this.moveW + breathe * this.hipsRestY * 0.1 - this.staggerW * this.hipsRestY * 0.06
      hips.bone.position.y += (this.hipsRestY + bob - hips.bone.position.y) * k
      swing(hips, -this.staggerW * 0.12, s * 0.055 * w + strafeRoll * 0.5)
      hips.bone.rotation.y = s * 0.09 * w - this.strafeW * 0.22
    }

    /* ---- spine + head ---- */
    const lean = cfg.lean * this.moveW - hurt * 0.26 - this.windupW * 0.14 + this.recoverW * 0.12
    if (this.j.spine) swing(this.j.spine, lean + breathe, -s * 0.04 * w + strafeRoll * 0.7)
    if (this.j.spine1) swing(this.j.spine1, breathe * 0.6 + hurt * 0.1, -s * 0.035 * w - hurt * 0.1)
    if (this.j.spine2) swing(this.j.spine2, -lean * 0.4, s * 0.02 * w)
    if (this.j.neck) swing(this.j.neck, -lean * 0.5 + hurt * 0.16, s * 0.012 * w)
    if (this.j.head) {
      const look = Math.sin(this.t * 0.6 + this.seed) * 0.05 * (1 - this.moveW)
      swing(this.j.head, -lean * 0.3 + hurt * 0.28 + this.windupW * 0.12, look - strafeRoll * 0.4)
    }

    /* ---- legs: walk cycle + strafe/stagger ---- */
    const air = st.air
    const legAmp = 0.62 * w
    const uplegL = this.j.uplegL
    const uplegR = this.j.uplegR
    const legL = this.j.legL
    const legR = this.j.legR
    if (air) {
      if (uplegL) swing(uplegL, -0.55, -0.12)
      if (uplegR) swing(uplegR, 0.3, 0.12)
      if (legL) swing(legL, 1.05, 0)
      if (legR) swing(legR, 0.45, 0)
    } else {
      const stagBend = this.staggerW * 0.3
      if (uplegL) swing(uplegL, s * legAmp - 0.03 + this.staggerW * 0.2, -0.05 - Math.abs(s) * 0.03 * w - Math.max(0, -this.strafeW) * 0.15)
      if (uplegR) swing(uplegR, -s * legAmp - 0.03 - this.staggerW * 0.15, 0.05 + Math.abs(s) * 0.03 * w + Math.max(0, this.strafeW) * 0.15)
      if (legL) swing(legL, Math.max(0, -s) * (1.05 * cfg.swing + 0.35) * Math.max(0.25, this.moveW) + 0.06 + stagBend, 0)
      if (legR) swing(legR, Math.max(0, s) * (1.05 * cfg.swing + 0.35) * Math.max(0.25, this.moveW) + 0.06 + stagBend * 0.8, 0)
      if (this.j.footL) swing(this.j.footL, -s * 0.28 * w - 0.04, 0)
      if (this.j.footR) swing(this.j.footR, s * 0.28 * w - 0.04, 0)
    }

    /* ---- arms: walk, aim, windup telegraph, recoil & stagger ---- */
    const armAmp = 0.5 * w
    const hasGun = !!this.gunMount
    if (hasGun) {
      const windLift = this.windupW * 0.35 - this.recoverW * 0.22
      // Right arm: blend walk-swing → aim pose; windup raises, recoil kicks.
      const armR = this.j.armR!
      swing(armR, -s * armAmp * 0.4 - hurt * 0.25, -hurt * 0.35)
      _q1.copy(armR.bone.quaternion)
      armR.bone.quaternion.copy(_q1).slerp(this.aimArmQ, this.aimW)
      if (Math.abs(windLift) > 0.01) armR.bone.quaternion.premultiply(_q2.setFromAxisAngle(armR.px, -windLift))
      if (rec > 0) armR.bone.quaternion.premultiply(_q2.setFromAxisAngle(armR.px, -0.32 * rec))
      const foreR = this.j.foreR!
      swing(foreR, -0.14 - Math.max(0, s) * 0.25 * w, 0)
      _q1.copy(foreR.bone.quaternion)
      foreR.bone.quaternion.copy(_q1).slerp(this.aimForeQ, this.aimW)
      if (windLift > 0.01) foreR.bone.quaternion.premultiply(_q2.setFromAxisAngle(foreR.px, -0.25 * windLift))
      foreR.bone.quaternion.premultiply(_q2.setFromAxisAngle(foreR.px, 0.45 * rec))
      // Left arm: supports the gun when aiming, swings otherwise.
      const armL = this.j.armL!
      swing(armL, -(-s) * armAmp - hurt * 0.25, hurt * 0.35)
      _q1.copy(armL.bone.quaternion)
      armL.bone.quaternion.copy(_q1).slerp(this.aimArmLQ, this.aimW)
      if (windLift > 0.01) armL.bone.quaternion.premultiply(_q2.setFromAxisAngle(armL.px, -windLift * 0.8))
      const foreL = this.j.foreL!
      swing(foreL, -0.3 - Math.max(0, -s) * 0.3 * w, 0)
      _q1.copy(foreL.bone.quaternion)
      foreL.bone.quaternion.copy(_q1).slerp(this.aimForeLQ, this.aimW)
    } else {
      const armSwing = 0.62 * w
      const flinch = hurt * 0.55
      const windRaise = this.windupW * 0.75
      if (this.j.armL) swing(this.j.armL, -s * armSwing - flinch * 0.4 - windRaise, -0.06 - hurt * 0.28 + Math.sin(this.t * 1.3 + this.seed) * 0.02)
      if (this.j.armR) swing(this.j.armR, s * armSwing - flinch * 0.4 - windRaise, 0.06 + hurt * 0.28 - Math.sin(this.t * 1.3 + this.seed) * 0.02)
      if (this.j.foreL) swing(this.j.foreL, -0.3 - Math.max(0, s) * 0.45 * w - flinch * 0.5 - windRaise * 0.5, 0)
      if (this.j.foreR) swing(this.j.foreR, -0.3 - Math.max(0, -s) * 0.45 * w - flinch * 0.5 - windRaise * 0.5, 0)
    }

    this.updateJiggle(dt, 1)
  }

  /** Dead pose: limbs loosen and splay as the body tips over. */
  private relaxPose(q: number): void {
    const e = (b: BoneCtl | undefined, x: number, z: number): void => {
      if (!b) return
      swing(b, x * q, z * q)
    }
    e(this.j.spine, 0.18, 0.06)
    e(this.j.head, -0.35, 0.1)
    e(this.j.armL, -0.35, -1.05)
    e(this.j.armR, -0.45, 1.0)
    e(this.j.foreL, -0.55, -0.2)
    e(this.j.foreR, -0.5, 0.2)
    e(this.j.uplegL, -0.5, -0.28)
    e(this.j.uplegR, -0.25, 0.3)
    e(this.j.legL, 0.75, 0)
    e(this.j.legR, 0.45, 0)
  }

  /* ------------------------------------------------ secondary motion ------------------------------------------------ */

  private updateJiggle(dt: number, gain: number): void {
    if (!this.jiggle.length) return

    // Character velocity in local space drives the cloth/chain lag.
    this.root.getWorldPosition(_v1)
    const dtSafe = Math.max(1e-4, dt)
    _v2.copy(_v1).sub(this.prevWorldPos).divideScalar(dtSafe)
    this.prevWorldPos.copy(_v1)
    this.velLocal.copy(_v2).applyQuaternion(_q1.copy(this.root.quaternion).invert())
    this.velLocal.divideScalar(14) // world units/s → normalized sway input

    const speed = this.velLocal.length()
    const damp = Math.max(0.35, 1 - speed * 0.5)
    for (const s of this.jiggle) {
      const g = s.gain * this.cfg.secondaryGain * gain
      const targetX = THREE.MathUtils.clamp(this.velLocal.z * 1.6 * g + Math.sin(this.phase * 2) * 0.045 * g * this.moveW, -0.55, 0.55)
      const targetZ = THREE.MathUtils.clamp(-this.velLocal.x * 1.6 * g, -0.5, 0.5)
      const stiff = 130 * damp
      const cd = 2 * Math.sqrt(stiff) * 0.55
      s.vx += ((targetX - s.ox) * stiff - s.vx * cd) * dt
      s.vz += ((targetZ - s.oz) * stiff - s.vz * cd) * dt
      s.ox += s.vx * dt
      s.oz += s.vz * dt
      s.bone.quaternion.setFromAxisAngle(s.px, s.ox).premultiply(_q2.setFromAxisAngle(s.pz, s.oz)).multiply(s.restQ)
    }
  }
}

/** Role → template availability check for the factory. */
export function glbRoleReady(role: GlbRole): boolean {
  return assets.has(ROLES[role].template)
}
