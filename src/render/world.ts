/**
 * The arena world — a real-world live-fire training compound at golden hour.
 *
 * Asphalt with painted range lines and a central helipad, a chain-link
 * perimeter on steel posts with a concrete curb, floodlight masts, CONEX
 * container obstacles with stencil markings, and a base backdrop: barracks,
 * a hangar, a water tower, watchtowers, treeline and hazy hills. The artist
 * building model rings the compound as distant base structures.
 *
 * Everything is generated from canvas textures at runtime — zero asset
 * downloads, instant boot, and one cohesive real place. See DESIGN.md.
 */
import * as THREE from 'three'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { ARENA, OBSTACLES } from '../core/constants'
import { assets } from './assets'

function makeTexture(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = 1): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  draw(ctx, size)
  const t = new THREE.CanvasTexture(c)
  t.wrapS = t.wrapT = THREE.RepeatWrapping
  t.repeat.set(repeat, repeat)
  t.anisotropy = 8
  t.colorSpace = THREE.SRGBColorSpace
  return t
}

/** Theme palette (DESIGN.md §4) as hex for canvas painting. */
const C = {
  asphalt: '#65625a',
  paint: 'rgba(232, 226, 208, 0.8)',
  helipad: '#d8a03c',
  steelPost: '#4c5049',
  olive: '#5c6147',
  rust: '#8a6f4d',
  hazard: '#c9a437',
  hazardDark: '#2a2c22',
  concrete: '#7d7a70',
  barracksWall: '#9a9078',
  windowGlass: '#2e3438',
  roofGray: '#6a6d64',
  tree: '#39442e',
  hill: '#6b705f',
}

export class World {
  readonly keyLight: THREE.DirectionalLight
  readonly playerLight: THREE.PointLight
  readonly boomLight: THREE.PointLight
  private readonly hemiLight: THREE.HemisphereLight
  private readonly scene: THREE.Scene
  private readonly dust: THREE.Points
  private readonly sky: THREE.Mesh
  private readonly padBeaconMat: THREE.MeshStandardMaterial
  private readonly floodHeadMat: THREE.MeshStandardMaterial
  private readonly floodConeMat: THREE.MeshBasicMaterial
  private readonly targetBg = new THREE.Color(0xb8b2a2)
  private readonly targetFog = new THREE.Color(0xbdb5a3)
  private readonly targetSun = new THREE.Color(0xffd2a0)
  private readonly targetBeacon = new THREE.Color(0xe89b32)
  private targetFogDensity = 0.0019
  private targetSunIntensity = 2.4
  private dustRate = 0.01
  private t = 0
  private readonly disposables: Array<{ dispose(): void }> = []
  private heroAdded = false
  private readonly offAssetsReady: () => void

