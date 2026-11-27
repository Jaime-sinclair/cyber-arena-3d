/** Shared types for the simulation, the view layer and the network protocol. */
import type { EnemyKind } from './constants'
import type { CurriculumSnapshot } from './typing'

export type { EnemyKind, CurriculumSnapshot }

export interface InputState {
  /** Movement axes, each -1 | 0 | 1 (screen-space: x right, z down). */
  mx: number
  mz: number
  jump: boolean
  dash: boolean
  /** One typed combat key this tick, or null. */
  key: string | null
}

export function emptyInput(): InputState {
  return { mx: 0, mz: 0, jump: false, dash: false, key: null }
}

export interface PlayerState {
  id: number
  name: string
  alive: boolean
  x: number
  z: number
  y: number
  vy: number
  /** Persistent horizontal velocity — momentum movement (combat physics). */
  vx: number
  vz: number
  /** Knockback velocity, decays exponentially; added to vx/vz. */
  kx: number
  kz: number
  ang: number
  facing: number
  lives: number
  inv: number
  score: number
  kills: number
  combo: number
  comboT: number
  bestCombo: number
  correct: number
  wrong: number
  dashT: number
  dashCd: number
  dashDirX: number
  dashDirZ: number
  moving: boolean
  /** Enemy id this player's typing is locked onto, or -1. */
  lockId: number
  /** Slow-field timer mirror (derived each tick, kept for the view). */
  slowed: boolean
}

export interface Enemy {
  id: number
  kind: EnemyKind
  x: number
  z: number
  /** Persistent horizontal velocity for smooth steering/acceleration. */
  vx: number
  vz: number
  /** Facing angle in radians (smoothly turned toward movement/target). */
  ang: number
  /** Deterministic flank direction (-1 or 1) for varied approach angles. */
  flankSign: number
  /** Timer until flanker re-evaluates its approach angle. */
  flankTimer: number
  /** Attack windup/telegraph timer (> 0 while preparing to fire). */
  windup: number
  /** Post-attack recovery timer (> 0 right after firing). */
  recover: number
  /** Airborne height — launched by blasts (combat physics). */
  y: number
  vy: number
  /** Knockback velocity (decays) + stagger timer (no seek/shoot). */
  kx: number
  kz: number
  stag: number
  seq: string
  ti: number
  hp: number
  maxhp: number
  shootCd: number
  patternCd: number
  volleyLeft: number
  volleyT: number
  addCd: number
  mortarCd: number
}

export interface Bullet { x: number; z: number; dx: number; dz: number; speed: number; life: number }
export interface Shock { x: number; z: number; r: number }
export interface Pickup { x: number; z: number; life: number }
export interface Bubble { x: number; z: number; r: number }

/* ---------- Combat physics: dynamic props & ballistic shells ---------- */

export type PropKind = 'CRATE' | 'BARREL'

/** A dynamic rigid body in the arena: supply crates (light, pushable) and
 * barrels (heavy; explosive ones detonate and chain-react). */
export interface PhysProp {
  id: number
  kind: PropKind
  /** Explosive barrel (rust paint + FLAMMABLE stencil); inert = water drum. */
  expl: boolean
  x: number
  z: number
  y: number
  vx: number
  vz: number
  vy: number
  /** Accumulated roll/tumble in radians (view orients the axis). */
  rot: number
  r: number
  hp: number
  /** > 0 → countdown to detonation (chain-reaction delay). */
  fuse: number
  alive: boolean
  sleepT: number
}

/** Boss mortar shell: parabolic ballistic integration, impact = blast. */
export interface Mortar {
  x: number
  z: number
  y: number
  vx: number
  vz: number
  vy: number
}

