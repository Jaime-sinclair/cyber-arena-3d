/**
 * Floating target placards above enemies: stenciled plates with corner
 * rivets — the range signage of the RANGE HOT theme. Canvas-rendered, with an
 * LRU texture cache keyed by (sequence, progress, locked) — no per-keystroke
 * allocation.
 */
import * as THREE from 'three'
import { ACTOR_H, KINDS } from '../core/constants'
import type { EnemyKind } from '../core/constants'

const CACHE_MAX = 96

/** Theme colors (DESIGN.md §4) — hex form for canvas 2D. */
const PLATE_BG = 'rgba(24, 26, 21, 0.95)'
const PLATE_EDGE = 'rgba(232, 226, 208, 0.9)'
const PLATE_EDGE_LOCKED = 'rgba(240, 130, 50, 0.95)'
const RIVET = 'rgba(140, 144, 120, 0.9)'
const CHAR_DONE = '#a3c477'
const CHAR_CURRENT = '#ffffff'
const CHAR_CURRENT_LOCKED = '#f58840'
const CHAR_TODO = 'rgba(205, 200, 180, 0.72)'
const TICK = '#e8742c'

export class LabelSystem {
  private readonly cache = new Map<string, THREE.CanvasTexture>()
  private readonly labels = new Map<number, { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; key: string }>

  constructor(private readonly scene: THREE.Scene) {}

  private texture(seq: string, ti: number, locked: boolean): THREE.CanvasTexture {
    const key = `${seq}|${ti}|${locked ? 1 : 0}`
    const hit = this.cache.get(key)
    if (hit) {
      // LRU refresh
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const cv = document.createElement('canvas')
    cv.width = 512
    cv.height = 160
    const g = cv.getContext('2d')!
    // Steel plate
    g.fillStyle = PLATE_BG
    g.strokeStyle = locked ? PLATE_EDGE_LOCKED : PLATE_EDGE
    g.lineWidth = 6
    g.beginPath()
    g.rect(22, 12, 468, 108)
    g.fill()
    g.stroke()
    // Corner rivets
    g.fillStyle = RIVET
    for (const [rx, ry] of [[40, 30], [472, 30], [40, 102], [472, 102]] as const) {
      g.beginPath()
      g.arc(rx, ry, 4, 0, 7)
      g.fill()
    }
    // Stenciled sequence
    g.font = '700 88px "Barlow Condensed", "Arial Narrow", sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    const chars = [...seq].map(c => (c === ' ' ? '␣' : c))
    const sx = 256 - ((chars.length - 1) * 72) / 2
    chars.forEach((c, i) => {
      const cur = i === ti
      g.fillStyle = i < ti ? CHAR_DONE : cur ? (locked ? CHAR_CURRENT_LOCKED : CHAR_CURRENT) : CHAR_TODO
      g.fillText(c, sx + i * 72, 64)
      if (cur) {
        g.fillStyle = TICK
        g.fillRect(sx + i * 72 - 16, 106, 32, 8)
      }
    })
    const tex = new THREE.CanvasTexture(cv)
    tex.minFilter = THREE.LinearFilter
    tex.colorSpace = THREE.SRGBColorSpace
    if (this.cache.size >= CACHE_MAX) {
      const oldest = this.cache.keys().next().value
      if (oldest !== undefined) {
        this.cache.get(oldest)?.dispose()
        this.cache.delete(oldest)
      }
    }
    this.cache.set(key, tex)
    return tex
  }

  /** Ensure a label exists for an enemy (attached to the scene); returns its mesh. */
  ensure(id: number, kind: EnemyKind): THREE.Mesh {
    let entry = this.labels.get(id)
    if (!entry) {
      const mat = new THREE.MeshBasicMaterial({
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: false,
        depthTest: false,
        fog: false,
      })
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(6, 1.875), mat)
      mesh.renderOrder = 10
      mesh.scale.setScalar(kind === 'BOSS' ? 2.45 : 1.55)
      entry = { mesh, mat, key: '' }
      this.labels.set(id, entry)
      this.scene.add(mesh)
    }
    return entry.mesh
  }

  /** Update label content + billboard position. */
  update(id: number, kind: EnemyKind, seq: string, ti: number, locked: boolean, x: number, y: number, z: number, camQuat: THREE.Quaternion): void {
    const entry = this.labels.get(id)
    if (!entry) return
    const key = `${seq}|${ti}|${locked ? 1 : 0}`
    if (key !== entry.key) {
      entry.key = key
      entry.mat.map = this.texture(seq, ti, locked)
      entry.mat.needsUpdate = true
    }
    entry.mesh.position.set(x, y + (kind === 'BOSS' ? 6 : 1.8), z)
    entry.mesh.quaternion.copy(camQuat)
    const baseScale = kind === 'BOSS' ? 2.45 : 1.55
    entry.mesh.scale.setScalar(locked ? baseScale * 1.12 : baseScale)
  }

  labelY(kind: EnemyKind): number {
    return ACTOR_H * KINDS[kind].scale + 1.8
  }

  remove(id: number): void {
    const entry = this.labels.get(id)
    if (!entry) return
    entry.mesh.removeFromParent()
    entry.mat.dispose()
    entry.mesh.geometry.dispose()
    this.labels.delete(id)
  }

  clear(): void {
    for (const id of [...this.labels.keys()]) this.remove(id)
  }
}