  constructor(scene: THREE.Scene) {
    this.scene = scene
    scene.background = new THREE.Color(0xb8b2a2)
    scene.fog = new THREE.FogExp2(0xbdb5a3, 0.0019)

    /* ---------- lights: golden hour, overcast breaking ---------- */
    this.hemiLight = new THREE.HemisphereLight(0xb9c3cf, 0x8a7f6a, 0.75)
    scene.add(this.hemiLight)
    this.keyLight = new THREE.DirectionalLight(0xffd2a0, 2.4)
    this.keyLight.castShadow = true
    this.keyLight.shadow.mapSize.set(1024, 1024)
    Object.assign(this.keyLight.shadow.camera, { near: 10, far: 260, left: -52, right: 52, top: 52, bottom: -52 })
    this.keyLight.shadow.bias = -0.0005
    scene.add(this.keyLight, this.keyLight.target)
    // Cool sky bounce from the opposite side (no second shadow caster).
    const rim = new THREE.DirectionalLight(0xa8b4c2, 0.55)
    rim.position.set(-60, 40, -50)
    scene.add(rim)
    this.playerLight = new THREE.PointLight(0xffe2b8, 1.1, 40)
    this.boomLight = new THREE.PointLight(0xffaa55, 0, 50)
    scene.add(this.playerLight, this.boomLight)

    /* ---------- sky dome: steel gray, warm horizon, soft clouds ---------- */
    const skyTex = makeTexture(1024, (g, s) => {
      const grad = g.createLinearGradient(0, 0, 0, s)
      for (const [stop, color] of [[0, '#6f7c8b'], [0.34, '#8f99a3'], [0.46, '#c3bda9'], [0.52, '#e3cfa8'], [0.56, '#d9c49e'], [0.62, '#bdb5a2'], [1, '#a9a294']] as const) {
        grad.addColorStop(stop, color)
      }
      g.fillStyle = grad
      g.fillRect(0, 0, s, s)
      // Soft cloud streaks
      for (let i = 0; i < 26; i++) {
        const y = s * (0.06 + Math.random() * 0.34)
        const w = s * (0.14 + Math.random() * 0.3)
        const h = 6 + Math.random() * 16
        const x = Math.random() * s
        g.fillStyle = `rgba(214, 212, 205, ${0.10 + Math.random() * 0.16})`
        g.beginPath()
        g.ellipse(x, y, w, h, 0, 0, 7)
        g.fill()
        g.fillStyle = `rgba(240, 236, 226, ${0.05 + Math.random() * 0.08})`
        g.beginPath()
        g.ellipse(x + w * 0.2, y - h * 0.4, w * 0.7, h * 0.55, 0, 0, 7)
        g.fill()
      }
      // Low sun bleeding through the haze
      const sun = g.createRadialGradient(s * 0.78, s * 0.52, 8, s * 0.78, s * 0.52, 240)
      sun.addColorStop(0, 'rgba(255, 236, 200, 0.95)')
      sun.addColorStop(0.25, 'rgba(250, 220, 170, 0.5)')
      sun.addColorStop(1, 'rgba(250, 220, 170, 0)')
      g.fillStyle = sun
      g.fillRect(0, s * 0.3, s, s * 0.4)
    })
    skyTex.wrapS = skyTex.wrapT = THREE.ClampToEdgeWrapping
    this.sky = new THREE.Mesh(
      new THREE.SphereGeometry(900, 32, 16),
      new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false }),
    )
    scene.add(this.sky)

    /* ---------- floor: asphalt with painted range lines ---------- */
    const floorTex = makeTexture(256, (g, s) => {
      g.fillStyle = C.asphalt
      g.fillRect(0, 0, s, s)
      // Aggregate speckle
      for (let i = 0; i < 900; i++) {
        const v = Math.random()
        g.fillStyle = v < 0.5
          ? `rgba(30, 30, 26, ${0.06 + Math.random() * 0.1})`
          : `rgba(200, 195, 180, ${0.03 + Math.random() * 0.07})`
        g.fillRect(Math.random() * s, Math.random() * s, 2, 2)
      }
      // Worn tire streaks
      g.strokeStyle = 'rgba(28, 28, 24, 0.10)'
      g.lineWidth = 7
      for (let i = 0; i < 3; i++) {
        g.beginPath()
        const x = Math.random() * s
        g.moveTo(x, 0)
        g.bezierCurveTo(x + 18, s * 0.33, x - 18, s * 0.66, x + 8, s)
        g.stroke()
      }
      // Painted range grid (aged white)
      g.strokeStyle = C.paint
      g.lineWidth = 5
      g.strokeRect(0, 0, s, s)
      g.lineWidth = 2
      g.strokeStyle = 'rgba(232, 226, 208, 0.4)'
      g.beginPath()
      g.moveTo(s / 2, 0); g.lineTo(s / 2, s)
      g.moveTo(0, s / 2); g.lineTo(s, s / 2)
      g.stroke()
    }, 70)
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1000, 1000),
      new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.94, metalness: 0.02 }),
    )
    floor.rotation.x = -Math.PI / 2
    floor.receiveShadow = true
    scene.add(floor)

    /* ---------- center helipad decal ---------- */
    const padTex = makeTexture(512, (g, s) => {
      g.strokeStyle = C.helipad
      g.lineWidth = 16
      g.beginPath()
      g.arc(s / 2, s / 2, 226, 0, 7)
      g.stroke()
      // H built from bars — no font dependency
      const bar = 30, hgt = 200, gap = 110
      g.fillStyle = C.helipad
      g.fillRect(s / 2 - gap / 2 - bar, s / 2 - hgt / 2, bar, hgt)
      g.fillRect(s / 2 + gap / 2, s / 2 - hgt / 2, bar, hgt)
      g.fillRect(s / 2 - gap / 2 - bar, s / 2 - bar / 2, gap + bar * 2, bar)
    })
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(56, 56),
      new THREE.MeshBasicMaterial({ map: padTex, transparent: true, depthWrite: false, opacity: 0.9 }),
    )
    pad.rotation.x = -Math.PI / 2
    pad.position.y = 0.08
    pad.renderOrder = 1
    scene.add(pad)

    /* ---------- helipad perimeter beacons ---------- */
    this.padBeaconMat = new THREE.MeshStandardMaterial({
      color: 0x3b3d36,
      roughness: 0.4,
      metalness: 0.7,
      emissive: 0xe89b32,
      emissiveIntensity: 0.7,
    })
    {
      const beacons = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.45, 0.58, 0.26, 8), this.padBeaconMat, 8)
      const mt = new THREE.Matrix4()
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 + Math.PI / 8
        mt.makeTranslation(Math.cos(a) * 25.5, 0.13, Math.sin(a) * 25.5)
        beacons.setMatrixAt(i, mt)
      }
      scene.add(beacons)
    }

    /* ---------- base backdrop: barracks, hangar, towers, treeline, hills ---------- */
    this.buildBase(scene)

    /* ---------- perimeter: chain-link fence on steel posts ---------- */
    this.buildFence(scene)

    /* ---------- floodlight masts ---------- */
    {
      const N = 28
      const poleMat = new THREE.MeshStandardMaterial({ color: 0x3d4038, roughness: 0.6, metalness: 0.7 })
      this.floodHeadMat = new THREE.MeshStandardMaterial({ color: 0x2a2c26, roughness: 0.5, metalness: 0.6, emissive: 0xffd9a0, emissiveIntensity: 0.35 })
      this.floodConeMat = new THREE.MeshBasicMaterial({ color: 0xffe4b8, transparent: true, opacity: 0.045, blending: THREE.AdditiveBlending, depthWrite: false })
      const poles = new THREE.InstancedMesh(new THREE.BoxGeometry(0.9, 15, 0.9), poleMat, N)
      const heads = new THREE.InstancedMesh(new THREE.BoxGeometry(3.4, 1.4, 1.2), this.floodHeadMat, N)
      const cones = new THREE.InstancedMesh(
        new THREE.ConeGeometry(4.2, 10.5, 8, 1, true),
        this.floodConeMat,
        N,
      )
      const mt = new THREE.Matrix4()
      let n = 0
      for (let i = -3; i <= 3; i++) {
        const o = i * 30
        for (const [x, z] of [[o, -ARENA], [o, ARENA], [-ARENA, o], [ARENA, o]] as const) {
          mt.makeTranslation(x, 7.5, z)
          poles.setMatrixAt(n, mt)
          mt.makeTranslation(x, 15.2, z)
          heads.setMatrixAt(n, mt)
          mt.makeTranslation(x, 9.6, z)
          cones.setMatrixAt(n, mt)
          n++
        }
      }
      poles.castShadow = true
      scene.add(poles, heads, cones)
    }

    /* ---------- obstacles: CONEX containers ---------- */
    this.buildContainers(scene)

    /* ---------- dust motes in the low sun ---------- */
    const dg = new THREE.BufferGeometry()
    const dp = new Float32Array(1800)
    for (let i = 0; i < 1800; i += 3) {
      dp[i] = (Math.random() - 0.5) * 200
      dp[i + 1] = 1 + Math.random() * 40
      dp[i + 2] = (Math.random() - 0.5) * 200
    }
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3))
    this.dust = new THREE.Points(dg, new THREE.PointsMaterial({ color: 0xd8c8a8, size: 0.5, transparent: true, opacity: 0.4, depthWrite: false }))
    scene.add(this.dust)

    this.disposables.push(skyTex, floorTex, padTex)

    /* ---------- hero skyline (artist building model) ---------- */
    this.offAssetsReady = assets.onReady(() => this.addHeroBuildings(scene))
  }

  /**
   * A ring of the artist-authored building model breaks up the procedural
   * base with real architecture — placed deterministically outside the fence.
   */
  private addHeroBuildings(scene: THREE.Scene): void {
    if (this.heroAdded) return
    const tpl = assets.get('building')
    if (!tpl) return
    this.heroAdded = true

    // Deterministic scatter on a ring outside the fence (LCG, fixed seed).
    let rngState = 0x9e3779b9
    const rand = (): number => {
      rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0
      return rngState / 0xffffffff
    }
    const ring = new THREE.Group()
    ring.name = 'heroBuildings'
    const COUNT = 14
    for (let i = 0; i < COUNT; i++) {
      const angle = (i / COUNT) * Math.PI * 2 + rand() * 0.35
      const dist = 165 + rand() * 110
      const x = Math.cos(angle) * dist
      const z = Math.sin(angle) * dist
      // Skip the four street axes so the skyline doesn't block sightlines.
      if (Math.abs(Math.cos(angle)) > 0.94 || Math.abs(Math.sin(angle)) > 0.94) continue
      const h = 62 + rand() * 95
      const b = tpl.scene.clone(true)
      b.scale.set(h, h, h)
      b.position.set(x, -tpl.minY * h, z)
      b.rotation.y = Math.floor(rand() * 4) * (Math.PI / 2) + (rand() - 0.5) * 0.4
      ring.add(b)
    }
    ring.traverse(o => {
      const mesh = o as THREE.Mesh
      if (mesh.isMesh) {
        mesh.castShadow = false
        mesh.receiveShadow = false
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const m of mats) {
          const std = m as THREE.MeshStandardMaterial
          if (std.isMeshStandardMaterial) std.envMapIntensity = 0.6
        }
      }
    })
    scene.add(ring)
    this.disposables.push({ dispose: (): void => { ring.removeFromParent() } })
  }

  /**
   * The base beyond the fence — but unlike the old neon city (~270 separate
   * meshes), each building's UVs are baked at build time so the entire base
   * merges into a handful of draw calls. Everything is sun-lit standard
   * material: barracks with dark window bands, a hangar, a water tower and
   * two watchtowers as small groups, then treeline and hills merged.
   */
  private buildBase(scene: THREE.Scene): void {
    const wallTex = makeTexture(128, (g, s) => {
      g.fillStyle = C.barracksWall
      g.fillRect(0, 0, s, s)
      // Subtle panel seams
      g.strokeStyle = 'rgba(60, 56, 46, 0.25)'
      g.lineWidth = 2
      for (let y = 24; y < s; y += 28) {
        g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke()
      }
      // Dark window band (daytime glass)
      g.fillStyle = C.windowGlass
      for (let y = 40; y < s - 30; y += 44) {
        for (let x = 8; x < s - 14; x += 26) {
          g.fillRect(x, y, 16, 20)
        }
      }
    }, 1)
    const roofMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.roofGray), roughness: 0.9 })
    const wallMat = new THREE.MeshStandardMaterial({ map: wallTex, roughness: 0.85 })

    /* Barracks: long low buildings on a street grid, merged. */
    const barracksGeos: THREE.BufferGeometry[] = []
    const roofGeos: THREE.BufferGeometry[] = []
    for (let gx = -5; gx <= 5; gx++) {
      for (let gz = -5; gz <= 5; gz++) {
        const cx = gx * 48
        const cz = gz * 48
        if (Math.max(Math.abs(cx), Math.abs(cz)) < ARENA + 40 || Math.random() < 0.25) continue
        const w = 24 + Math.random() * 10
        const d = 12 + Math.random() * 6
        const h = 9 + Math.random() * 5
        const geo = new THREE.BoxGeometry(w, h, d)
        // Bake window density into UVs (single shared material).
        const uv = geo.attributes.uv as THREE.BufferAttribute
        for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (w / 12), uv.getY(i) * (h / 12))
        geo.translate(cx, h / 2, cz)
        barracksGeos.push(geo)
        const roof = new THREE.BoxGeometry(w + 1.4, 0.8, d + 1.4)
        roof.translate(cx, h + 0.4, cz)
        roofGeos.push(roof)
      }
    }
    if (barracksGeos.length) {
      scene.add(new THREE.Mesh(mergeGeometries(barracksGeos)!, wallMat))
      scene.add(new THREE.Mesh(mergeGeometries(roofGeos)!, roofMat))
      for (const g of [...barracksGeos, ...roofGeos]) g.dispose()
    }
    this.disposables.push(wallTex)

    /* Hangar: half-cylinder, open end toward the range. */
    const hangarMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.roofGray), roughness: 0.7, metalness: 0.3 })
    for (const [x, z, ry] of [[-150, -95, 0.6], [140, 110, 2.4] as const]) {
      const hangar = new THREE.Group()
      const shell = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 52, 24, 1, false, 0, Math.PI), hangarMat)
      shell.rotation.z = Math.PI / 2
      shell.rotation.y = Math.PI / 2
      shell.position.y = 0.1
      shell.castShadow = true
      hangar.add(shell)
      hangar.position.set(x, 0, z)
      hangar.rotation.y = ry
      scene.add(hangar)
    }

    /* Water tower + watchtowers: small steel groups. */
    const steelMat = new THREE.MeshStandardMaterial({ color: 0x5b5e52, roughness: 0.55, metalness: 0.65 })
    {
      const tower = new THREE.Group()
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 9, 14), hangarMat)
      tank.position.y = 26
      tank.castShadow = true
      const cone = new THREE.Mesh(new THREE.ConeGeometry(7.6, 4, 14), roofMat)
      cone.position.y = 32.5
      tower.add(tank, cone)
      for (const [lx, lz] of [[-4.5, -4.5], [4.5, -4.5], [-4.5, 4.5], [4.5, 4.5]] as const) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(1, 22, 1), steelMat)
        leg.position.set(lx, 11, lz)
        tower.add(leg)
      }
      tower.position.set(-120, 0, 130)
      scene.add(tower)
    }
    for (const [x, z] of [[130, -130], [-140, -60] as const]) {
      const wt = new THREE.Group()
      for (const [lx, lz] of [[-2.2, -2.2], [2.2, -2.2], [-2.2, 2.2], [2.2, 2.2]] as const) {
        const leg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 17, 0.7), steelMat)
        leg.position.set(lx, 8.5, lz)
        wt.add(leg)
      }
      const cabin = new THREE.Mesh(new THREE.BoxGeometry(6.4, 4, 6.4), wallMat)
      cabin.position.y = 19
      cabin.castShadow = true
      const roof = new THREE.Mesh(new THREE.ConeGeometry(5, 2.4, 4), roofMat)
      roof.position.y = 22.4
      roof.rotation.y = Math.PI / 4
      wt.add(cabin, roof)
      wt.position.set(x, 0, z)
      scene.add(wt)
    }

    /* Treeline: irregular dark band ringing the compound, merged. */
    const treeGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 90; i++) {
      const angle = (i / 90) * Math.PI * 2 + Math.random() * 0.06
      const dist = 175 + Math.random() * 70
      const w = 9 + Math.random() * 12
      const h = 10 + Math.random() * 13
      const b = new THREE.BoxGeometry(w, h, w * (0.7 + Math.random() * 0.5))
      b.translate(Math.cos(angle) * dist, h / 2, Math.sin(angle) * dist)
      treeGeos.push(b)
    }
    const trees = new THREE.Mesh(
      mergeGeometries(treeGeos)!,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(C.tree), roughness: 1 }),
    )
    scene.add(trees)
    for (const g of treeGeos) g.dispose()

    /* Distant hazy hills. */
    const hillGeos: THREE.BufferGeometry[] = []
    for (let i = 0; i < 14; i++) {
      const angle = (i / 14) * Math.PI * 2 + Math.random() * 0.3
      const dist = 380 + Math.random() * 170
      const r = 90 + Math.random() * 130
      const h = 45 + Math.random() * 70
      const cone = new THREE.ConeGeometry(r, h, 7)
      cone.translate(Math.cos(angle) * dist, h / 2 - 6, Math.sin(angle) * dist)
      hillGeos.push(cone)
    }
    const hills = new THREE.Mesh(
      mergeGeometries(hillGeos)!,
      new THREE.MeshStandardMaterial({ color: new THREE.Color(C.hill), roughness: 1 }),
    )
    scene.add(hills)
    for (const g of hillGeos) g.dispose()
  }

  /** Chain-link perimeter: alpha-tested mesh on posts with a concrete curb. */
  private buildFence(scene: THREE.Scene): void {
    const linkTex = makeTexture(128, (g, s) => {
      g.clearRect(0, 0, s, s)
      g.strokeStyle = 'rgba(140, 142, 130, 0.95)'
      g.lineWidth = 3
      // Diamond weave
      for (let i = -s; i < s * 2; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke()
        g.beginPath(); g.moveTo(i, s); g.lineTo(i + s, 0); g.stroke()
      }
    }, 1)
    const postMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.steelPost), roughness: 0.5, metalness: 0.75 })
    const curbMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(C.concrete), roughness: 0.95 })
    const FENCE_H = 5.4
    const SIDES = [[0, -ARENA, 0], [0, ARENA, 0], [ARENA, 0, Math.PI / 2], [-ARENA, 0, Math.PI / 2]] as const
    for (const [x, z, ry] of SIDES) {
      const g = new THREE.Group()
      g.position.set(x, 0, z)
      g.rotation.y = ry
      scene.add(g)
      // Concrete curb
      const curb = new THREE.Mesh(new THREE.BoxGeometry(ARENA * 2, 1.1, 1.6), curbMat)
      curb.position.y = 0.55
      curb.receiveShadow = true
      g.add(curb)
      // Chain-link mesh (texture repeats along its length)
      const tex = linkTex.clone()
      tex.needsUpdate = true
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping
      tex.repeat.set(ARENA * 2 / 6, 1)
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(ARENA * 2, FENCE_H),
        new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.5, metalness: 0.8, color: 0xb9bbae }),
      )
      mesh.position.y = 1.1 + FENCE_H / 2
      g.add(mesh)
      // Top rail
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, ARENA * 2, 6), postMat)
      rail.rotation.z = Math.PI / 2
      rail.position.y = 1.1 + FENCE_H
      g.add(rail)
    }
    // Posts every 12 units along each side (instanced)
    const perSide = Math.ceil((ARENA * 2) / 12) + 1
    const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(0.35, FENCE_H + 1.4, 0.35), postMat, perSide * 4)
    const mt = new THREE.Matrix4()
    let n = 0
    for (let i = 0; i < perSide; i++) {
      const o = -ARENA + i * 12
      for (const [px, pz] of [[o, -ARENA], [o, ARENA], [-ARENA, o], [ARENA, o]] as const) {
        mt.makeTranslation(px, (FENCE_H + 1.4) / 2, pz)
        posts.setMatrixAt(n, mt)
        n++
      }
    }
    posts.castShadow = true
    scene.add(posts)
    this.disposables.push(linkTex)
  }

  /** CONEX shipping containers: corrugated steel, frame rails, roof ribs & contact AO. */
  private buildContainers(scene: THREE.Scene): void {
    const STENCILS = ['ORDNANCE', '5.56 MM', 'SUPPLY', 'AMMO LOT 7', 'RATIONS', 'SPARES'] as const
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x2c2f28, roughness: 0.55, metalness: 0.65 })
    const aoTex = makeTexture(128, (g, s) => {
      const grad = g.createRadialGradient(s / 2, s / 2, s * 0.15, s / 2, s / 2, s * 0.5)
      grad.addColorStop(0, 'rgba(10, 10, 8, 0.42)')
      grad.addColorStop(0.75, 'rgba(10, 10, 8, 0.24)')
      grad.addColorStop(1, 'rgba(10, 10, 8, 0)')
      g.fillStyle = grad
      g.fillRect(0, 0, s, s)
    })
    const aoMat = new THREE.MeshBasicMaterial({ map: aoTex, transparent: true, depthWrite: false })
    this.disposables.push(aoTex)

    OBSTACLES.forEach((o, i) => {
      const olive = i % 2 === 0
      const base = olive ? C.olive : C.rust
      const tex = makeTexture(256, (g, s) => {
        g.fillStyle = base
        g.fillRect(0, 0, s, s)
        // Corrugation ridges
        for (let x = 0; x < s; x += 16) {
          g.fillStyle = 'rgba(255, 250, 230, 0.06)'
          g.fillRect(x, 0, 7, s)
          g.fillStyle = 'rgba(12, 14, 10, 0.22)'
          g.fillRect(x + 7, 0, 3, s)
        }
        // Wear + rust patches
        for (let k = 0; k < 40; k++) {
          g.fillStyle = `rgba(30, 24, 16, ${0.04 + Math.random() * 0.08})`
          g.fillRect(Math.random() * s, Math.random() * s, 3 + Math.random() * 10, 2 + Math.random() * 6)
        }
        // Stencil marking
        g.save()
        g.translate(s / 2, s * 0.36)
        g.fillStyle = 'rgba(235, 229, 210, 0.85)'
        g.font = '700 34px "Big Shoulders Stencil Display", "Barlow Condensed", "Arial Narrow", sans-serif'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(STENCILS[i % STENCILS.length]!, 0, 0)
        g.restore()
        // Hazard stripe on the lower edge
        g.fillStyle = C.hazard
        g.fillRect(0, s * 0.86, s, 6)
        g.fillStyle = C.hazardDark
        for (let x = -s; x < s * 2; x += 28) {
          g.beginPath()
          g.moveTo(x, s)
          g.lineTo(x + 14, s)
          g.lineTo(x + 38, s * 0.86)
          g.lineTo(x + 24, s * 0.86)
          g.fill()
        }
      })
      tex.repeat.set(Math.max(1, Math.round((o.hw * 2) / 12)), 1)
      const g = new THREE.Group()
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(o.hw * 2, o.h, o.hd * 2),
        new THREE.MeshStandardMaterial({ map: tex, roughness: 0.7, metalness: 0.35 }),
      )
      body.position.y = o.h / 2
      body.castShadow = body.receiveShadow = true
      g.add(body)

      // Structural frame posts + roof ribs merged into 1 draw call per container.
      const trimGeos: THREE.BufferGeometry[] = []
      for (const sx of [-1, 1] as const) {
        for (const sz of [-1, 1] as const) {
          const post = new THREE.BoxGeometry(0.65, o.h + 0.15, 0.65)
          post.translate(sx * (o.hw - 0.15), o.h / 2, sz * (o.hd - 0.15))
          trimGeos.push(post)
        }
      }
      const ribStep = 2.6
      for (let rx = -o.hw + 1.5; rx <= o.hw - 1.5; rx += ribStep) {
        const rib = new THREE.BoxGeometry(0.45, 0.25, o.hd * 1.92)
        rib.translate(rx, o.h + 0.1, 0)
        trimGeos.push(rib)
      }
      const trimMesh = new THREE.Mesh(mergeGeometries(trimGeos)!, trimMat)
      trimMesh.castShadow = false
      for (const tg of trimGeos) tg.dispose()
      g.add(trimMesh)

      // Ground-contact AO skirt
      const ao = new THREE.Mesh(new THREE.PlaneGeometry(o.hw * 2 + 3.2, o.hd * 2 + 3.2), aoMat)
      ao.rotation.x = -Math.PI / 2
      ao.position.y = 0.04
      g.add(ao)

      g.position.set(o.x, 0, o.z)
      scene.add(g)
      this.disposables.push(tex)
    })
  }

  /** Smoothly transition lighting & atmospheric state across waves and boss encounters. */
  setAtmosphere(wave: number, bossActive: boolean): void {
    if (bossActive || wave >= 3) {
      this.targetBg.setHex(0x887b75)
      this.targetFog.setHex(0x8d7f78)
      this.targetSun.setHex(0xeba888)
      this.targetBeacon.setHex(0xe84a2c)
      this.targetFogDensity = 0.0024
      this.targetSunIntensity = 2.0
      this.dustRate = 0.025
      this.floodHeadMat.emissiveIntensity = 0.9
      this.floodConeMat.opacity = 0.075
    } else if (wave === 2) {
      this.targetBg.setHex(0xa89d8d)
      this.targetFog.setHex(0xad9f8c)
      this.targetSun.setHex(0xffbc78)
      this.targetBeacon.setHex(0xe88a2c)
      this.targetFogDensity = 0.0021
      this.targetSunIntensity = 2.25
      this.dustRate = 0.016
      this.floodHeadMat.emissiveIntensity = 0.65
      this.floodConeMat.opacity = 0.06
    } else {
      this.targetBg.setHex(0xb8b2a2)
      this.targetFog.setHex(0xbdb5a3)
      this.targetSun.setHex(0xffd2a0)
      this.targetBeacon.setHex(0xe89b32)
      this.targetFogDensity = 0.0019
      this.targetSunIntensity = 2.4
      this.dustRate = 0.01
      this.floodHeadMat.emissiveIntensity = 0.35
      this.floodConeMat.opacity = 0.045
    }
  }

  update(dt: number, px: number, pz: number, cameraPos: THREE.Vector3): void {
    this.t += dt
    const k = Math.min(1, dt * 1.5)
    if (this.scene.background instanceof THREE.Color) this.scene.background.lerp(this.targetBg, k)
    if (this.scene.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.lerp(this.targetFog, k)
      this.scene.fog.density += (this.targetFogDensity - this.scene.fog.density) * k
    }
    this.keyLight.color.lerp(this.targetSun, k)
    this.keyLight.intensity += (this.targetSunIntensity - this.keyLight.intensity) * k
    this.padBeaconMat.emissive.lerp(this.targetBeacon, k)
    this.padBeaconMat.emissiveIntensity = 0.55 + 0.35 * Math.sin(this.t * 2.6)
    this.dust.rotation.y += dt * this.dustRate
    this.sky.position.copy(cameraPos)
    // Low western sun: constant direction relative to the player (shadow follows).
    this.keyLight.position.set(px - 85, 48, pz + 32)
    this.keyLight.target.position.set(px, 0, pz)
    this.playerLight.position.set(px, 6, pz)
  }

  boom(x: number, z: number, color: number, intensity = 10): void {
    this.boomLight.position.set(x, 5, z)
    this.boomLight.color.setHex(color)
    this.boomLight.intensity = intensity
  }

  decayBoom(dt: number): void {
    this.boomLight.intensity = Math.max(0, this.boomLight.intensity - dt * 40)
  }

  dispose(): void {
    this.offAssetsReady()
    for (const d of this.disposables) d.dispose()
  }
}