export type SimEvent =
  | { t: 'kill'; id: number; x: number; z: number; kind: EnemyKind; by: number; combo: number; milestone: boolean; speedKill?: boolean
      /** Ragdoll launch: impulse direction (normalized-ish), spin rate, lift. */
      dx?: number; dz?: number; spin?: number; vy?: number }
  | { t: 'hurt'; p: number; x: number; z: number }
  | { t: 'death'; p: number; x: number; z: number }
  | { t: 'wave'; w: number }
  | { t: 'boss'; hp: number; max: number }
  | { t: 'bossphase'; phase: number }
  | { t: 'seq'; id: number; seq: string; kind: EnemyKind }
  | { t: 'pickup'; p: number; x: number; z: number }
  | { t: 'shot'; id?: number; x: number; z: number; kind: EnemyKind }
  | { t: 'windup'; id: number; x: number; z: number; kind: EnemyKind }
  | { t: 'shock'; x: number; z: number }
  | { t: 'blast'; x: number; z: number; r: number }
  | { t: 'mortar'; x: number; z: number; vx: number; vz: number; vy: number }
  | { t: 'over'; win: boolean; score: number; kills: number }

export type KeyResult = 'none' | 'advance' | 'complete' | 'miss'

/* ---------- View models (what the renderer consumes every frame) ---------- */

export interface ViewPlayer {
  id: number
  x: number
  z: number
  y: number
  ang: number
  lives: number
  inv: number
  score: number
  combo: number
  alive: boolean
  moving: boolean
  dashing: boolean
  dashCd: number
  slowed: boolean
  hurtFlash: number
}

export interface ViewEnemy {
  id: number
  kind: EnemyKind
  x: number
  z: number
  y: number
  ang?: number
  vx?: number
  vz?: number
  stag?: number
  windup?: number
  recover?: number
  ti: number
  seq: string
  hp: number
  maxhp: number
}

export interface ViewProp {
  id: number
  kind: PropKind
  expl: boolean
  x: number
  z: number
  y: number
  rot: number
}

export interface ViewBullet { x: number; z: number; dx: number; dz: number }
export interface ViewShock { x: number; z: number; r: number }
export interface ViewPickup { x: number; z: number }

export interface ViewModel {
  time: number
  wave: number
  kills: number
  over: 0 | 1 | 2 // 0 running, 1 won, 2 lost
  players: ViewPlayer[]
  enemies: ViewEnemy[]
  bullets: ViewBullet[]
  shocks: ViewShock[]
  pickups: ViewPickup[]
  bubbles: Bubble[]
  props: ViewProp[]
  bossHp: number
  bossMax: number
  /** Which enemy the local player is locked onto (-1 = none). */
  lockId: number
  /** Best candidate enemy to lock next when unlocked (-1 = none). */
  candidateId?: number
  /** Hybrid curriculum vocabulary mastery snapshot. */
  curriculum?: CurriculumSnapshot
}

/* ---------- Network snapshots (compact, array-of-arrays) ---------- */

export type SnapPlayer = [
  number, number, number, number, number, number, number, number, number,
  number, number, number, number,
]
// [x, z, y, ang, lives, inv, score, combo, alive, correct, wrong, bestCombo, kills]

export type SnapEnemy = [number, number, number, number, number, number, number, number]
// [id, kindIdx, x, z, ti, hp, maxhp, y] — slot 7 was "moving" (unused by the
// guest view); repurposed for airborne height so launched enemies render.

/** Dynamic props: [id, kindIdx (0 crate / 1 barrel / 2 explosive barrel), x, z, y, rot]. */
export type SnapProp = [number, number, number, number, number, number]

export interface Snapshot {
  v: 1
  t: number // game time
  tm: number // run clock seconds
  w: number
  k: number
  ov: 0 | 1 | 2
  ps: SnapPlayer[]
  es: SnapEnemy[]
  bs: [number, number, number, number][]
  ss: [number, number, number][]
  pk: [number, number][]
  bub: [number, number, number][]
  /** Dynamic combat-physics props (optional for protocol compatibility). */
  pr?: SnapProp[]
  bh: number
  bmx: number
}

export const ENEMY_KIND_ORDER: EnemyKind[] = ['RUNNER', 'GRUNT', 'ELITE', 'BOSS', 'FLANKER']
