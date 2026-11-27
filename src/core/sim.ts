/**
 * The authoritative, deterministic game simulation.
 *
 * Rules of the house:
 *  - NO Math.random anywhere. All randomness flows from the seeded RNG.
 *  - NO DOM / three.js / network imports. Pure logic + data.
 *  - Fixed timestep (1/60). The host (or solo player) steps it; the renderer
 *    and the network layer only read from it.
 *
 * This determinism is what makes the daily challenge fair, the unit tests
 * golden, and the co-op host authoritative without drift.
 */
import { RNG } from './rng'
import { blastImpulse, stepProps, wakeProp, PROP_MASS } from './physics'
import {
  ARENA, BULLET_LIFE, COMBO_SCORE_CAP, COMBO_SCORE_PER, COMBO_SPEED_MAX, COMBO_SPEED_PER,
  COMBO_WINDOW, DASH_CD, DASH_INV, DASH_MULT, DASH_TIME, GRAVITY, INV_TIME, JUMP_VY,
  KEYS, KINDS, LIVES_MAX, OBSTACLES, PICKUP_LIFE, PLAYER_ACCEL, PLAYER_AIR_ACCEL, PLAYER_KNOCK_DECAY,
  PLAYER_PUSH_FORCE, PLAYER_RADIUS, PLAYER_SPEED, LAND_BOUNCE,
  THREAT_BASE, THREAT_GAIN, THREAT_KILLS, THREAT_MAX, WAVE2_KILLS, WAVE3_KILLS,
  BARREL_R, BLAST_KILL_RADIUS, BLAST_LAUNCH, BLAST_POWER, BLAST_RADIUS,
  CHAIN_DELAY_MIN, CHAIN_DELAY_RAND, CRATE_R, KILL_FUSE_RADIUS,
  MORTAR_CD, MORTAR_KILL_RADIUS, MORTAR_LAUNCH, MORTAR_POWER, MORTAR_RADIUS, MORTAR_VY,
  type EnemyKind, type Obstacle,
} from './constants'
import type {
  Bubble, Bullet, Enemy, InputState, KeyResult, Pickup, PlayerState, PhysProp, Shock, SimEvent, Snapshot, Mortar,
} from './types'
import { ENEMY_KIND_ORDER, emptyInput } from './types'
import { CurriculumTracker, adaptiveEnemySpeedScale } from './typing'
import { wpm } from './stats'

export interface MoveCtx {
  obstacles: readonly Obstacle[]
  bubbles: readonly Bubble[]
  /** Arena half-size. */
  arena: number
}

const MOVE_CTX: MoveCtx = { obstacles: OBSTACLES, bubbles: [], arena: ARENA }

function circleHitsObstacle(x: number, z: number, r: number, obs: readonly Obstacle[]): boolean {
  for (const o of obs) {
    if (x > o.x - o.hw - r && x < o.x + o.hw + r && z > o.z - o.hd - r && z < o.z + o.hd + r) return true
  }
  return false
}

function pushOutOfObstacles(p: { x: number; z: number }, r: number, obs: readonly Obstacle[]): void {
  for (const o of obs) {
    const hx = o.hw + r
    const hz = o.hd + r
    const dx = p.x - o.x
    const dz = p.z - o.z
    if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
      if (hx - Math.abs(dx) < hz - Math.abs(dz)) p.x = o.x + Math.sign(dx || 1) * hx
      else p.z = o.z + Math.sign(dz || 1) * hz
    }
  }
}

function inSlowBubble(x: number, z: number, y: number, bubbles: readonly Bubble[]): boolean {
  for (const b of bubbles) {
    if (Math.hypot(x - b.x, z - b.z) < b.r * 0.92 && y < b.r * 0.8) return true
  }
  return false
}

const lerpAngle = (a: number, b: number, t: number): number =>
  a + (((((b - a + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) - Math.PI)) * t

/**
 * Shared movement body — used by the authoritative sim AND by the co-op
 * guest's local prediction, so both sides move with identical physics.
 *
 * Combat physics 2.0: momentum model. Input steers a persistent velocity
 * (accel/decel curves, reduced air control) instead of teleporting speed;
 * knockback velocity decays on top; landing hard bounces slightly. All
 * integrated with the fixed dt only — frame-rate independent by construction.
 */
export function movePlayerBody(p: PlayerState, inp: InputState, dt: number, ctx: MoveCtx, comboSpeed: number): void {
  // Knockback decay (exponential, dt-exact).
  const kDecay = Math.max(0, 1 - PLAYER_KNOCK_DECAY * dt)
  p.kx *= kDecay
  p.kz *= kDecay

  // Jump + gravity; a hard landing rebounds a fraction (impact feel).
  if (inp.jump && p.y <= 0.01) p.vy = JUMP_VY
  const prevVy = p.vy
  p.vy -= GRAVITY * dt
  p.y += p.vy * dt
  if (p.y < 0) {
    if (prevVy < -JUMP_VY * 1.15) {
      p.y = 0
      p.vy = -prevVy * LAND_BOUNCE
    } else {
      p.y = 0
      p.vy = 0
    }
  }

  // Dash
  p.dashCd = Math.max(0, p.dashCd - dt)
  if (inp.dash && p.dashCd <= 0 && p.dashT <= 0) {
    const len = Math.hypot(inp.mx, inp.mz)
    if (len > 0) {
      p.dashDirX = inp.mx / len
      p.dashDirZ = inp.mz / len
    } else {
      p.dashDirX = Math.sin(p.ang)
      p.dashDirZ = Math.cos(p.ang)
    }
    p.dashT = DASH_TIME
    p.dashCd = DASH_CD
    p.inv = Math.max(p.inv, DASH_INV)
  }
  p.dashT = Math.max(0, p.dashT - dt)

  const slowed = inSlowBubble(p.x, p.z, p.y, ctx.bubbles)
  p.slowed = slowed

  const want = Math.hypot(inp.mx, inp.mz) > 0
  p.moving = want

  // Steering: accelerate a persistent velocity toward the wish velocity.
  const grounded = p.y <= 0.01
  const rate = grounded ? PLAYER_ACCEL : PLAYER_AIR_ACCEL
  const a = 1 - Math.exp(-rate * dt)
  let tvx = 0
  let tvz = 0
  if (p.dashT > 0) {
    tvx = p.dashDirX * PLAYER_SPEED * DASH_MULT
    tvz = p.dashDirZ * PLAYER_SPEED * DASH_MULT
  } else if (want) {
    const l = Math.hypot(inp.mx, inp.mz)
    const sp = PLAYER_SPEED * (1 + comboSpeed) * (slowed ? 0.5 : 1)
    tvx = (inp.mx / l) * sp
    tvz = (inp.mz / l) * sp
  }
  p.vx += (tvx - p.vx) * a
  p.vz += (tvz - p.vz) * a

  const nx = p.x + (p.vx + p.kx) * dt
  const nz = p.z + (p.vz + p.kz) * dt
  const lim = ctx.arena - 3
  if (!circleHitsObstacle(nx, p.z, PLAYER_RADIUS, ctx.obstacles)) p.x = Math.max(-lim, Math.min(lim, nx))
  if (!circleHitsObstacle(p.x, nz, PLAYER_RADIUS, ctx.obstacles)) p.z = Math.max(-lim, Math.min(lim, nz))

  // Facing
  let wantAng: number | null = null
  if (want) wantAng = Math.atan2(inp.mx, inp.mz)
  if (wantAng !== null) p.ang = lerpAngle(p.ang, wantAng, Math.min(1, dt * 12))
}

function makePlayer(id: number, name: string): PlayerState {
  return {
    id, name, alive: true,
    x: id === 0 ? -4 : 4, z: 0, y: 0, vy: 0, vx: 0, vz: 0, kx: 0, kz: 0,
    ang: id === 0 ? Math.PI / 2 : -Math.PI / 2, facing: 0,
    lives: LIVES_MAX, inv: 0, score: 0, kills: 0,
    combo: 0, comboT: 0, bestCombo: 0, correct: 0, wrong: 0,
    dashT: 0, dashCd: 0, dashDirX: 0, dashDirZ: 1, moving: false,
    lockId: -1, slowed: false,
  }
}

export interface SimOptions {
  seed: string
  playerCount: 1 | 2
  names?: [string, string]
}

/** Picks the enemy mix for a wave. Exported pure for unit testing. */
export function pickKind(wave: number, rng: RNG): EnemyKind {
  const r = rng.next()
  if (wave === 1) return r < 0.35 ? 'RUNNER' : r < 0.60 ? 'FLANKER' : 'GRUNT'
  if (wave === 2) return r < 0.65 ? 'ELITE' : r < 0.85 ? 'FLANKER' : 'RUNNER'
  return r < 0.50 ? 'GRUNT' : r < 0.75 ? 'FLANKER' : 'RUNNER'
}

/** Live enemy cap per wave — ramps with kills like the original game. */
export function enemyCap(wave: number, kills: number): number {
  if (wave === 1) return Math.min(14, 6 + Math.floor(kills / 4))
  if (wave === 2) return Math.min(9, 5 + Math.floor(Math.max(0, kills - 50) / 8))
  return 4
}

export class Sim {
  readonly rng: RNG
  readonly seed: string
  players: PlayerState[]
  enemies: Enemy[] = []
  bullets: Bullet[] = []
  shocks: Shock[] = []
  pickups: Pickup[] = []
  bubbles: Bubble[] = []
  events: SimEvent[] = []
  /** Dynamic combat-physics props (crates, barrels). */
  props: PhysProp[] = []
  /** Airborne mortar shells (boss ballistic barrage). */
  mortars: Mortar[] = []

  time = 0
  runClock = 0
  wave = 1
  kills = 0
  over: 0 | 1 | 2 = 0
  boss: Enemy | null = null
  bossPhase = 0
  private nextEnemyId = 1
  private nextPropId = 1
  private nextBulletId = 0
  readonly bulletIds: number[] = []
  readonly spawnedIds: number[] = []
  readonly curriculum = new CurriculumTracker()
  private readonly lockStartedAt = new Map<number, number>()
  private readonly wordDirty = new Set<number>()

  constructor(opts: SimOptions) {
    this.seed = opts.seed
    this.rng = new RNG(opts.seed)
    const names = opts.names ?? ['PLAYER 1', 'PLAYER 2']
    this.players = [makePlayer(0, opts.playerCount > 1 ? names[0] : names[0])]
    if (opts.playerCount === 2) this.players.push(makePlayer(1, names[1]))
    this.rollBubbles()
    this.rollProps()
    // Initial spawn wave happens on first step.
  }

  /**
   * Deterministic ordnance layout, laid out like a real range: three
   * stockpile clusters (explosive pairs + a water drum + a crate — close
   * enough to chain) plus scattered singles across the mid-field.
   */
  private rollProps(): void {
    this.props = []
    const centers: Array<[number, number]> = []
    const centerOk = (x: number, z: number): boolean =>
      Math.hypot(x, z) > 18 && Math.hypot(x, z) < 44
        && Math.hypot(x + 4, z) > 16 && Math.hypot(x - 4, z) > 16
        && !circleHitsObstacle(x, z, 6, OBSTACLES)
        && centers.every(c => Math.hypot(x - c[0], z - c[1]) > 26)
        && this.bubbles.every(b => Math.hypot(x - b.x, z - b.z) > b.r + 8)
    while (centers.length < 3) {
      const x = this.rng.range(-1, 1) * 40
      const z = this.rng.range(-1, 1) * 40
      if (centerOk(x, z)) centers.push([x, z])
    }
    const add = (kind: 'BARREL' | 'CRATE', expl: boolean, x: number, z: number): void => {
      const r = kind === 'BARREL' ? BARREL_R : CRATE_R
      this.props.push({
        id: this.nextPropId++, kind, expl,
        x, z, y: 0, vx: 0, vz: 0, vy: 0,
        rot: this.rng.next() * Math.PI * 2,
        r, hp: 1, fuse: 0, alive: true, sleepT: 0,
      })
    }
    for (const [cx, cz] of centers) {
      // Explosive pair — close enough to detonate together.
      add('BARREL', true, cx + this.rng.range(-2.2, 2.2), cz + this.rng.range(-2.2, 2.2))
      add('BARREL', true, cx + this.rng.range(-3.4, 3.4), cz + this.rng.range(-3.4, 3.4))
      add('BARREL', false, cx + this.rng.range(4.5, 6.5) * (this.rng.chance(0.5) ? 1 : -1), cz + this.rng.range(-5, 5))
      add('CRATE', false, cx + this.rng.range(4.5, 6.5) * (this.rng.chance(0.5) ? 1 : -1), cz + this.rng.range(-5, 5))
    }
    // Scattered singles across the mid-field.
    const scatter = (kind: 'BARREL' | 'CRATE', expl: boolean): void => {
      const r = kind === 'BARREL' ? BARREL_R : CRATE_R
      let x = 0
      let z = 0
      let tries = 0
      let ok = false
      while (tries++ < 50 && !ok) {
        x = this.rng.range(-1, 1) * 58
        z = this.rng.range(-1, 1) * 58
        ok = Math.hypot(x, z) > 13
          && !circleHitsObstacle(x, z, r + 2, OBSTACLES)
          && this.bubbles.every(b => Math.hypot(x - b.x, z - b.z) > b.r + 3)
          && this.props.every(p => Math.hypot(x - p.x, z - p.z) > 9)
      }
      add(kind, expl, x, z)
    }
    scatter('BARREL', false)
    scatter('BARREL', false)
    scatter('CRATE', false)
    scatter('CRATE', false)
    scatter('CRATE', false)
  }

  private rollBubbles(): void {
    this.bubbles = []
    const n = 2 + this.rng.int(2)
    for (let i = 0; i < n; i++) {
      let x: number
      let z: number
      let tries = 0
      const r = this.rng.range(9, 13)
      do {
        x = this.rng.range(-1, 1) * (ARENA - 18)
        z = this.rng.range(-1, 1) * (ARENA - 18)
        tries++
      } while ((Math.hypot(x, z) < 24 || circleHitsObstacle(x, z, r, OBSTACLES)) && tries < 30)
      this.bubbles.push({ x, z, r })
    }
  }

  /** Threat multiplier — enemies get faster as total kills climb. */
  threat(): number {
    return Math.min(THREAT_MAX, THREAT_BASE + Math.min(1, this.kills / THREAT_KILLS) * THREAT_GAIN)
  }

  comboSpeed(p: PlayerState): number {
    return Math.min(COMBO_SPEED_MAX, p.combo * COMBO_SPEED_PER)
  }

  averageTypingWpm(): number {
    const alive = this.players.filter(p => p.alive)
    if (!alive.length) return 0
    const elapsedMs = this.runClock * 1000
    const values = alive.map(p => wpm(p.correct, elapsedMs))
    return values.reduce((sum, value) => sum + value, 0) / values.length
  }

  /* ------------------------------------------------ typing (combat) ------------------------------------------------ */

  /** Threat-weighted target priority (lower = higher priority). */
  private targetPriorityScore(p: PlayerState, e: Enemy): number {
    const d = Math.hypot(e.x - p.x, e.z - p.z)
    const threatBoost = (e.windup > 0 ? 18 : 0) + (e.kind === 'ELITE' ? 6 : e.kind === 'RUNNER' ? 4 : e.kind === 'FLANKER' ? 3 : 0)
    const progressBoost = e.ti > 0 ? 8 : 0
    // Slightly prioritize enemies approaching from the lower (+Z) side so they don't slip under the HUD.
    const lowerBias = e.z > p.z + 6 ? 4 : 0
    const partnerLocked = this.players.some(o => o.id !== p.id && o.alive && o.lockId === e.id) ? 14 : 0
    return d - threatBoost - progressBoost - lowerBias + partnerLocked
  }

  /** Recommended primary target id for highlighting before the player starts typing. */
  bestTargetId(pid: number): number {
    const p = this.players[pid]
    if (!p || !p.alive || !this.enemies.length) return -1
    if (p.lockId >= 0) {
      const locked = this.enemies.find(e => e.id === p.lockId)
      if (locked) return locked.id
    }
    let best: Enemy | null = null
    let bestScore = Infinity
    for (const e of this.enemies) {
      const s = this.targetPriorityScore(p, e)
      if (s < bestScore) { bestScore = s; best = e }
    }
    return best ? best.id : -1
  }

  typeKey(pid: number, ch: string): KeyResult {
    const p = this.players[pid]
    if (!p || !p.alive || this.over !== 0) return 'none'
    if (!KEYS.includes(ch)) return 'none'

    let target: Enemy | null
    const locked = p.lockId >= 0 ? this.enemies.find(e => e.id === p.lockId) : undefined
    if (p.lockId >= 0 && !locked) p.lockId = -1 // clear stale lock immediately
    if (locked) {
      target = locked.seq[locked.ti] === ch ? locked : null
      if (!target) {
        // Miss on a locked target: record for review, reset sequence, break combo.
        this.wordDirty.add(locked.id)
        this.curriculum.recordResult(locked.seq, false)
        locked.ti = 0
        p.lockId = -1
        this.miss(p)
        return 'miss'
      }
    } else {
      // No lock: pick the highest-priority valid enemy whose next letter matches.
      let best: Enemy | null = null
      let bestScore = Infinity
      for (const e of this.enemies) {
        if (e.seq[e.ti] === ch) {
          const s = this.targetPriorityScore(p, e)
          if (s < bestScore) { bestScore = s; best = e }
        }
      }
      target = best
      if (!target) { this.miss(p); return 'miss' }
      this.lockStartedAt.set(pid, this.time)
    }

    p.lockId = target.id
    p.correct++
    p.combo++
    p.comboT = COMBO_WINDOW
    p.bestCombo = Math.max(p.bestCombo, p.combo)
    target.ti++
    // Every landed letter is a hit: stagger the target back a step (GRUNT heavy resists knockback).
    if (target.y <= 0.01) {
      const dx = target.x - p.x
      const dz = target.z - p.z
      const d = Math.hypot(dx, dz) || 1
      const poise = target.kind === 'GRUNT' ? 0.45 : target.kind === 'RUNNER' ? 1.2 : 1
      target.kx += (dx / d) * 2.4 * poise
      target.kz += (dz / d) * 2.4 * poise
      target.stag = Math.max(target.stag, 0.08 * poise)
    }
    if (target.ti >= target.seq.length) {
      const startT = this.lockStartedAt.get(pid) ?? this.time
      const durationMs = Math.max(100, (this.time - startT) * 1000)
      const clean = !this.wordDirty.has(target.id)
      this.wordDirty.delete(target.id)
      this.curriculum.recordResult(target.seq, clean, durationMs)
      const speedKill = clean && this.time > 0.25 && durationMs < target.seq.length * 230
      p.lockId = -1
      this.completeSequence(p, target, speedKill)
      if (speedKill && p.combo >= 5) {
        p.combo++
        p.bestCombo = Math.max(p.bestCombo, p.combo)
      }
      return 'complete'
    }
    return 'advance'
  }

  private miss(p: PlayerState): void {
    p.wrong++
    p.combo = 0
    p.comboT = 0
  }

  private completeSequence(p: PlayerState, e: Enemy, speedKill = false): void {
    if (e.kind === 'BOSS' && --e.hp > 0) {
      // Boss survives: new sequence, maybe a phase change.
      const oldPhase = this.bossPhase
      this.bossPhase = e.hp >= 7 ? 1 : e.hp >= 4 ? 2 : 3
      e.seq = this.mkSeq('BOSS')
      e.ti = 0
      this.events.push({ t: 'boss', hp: e.hp, max: e.maxhp })
      this.events.push({ t: 'seq', id: e.id, seq: e.seq, kind: e.kind })
      if (this.bossPhase !== oldPhase) this.events.push({ t: 'bossphase', phase: this.bossPhase })
      return
    }
    this.killEnemy(e, p, speedKill)
  }

  private killEnemy(e: Enemy, by: PlayerState | null, speedKill = false): void {
    const i = this.enemies.indexOf(e)
    if (i < 0) return
    this.enemies.splice(i, 1)
    this.wordDirty.delete(e.id)
    for (const p of this.players) if (p.lockId === e.id) p.lockId = -1
    this.kills++
    // Ragdoll launch: away from the shooter, spun by the impact.
    const dx = by ? e.x - by.x : this.rng.range(-1, 1)
    const dz = by ? e.z - by.z : this.rng.range(-1, 1)
    const dl = Math.hypot(dx, dz) || 1
    const spin = (4 + this.rng.next() * 5) * (this.rng.chance(0.5) ? -1 : 1)
    const lift = 10 + this.rng.next() * 6 + (e.y > 0 ? e.vy * 0.4 : 0)
    if (by) {
      by.kills++
      by.score += Math.round(KINDS[e.kind].value * (1 + Math.min(by.combo, COMBO_SCORE_CAP) * COMBO_SCORE_PER))
    }
    this.events.push({
      t: 'kill', id: e.id, x: e.x, z: e.z, kind: e.kind, by: by ? by.id : -1,
      combo: by ? by.combo : 0, milestone: this.kills % 10 === 0, speedKill,
      dx: Math.round((dx / dl) * 100) / 100, dz: Math.round((dz / dl) * 100) / 100,
      spin: Math.round(spin * 10) / 10, vy: Math.round(lift * 10) / 10,
    })
    // Kills near explosive ordnance damage it → delayed chain detonation.
    for (const p of this.props) {
      if (!p.alive || !p.expl || p.fuse > 0) continue
      if (Math.hypot(p.x - e.x, p.z - e.z) < KILL_FUSE_RADIUS) {
        p.hp--
        if (p.hp <= 0) p.fuse = CHAIN_DELAY_MIN + this.rng.next() * CHAIN_DELAY_RAND
      }
    }
    if (e.kind !== 'BOSS' && this.rng.chance(0.15)) {
      this.pickups.push({ x: e.x, z: e.z, life: PICKUP_LIFE })
    }
    if (e.kind === 'BOSS') {
      this.boss = null
      this.finish(true)
    }
    const w = this.kills < WAVE2_KILLS ? 1 : this.kills < WAVE3_KILLS ? 2 : 3
    if (w !== this.wave) this.startWave(w)
  }

  /* ------------------------------------------------ combat physics: blasts, chains, mortars ------------------------------------------------ */

  /**
   * Radial blast: kills non-boss enemies (credited to `by`), launches and
   * staggers the rest, hurts + launches players, applies impulses to every
   * dynamic prop, and lights the fuse on explosive barrels in range — chain
   * reactions resolve over the following ticks (never recursively).
   */
  private applyBlast(
    cx: number, cz: number, radius: number, killRadius: number, power: number, launch: number,
    by: PlayerState | null,
  ): void {
    this.events.push({ t: 'blast', x: Math.round(cx * 10) / 10, z: Math.round(cz * 10) / 10, r: radius })

    // Enemies: gather first, then kill (no mutation during iteration).
    const victims: Enemy[] = []
    for (const e of this.enemies) {
      const imp = blastImpulse(e.x, e.z, cx, cz, radius, power, launch)
      if (!imp || e.kind === 'BOSS') continue
      const poise = e.kind === 'GRUNT' ? 0.55 : e.kind === 'RUNNER' ? 1.15 : 1
      e.kx += imp.ix * 0.55 * poise
      e.kz += imp.iz * 0.55 * poise
      e.vy = Math.max(e.vy, imp.lift * poise)
      e.y = Math.max(e.y, 0.01)
      e.stag = Math.max(e.stag, 0.45 * poise)
      if (Math.hypot(e.x - cx, e.z - cz) < killRadius) victims.push(e)
    }
    for (const e of victims) this.killEnemy(e, by)

    // Players: hurt (unless invulnerable) + physical launch.
    for (const p of this.players) {
      if (!p.alive) continue
      const imp = blastImpulse(p.x, p.z, cx, cz, radius, power, launch)
      if (!imp) continue
      p.kx += imp.ix * 0.6
      p.kz += imp.iz * 0.6
      p.vy = Math.max(p.vy, imp.lift)
      if (imp.falloff > 0.25 && p.inv <= 0) this.hurtPlayer(p)
    }

    // Props: impulses + fuses for chained ordnance.
    for (const p of this.props) {
      if (!p.alive) continue
      const imp = blastImpulse(p.x, p.z, cx, cz, radius, power * 1.15, launch * 1.1)
      if (!imp) continue
      wakeProp(p)
      p.vx += imp.ix / PROP_MASS[p.kind]
      p.vz += imp.iz / PROP_MASS[p.kind]
      p.vy = Math.max(p.vy, imp.lift / PROP_MASS[p.kind] * 0.5)
      if (p.expl && p.fuse <= 0 && imp.falloff > 0.2) {
        p.hp--
        if (p.hp <= 0) p.fuse = CHAIN_DELAY_MIN + this.rng.next() * CHAIN_DELAY_RAND
      }
    }
  }

  /** A barrel's fuse ran out: remove it and let the blast do the talking. */
  private detonate(id: number): void {
    const p = this.props.find(q => q.id === id)
    if (!p || !p.alive) return
    p.alive = false
    this.applyBlast(p.x, p.z, BLAST_RADIUS, BLAST_KILL_RADIUS, BLAST_POWER, BLAST_LAUNCH, null)
  }

  /** Ballistic mortar barrage (boss phase 2+): lead the target, arc over cover. */
  private fireMortar(from: Enemy, leadPlayer: PlayerState): void {
    const flightT = (2 * MORTAR_VY) / GRAVITY
    const tx = leadPlayer.x + leadPlayer.vx * flightT * 0.6
    const tz = leadPlayer.z + leadPlayer.vz * flightT * 0.6
    const m: Mortar = {
      x: from.x, z: from.z, y: 4,
      vx: (tx - from.x) / flightT,
      vz: (tz - from.z) / flightT,
      vy: MORTAR_VY,
    }
    this.mortars.push(m)
    this.events.push({
      t: 'mortar',
      x: Math.round(m.x * 10) / 10, z: Math.round(m.z * 10) / 10,
      vx: Math.round(m.vx * 100) / 100, vz: Math.round(m.vz * 100) / 100, vy: m.vy,
    })
  }

  private finish(win: boolean): void {
    if (this.over !== 0) return
    this.over = win ? 1 : 2
    this.events.push({ t: 'over', win, score: this.players.reduce((s, p) => s + p.score, 0), kills: this.kills })
  }

  /* ------------------------------------------------ waves & spawning ------------------------------------------------ */

  private mkSeq(kind: EnemyKind): string {
    const active = new Set(this.enemies.map(e => e.seq))
    return this.curriculum.pickWord(kind, this.wave, this.kills, active, this.rng)
  }

  private startWave(w: number): void {
    this.wave = w
    this.events.push({ t: 'wave', w })
    if (w === 3) {
      // Clear the field, summon the Overlord.
      for (const e of [...this.enemies]) {
        this.enemies.splice(this.enemies.indexOf(e), 1)
        for (const p of this.players) if (p.lockId === e.id) p.lockId = -1
      }
      const b = this.spawnEnemy('BOSS', 0, -20)
      this.boss = b
      this.bossPhase = 1
      this.events.push({ t: 'boss', hp: b.hp, max: b.maxhp })
      this.events.push({ t: 'seq', id: b.id, seq: b.seq, kind: b.kind })
    }
  }

  private spawnEnemy(kind: EnemyKind, cx: number, cz: number): Enemy {
    let x: number
    let z: number
    if (kind === 'BOSS') {
      x = cx
      z = cz
    } else {
      const er = KINDS[kind].radius
      let tries = 0
      do {
        const a = this.rng.next() * Math.PI * 2
        const r = 48 + this.rng.next() * 28
        x = Math.max(-ARENA + 5, Math.min(ARENA - 5, cx + Math.cos(a) * r))
        z = Math.max(-ARENA + 5, Math.min(ARENA - 5, cz + Math.sin(a) * r))
        tries++
      } while (
        tries < 20 &&
        (this.players.some(p => p.alive && Math.hypot(p.x - x, p.z - z) < 34) ||
          circleHitsObstacle(x, z, er + 1.5, OBSTACLES) ||
          this.props.some(p => p.alive && Math.hypot(p.x - x, p.z - z) < er + p.r + 1.5) ||
          this.enemies.some(o => Math.hypot(o.x - x, o.z - z) < (er + KINDS[o.kind].radius) * 1.6))
      )
    }
    const e: Enemy = {
      id: this.nextEnemyId++,
      kind, x, z,
      vx: 0, vz: 0,
      ang: Math.atan2(cx - x, cz - z),
      flankSign: this.rng.next() < 0.5 ? -1 : 1,
      flankTimer: 2.5 + this.rng.next() * 2.5,
      windup: 0,
      recover: 0,
      y: 0, vy: 0, kx: 0, kz: 0, stag: 0,
      seq: this.mkSeq(kind),
      ti: 0,
      hp: kind === 'BOSS' ? 10 : 1,
      maxhp: kind === 'BOSS' ? 10 : 1,
      shootCd: 2 + this.rng.next() * 3,
      patternCd: 4,
      volleyLeft: 0, volleyT: 0, addCd: 8, mortarCd: 3.5,
    }
    this.enemies.push(e)
    this.spawnedIds.push(e.id)
    this.events.push({ t: 'seq', id: e.id, seq: e.seq, kind: e.kind })
    return e
  }

  private aliveCenter(): { x: number; z: number } {
    const alive = this.players.filter(p => p.alive)
    if (!alive.length) return { x: 0, z: 0 }
    return {
      x: alive.reduce((s, p) => s + p.x, 0) / alive.length,
      z: alive.reduce((s, p) => s + p.z, 0) / alive.length,
    }
  }

  private spawnToCap(): void {
    // Wave 3 is the boss fight: adds come only from the boss's phase-3 pattern.
    if (this.wave >= 3) return
    const cap = enemyCap(this.wave, this.kills)
    const alive = this.aliveCenter()
    while (this.enemies.length < cap) {
      this.spawnEnemy(pickKind(this.wave, this.rng), alive.x, alive.z)
    }
  }

  /* ------------------------------------------------ boss patterns ------------------------------------------------ */

  private fireBullet(x: number, z: number, dx: number, dz: number, speed: number): void {
    this.bullets.push({ x, z, dx, dz, speed, life: BULLET_LIFE })
    this.nextBulletId++
  }

  private bossPatterns(b: Enemy, dt: number): void {
    // Mortar barrage — phase 2+: lead the target, arc over cover.
    if (this.bossPhase >= 2) {
      b.mortarCd -= dt
      if (b.mortarCd <= 0) {
        b.mortarCd = MORTAR_CD
        const tgt = this.nearestAlivePlayer(b.x, b.z)
        if (tgt) {
          this.fireMortar(b, tgt)
          if (this.bossPhase >= 3) this.fireMortar(b, tgt)
        }
      }
    }
    // Shockwaves — every phase.
    b.patternCd -= dt
    if (b.patternCd <= 0) {
      b.patternCd = Math.max(2.8, 5 - (1 - b.hp / b.maxhp) * 2)
      this.shocks.push({ x: b.x, z: b.z, r: 2 })
      this.events.push({ t: 'shock', x: b.x, z: b.z })
    }
    // Phase 2+: radial bullet rings after each shockwave.
    if (this.bossPhase >= 2) {
      b.volleyT -= dt
      if (b.volleyT <= 0 && b.volleyLeft === 0) {
        b.volleyT = 3.4
        const n = 12
        const off = this.rng.next() * Math.PI
        for (let i = 0; i < n; i++) {
          const a = off + (i / n) * Math.PI * 2
          this.fireBullet(b.x, b.z, Math.sin(a), Math.cos(a), 24)
        }
        this.events.push({ t: 'shot', x: b.x, z: b.z, kind: b.kind })
      }
    }
    // Phase 3: aimed triple volleys at the nearest player + grunt reinforcements.
    if (this.bossPhase >= 3) {
      b.addCd -= dt
      if (b.addCd <= 0 && this.enemies.length < 5) {
        b.addCd = 9
        const alive = this.aliveCenter()
        this.spawnEnemy('GRUNT', alive.x, alive.z)
        this.spawnEnemy('GRUNT', alive.x, alive.z)
      }
      b.shootCd -= dt
      if (b.shootCd <= 0) {
        b.shootCd = 3.2
        b.volleyLeft = 3
        b.volleyT = 0
      }
      if (b.volleyLeft > 0) {
        b.volleyT -= dt
        if (b.volleyT <= 0) {
          b.volleyT = 0.16
          b.volleyLeft--
          const tgt = this.nearestAlivePlayer(b.x, b.z)
          if (tgt) {
            const dx = tgt.x - b.x
            const dz = tgt.z - b.z
            const d = Math.hypot(dx, dz) || 1
            this.fireBullet(b.x, b.z, dx / d, dz / d, 38)
            this.events.push({ t: 'shot', x: b.x, z: b.z, kind: b.kind })
          }
        }
      }
    }
  }

  private nearestAlivePlayer(x: number, z: number): PlayerState | null {
    let best: PlayerState | null = null
    let bd = Infinity
    for (const p of this.players) {
      if (!p.alive) continue
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < bd) { bd = d; best = p }
    }
    return best
  }

  /* ------------------------------------------------ main step ------------------------------------------------ */

  step(dt: number, inputs: InputState[]): void {
    if (this.over !== 0) return
    this.time += dt
    this.runClock += dt

    // 1. Players: typed keys first (snappy), then movement.
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i]
      const rawInput = inputs[i] ?? emptyInput()
      // Touch-typing anchor: directional movement cannot compete with ten-finger combat.
      // Jump and sprint remain, but arrow/WASD steering is intentionally disabled.
      const inp = { ...rawInput, mx: 0, mz: 0 }
      if (!p.alive) continue
      if (inp.key) this.typeKey(p.id, inp.key)
      p.inv = Math.max(0, p.inv - dt)
      if (p.comboT > 0) {
        p.comboT -= dt
        if (p.comboT <= 0 && p.combo > 0) p.combo = 0
      }
      movePlayerBody(p, inp, dt, MOVE_CTX, this.comboSpeed(p))
      // Player ⇄ prop contact: separate the player, shove the prop (crates
      // are light and slide; barrels are heavy and barely budge).
      for (const q of this.props) {
        if (!q.alive) continue
        const dx = p.x - q.x
        const dz = p.z - q.z
        const min = q.r + PLAYER_RADIUS
        const d2 = dx * dx + dz * dz
        if (d2 >= min * min || d2 < 1e-6) continue
        const d = Math.sqrt(d2)
        const nx = dx / d
        const nz = dz / d
        if (p.y < 3) {
          p.x = q.x + nx * min
          p.z = q.z + nz * min
        }
        wakeProp(q)
        const push = PLAYER_PUSH_FORCE / PROP_MASS[q.kind]
        q.vx -= nx * push * dt * 8
        q.vz -= nz * push * dt * 8
        q.vx -= p.vx * 0.55 * dt * 6 / PROP_MASS[q.kind]
        q.vz -= p.vz * 0.55 * dt * 6 / PROP_MASS[q.kind]
      }
    }

    const sm = this.threat() * adaptiveEnemySpeedScale(this.averageTypingWpm())

    // 2. Enemies: physics state (knockback, airborne, stagger), then seek & attack.
    for (const e of this.enemies) {
      const def = KINDS[e.kind]
      // Knockback decays; stagger blocks seeking & firing.
      const kDecay = Math.max(0, 1 - 6 * dt)
      e.kx *= kDecay
      e.kz *= kDecay
      e.stag = Math.max(0, e.stag - dt)
      if (e.kx !== 0 || e.kz !== 0) {
        e.x = Math.max(-ARENA + 4, Math.min(ARENA - 4, e.x + e.kx * dt))
        e.z = Math.max(-ARENA + 4, Math.min(ARENA - 4, e.z + e.kz * dt))
        pushOutOfObstacles(e, def.radius * 0.6, OBSTACLES)
      }
      // Airborne (launched): ballistic arc with a landing bounce.
      if (e.y > 0 || e.vy > 0) {
        e.vy -= GRAVITY * dt
        e.y += e.vy * dt
        if (e.y <= 0) {
          e.y = 0
          e.vy = e.vy < -12 ? -e.vy * 0.3 : 0
        }
      }
      const tgt = this.nearestAlivePlayer(e.x, e.z)
      if (!tgt) continue
      const dx = tgt.x - e.x
      const dz = tgt.z - e.z
      const dist = Math.hypot(dx, dz) || 1
      const nx = dx / dist
      const nz = dz / dist
      const grounded = e.y <= 0.01

      // Dynamic flank re-evaluation timer (prevents locking onto one stale angle).
      e.flankTimer -= dt
      if (e.flankTimer <= 0) {
        e.flankTimer = e.kind === 'FLANKER' ? 2.4 + this.rng.next() * 2.0 : 3.5 + this.rng.next() * 2.5
        if (e.kind === 'FLANKER' || this.rng.chance(0.35)) e.flankSign = -e.flankSign
      }
      e.recover = Math.max(0, e.recover - dt)

      const go = !(def.boss && dist < 24) && grounded && e.stag <= 0

      // Desired velocity by archetype.
      let desVx = 0
      let desVz = 0
      if (go) {
        let sp = def.speed * sm
        if (e.windup > 0) sp *= 0.22
        else if (e.recover > 0) sp *= 0.4

        // Prevent enemies from relentlessly shoving into an invulnerable player.
        const keepOut = tgt.inv > 0 && dist < PLAYER_RADIUS + def.radius + 2.4

        if (e.kind === 'ELITE') {
          // Tactical range-keeper: approach to ~28 units, then strafe.
          const radial = keepOut ? -0.4 : dist > 34 ? 1 : dist < 22 ? -0.55 : 0.1
          const strafe = (dist < 40 ? 0.8 : 0.25) * e.flankSign
          desVx = (nx * radial - nz * strafe) * sp
          desVz = (nz * radial + nx * strafe) * sp
        } else if (e.kind === 'FLANKER') {
          // Wide curved flank arc that tightens as it closes in.
          const radial = keepOut ? -0.2 : 1
          const arc = dist > 26 ? 0.85 : dist > 12 ? 0.55 : 0.2
          desVx = (nx * radial - nz * arc * e.flankSign) * sp
          desVz = (nz * radial + nx * arc * e.flankSign) * sp
        } else if (e.kind === 'RUNNER') {
          // Aggressive fast approach with agile weave at mid-range.
          const radial = keepOut ? -0.2 : 1
          const weave = dist > 10 && dist < 44 ? Math.sin(this.time * 3.5 + e.id * 1.7) * 0.35 * e.flankSign : 0
          desVx = (nx * radial - nz * weave) * sp
          desVz = (nz * radial + nx * weave) * sp
        } else {
          // GRUNT (heavy) & BOSS: steady, purposeful advance.
          const radial = keepOut ? 0 : 1
          const flank = !def.boss && dist > 16 ? 0.14 * e.flankSign : 0
          desVx = (nx * radial - nz * flank) * sp
          desVz = (nz * radial + nx * flank) * sp
        }

        // Separation + blocker sidestepping so packs spread around the player.
        const desLen = Math.hypot(desVx, desVz) || 1
        const dirX = desVx / desLen
        const dirZ = desVz / desLen
        for (const other of this.enemies) {
          if (other.id === e.id) continue
          const sx = e.x - other.x
          const sz = e.z - other.z
          const minSep = (def.radius + KINDS[other.kind].radius) * 1.65
          const d2 = sx * sx + sz * sz
          if (d2 > 1e-4 && d2 < minSep * minSep) {
            const sd = Math.sqrt(d2)
            const push = ((minSep - sd) / minSep) * sp * 1.45
            desVx += (sx / sd) * push
            desVz += (sz / sd) * push
          } else if (d2 >= minSep * minSep && d2 < 100) {
            // If an ally is directly blocking our forward path, sidestep smoothly.
            const sd = Math.sqrt(d2)
            const toOtherX = -sx / sd
            const toOtherZ = -sz / sd
            const forwardDot = toOtherX * dirX + toOtherZ * dirZ
            if (forwardDot > 0.65) {
              const side = (1 - sd / 10) * sp * 0.85 * e.flankSign
              desVx += -dirZ * side
              desVz += dirX * side
            }
          }
        }

        // Obstacle avoidance: proximity push + forward-probe corner bypass (no wall-sticking).
        const look = def.radius + 5.0
        const probeDist = def.radius + 8.5
        const curLen = Math.hypot(desVx, desVz) || 1
        const fwdX = desVx / curLen
        const fwdZ = desVz / curLen
        const probeX = e.x + fwdX * probeDist
        const probeZ = e.z + fwdZ * probeDist
        for (const o of OBSTACLES) {
          const cx = Math.max(o.x - o.hw, Math.min(o.x + o.hw, e.x))
          const cz = Math.max(o.z - o.hd, Math.min(o.z + o.hd, e.z))
          const ox = e.x - cx
          const oz = e.z - cz
          const od2 = ox * ox + oz * oz
          if (od2 > 1e-4 && od2 < look * look) {
            const od = Math.sqrt(od2)
            const awayX = ox / od
            const awayZ = oz / od
            const strength = ((look - od) / look) * sp * 1.75
            // Pick consistent bypass tangent around the AABB edge.
            const tx = -awayZ * e.flankSign
            const tz = awayX * e.flankSign
            desVx += (awayX + tx * 0.85) * strength
            desVz += (awayZ + tz * 0.85) * strength
          } else if (
            probeX > o.x - o.hw - def.radius && probeX < o.x + o.hw + def.radius &&
            probeZ > o.z - o.hd - def.radius && probeZ < o.z + o.hd + def.radius
          ) {
            // Forward ray sees an obstacle ahead: steer toward the closer corner edge.
            const leftClear = Math.abs(e.x - (o.x - o.hw))
            const rightClear = Math.abs((o.x + o.hw) - e.x)
            const topClear = Math.abs(e.z - (o.z - o.hd))
            const botClear = Math.abs((o.z + o.hd) - e.z)
            if (Math.abs(fwdZ) > Math.abs(fwdX)) {
              const goLeft = leftClear + (e.flankSign < 0 ? -2 : 2) < rightClear
              desVx += (goLeft ? -1 : 1) * sp * 1.15
            } else {
              const goUp = topClear + (e.flankSign < 0 ? -2 : 2) < botClear
              desVz += (goUp ? -1 : 1) * sp * 1.15
            }
          }
        }
      }

      // Smooth acceleration / deceleration.
      const accel = e.kind === 'RUNNER' ? 15 : e.kind === 'FLANKER' ? 13 : e.kind === 'GRUNT' ? 7.5 : 10
      const kVel = Math.min(1, accel * dt)
      e.vx += (desVx - e.vx) * kVel
      e.vz += (desVz - e.vz) * kVel

      if (Math.abs(e.vx) > 0.01 || Math.abs(e.vz) > 0.01) {
        e.x += e.vx * dt
        e.z += e.vz * dt
        pushOutOfObstacles(e, def.radius * 0.6, OBSTACLES)
        e.x = Math.max(-ARENA + 4, Math.min(ARENA - 4, e.x))
        e.z = Math.max(-ARENA + 4, Math.min(ARENA - 4, e.z))
      }

      // Smooth turning toward movement direction (or target when ELITE aims/winds up or FLANKER nears).
      const aimAtTarget = (e.kind === 'ELITE' && (dist < 44 || e.windup > 0)) || (e.kind === 'FLANKER' && dist < 16)
      const targetAng = aimAtTarget ? Math.atan2(dx, dz) : Math.hypot(e.vx, e.vz) > 0.8 ? Math.atan2(e.vx, e.vz) : Math.atan2(dx, dz)
      let diff = targetAng - e.ang
      while (diff > Math.PI) diff -= Math.PI * 2
      while (diff < -Math.PI) diff += Math.PI * 2
      const turnRate = e.kind === 'RUNNER' ? 13 : e.kind === 'FLANKER' ? 11 : e.kind === 'BOSS' ? 4 : 8
      e.ang += diff * Math.min(1, turnRate * dt)

      // Enemies path around (and shove) dynamic props.
      for (const q of this.props) {
        if (!q.alive) continue
        const ex = e.x - q.x
        const ez = e.z - q.z
        const min = q.r + def.radius * 0.6
        const d2 = ex * ex + ez * ez
        if (d2 >= min * min || d2 < 1e-6 || !grounded) continue
        const d = Math.sqrt(d2)
        const pnx = ex / d
        const pnz = ez / d
        e.x = q.x + pnx * min
        e.z = q.z + pnz * min
        wakeProp(q)
        q.vx -= pnx * def.speed * 0.3 * dt * 4 / PROP_MASS[q.kind]
        q.vz -= pnz * def.speed * 0.3 * dt * 4 / PROP_MASS[q.kind]
      }
      // Elite aimed shots with readable windup telegraph + recovery cooldown.
      if (def.shoot && e.stag <= 0 && grounded) {
        if (e.windup > 0) {
          e.windup -= dt
          if (e.windup <= 0) {
            e.windup = 0
            e.recover = 0.35
            e.shootCd = 3.2 + this.rng.next() * 2.2
            this.fireBullet(e.x + nx * 3, e.z + nz * 3, nx, nz, 34)
            this.events.push({ t: 'shot', id: e.id, x: e.x, z: e.z, kind: e.kind })
          }
        } else {
          e.shootCd -= dt
          if (dist < 62 && e.shootCd <= 0 && e.recover <= 0) {
            e.windup = 0.55
            this.events.push({ t: 'windup', id: e.id, x: e.x, z: e.z, kind: e.kind })
          }
        }
      } else if (e.windup > 0) {
        // Stagger or launch interrupts the attack windup!
        e.windup = 0
      }
      if (def.boss) this.bossPatterns(e, dt)
      // Contact damage (only while grounded).
      if (dist < PLAYER_RADIUS + def.radius && tgt.inv <= 0 && grounded) {
        this.hurtPlayer(tgt)
        if (!def.boss) {
          const i = this.enemies.indexOf(e)
          if (i >= 0) this.enemies.splice(i, 1)
          for (const p of this.players) if (p.lockId === e.id) p.lockId = -1
        }
      }
    }

    // 2b. Enemy separation (soft push so they don't stack into one column, clamped out of obstacles).
    for (let i = 0; i < this.enemies.length; i++) {
      const a = this.enemies[i]!
      const ra = KINDS[a.kind].radius
      for (let j = i + 1; j < this.enemies.length; j++) {
        const b = this.enemies[j]!
        const rb = KINDS[b.kind].radius
        const min = ra + rb
        const dx = b.x - a.x
        const dz = b.z - a.z
        const d2 = dx * dx + dz * dz
        if (d2 > 0.01 && d2 < min * min) {
          const d = Math.sqrt(d2)
          const push = ((min - d) / d) * 0.5
          a.x -= dx * push; a.z -= dz * push
          b.x += dx * push; b.z += dz * push
        }
      }
      pushOutOfObstacles(a, ra * 0.6, OBSTACLES)
    }

    // 3. Bullets — vs players, walls AND dynamic props (cover + ordnance).
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      const b = this.bullets[i]!
      b.x += b.dx * b.speed * dt
      b.z += b.dz * b.speed * dt
      b.life -= dt
      let dead = b.life <= 0 || Math.abs(b.x) > ARENA || Math.abs(b.z) > ARENA || circleHitsObstacle(b.x, b.z, 0.4, OBSTACLES)
      if (!dead) {
        for (const q of this.props) {
          if (!q.alive) continue
          if (Math.hypot(b.x - q.x, b.z - q.z) < q.r + 0.5) {
            dead = true
            if (q.expl && q.fuse <= 0) {
              q.hp--
              if (q.hp <= 0) q.fuse = 0.1 // stray fire cooks off the ordnance
            }
            break
          }
        }
      }
      if (!dead) {
        for (const p of this.players) {
          if (!p.alive || p.inv > 0) continue
          if (Math.hypot(b.x - p.x, b.z - p.z) < PLAYER_RADIUS + 0.5 && p.y <= 2) {
            this.hurtPlayer(p)
            dead = true
            break
          }
        }
      }
      if (dead) this.bullets.splice(i, 1)
    }

    // 3b. Mortar shells: parabolic integration, impact = blast.
    for (let i = this.mortars.length - 1; i >= 0; i--) {
      const m = this.mortars[i]!
      m.vy -= GRAVITY * dt
      m.x += m.vx * dt
      m.z += m.vz * dt
      m.y += m.vy * dt
      if (m.y <= 0 || circleHitsObstacle(m.x, m.z, 0.5, OBSTACLES)) {
        this.mortars.splice(i, 1)
        this.applyBlast(m.x, m.z, MORTAR_RADIUS, MORTAR_KILL_RADIUS, MORTAR_POWER, MORTAR_LAUNCH, null)
      }
    }

    // 3c. Dynamic props: integrate; expired fuses detonate (deferred chains).
    for (const id of stepProps(this.props, dt, OBSTACLES, ARENA)) this.detonate(id)

    // 4. Shockwaves (jump to dodge: they only hit below y 1.6).
    for (let i = this.shocks.length - 1; i >= 0; i--) {
      const s = this.shocks[i]!
      s.r += 26 * dt
      let hit = false
      for (const p of this.players) {
        if (!p.alive || p.inv > 0 || p.y >= 1.6) continue
        if (Math.abs(Math.hypot(p.x - s.x, p.z - s.z) - s.r) < s.r * 0.03 + 1.6) {
          this.hurtPlayer(p)
          hit = true
          break
        }
      }
      if (hit || s.r > 150) this.shocks.splice(i, 1)
    }

    // 5. Pickups.
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i]!
      pk.life -= dt
      let taken = false
      for (const p of this.players) {
        if (!p.alive || p.lives >= LIVES_MAX) continue
        if (Math.hypot(pk.x - p.x, pk.z - p.z) < PLAYER_RADIUS + 1.8 && p.y < 3.5) {
          p.lives++
          this.events.push({ t: 'pickup', p: p.id, x: pk.x, z: pk.z })
          taken = true
          break
        }
      }
      if (taken || pk.life <= 0) this.pickups.splice(i, 1)
    }

    // 6. Spawning.
    this.spawnToCap()

    // 7. Lose condition.
    if (this.players.every(p => !p.alive)) this.finish(false)
  }

  private hurtPlayer(p: PlayerState): void {
    p.lives--
    p.inv = INV_TIME
    p.combo = 0
    p.comboT = 0
    this.events.push({ t: 'hurt', p: p.id, x: p.x, z: p.z })
    if (p.lives <= 0) {
      p.alive = false
      this.events.push({ t: 'death', p: p.id, x: p.x, z: p.z })
    }
  }

  /* ------------------------------------------------ snapshots & hashing ------------------------------------------------ */

  snapshot(): Snapshot {
    const ps = this.players.map(p => [
      Math.round(p.x * 100) / 100, Math.round(p.z * 100) / 100, Math.round(p.y * 100) / 100,
      Math.round(p.ang * 1000) / 1000, p.lives, Math.round(p.inv * 100) / 100,
      p.score, p.combo, p.alive ? 1 : 0,
      p.correct, p.wrong, p.bestCombo, p.kills,
    ] as Snapshot['ps'][number])
    const kindIdx = (k: EnemyKind) => {
      const idx = ENEMY_KIND_ORDER.indexOf(k)
      return idx >= 0 ? idx : 1
    }
    const es = this.enemies.map(e => [
      e.id, kindIdx(e.kind), Math.round(e.x * 100) / 100, Math.round(e.z * 100) / 100,
      e.ti, e.hp, e.maxhp, Math.round(e.y * 10) / 10,
    ] as Snapshot['es'][number])
    const pr = this.props.filter(p => p.alive).map(p => [
      p.id,
      p.kind === 'CRATE' ? 0 : p.expl ? 2 : 1,
      Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10,
      Math.round(p.y * 10) / 10, Math.round(p.rot * 100) / 100,
    ] as NonNullable<Snapshot['pr']>[number])
    return {
      v: 1, t: this.time, tm: Math.round(this.runClock * 100) / 100,
      w: this.wave, k: this.kills, ov: this.over,
      ps, es, pr,
      bs: this.bullets.map(b => [
        Math.round(b.x * 100) / 100, Math.round(b.z * 100) / 100,
        Math.round(b.dx * 1000) / 1000, Math.round(b.dz * 1000) / 1000,
      ] as Snapshot['bs'][number]),
      ss: this.shocks.map(s => [Math.round(s.x * 10) / 10, Math.round(s.z * 10) / 10, Math.round(s.r * 10) / 10] as Snapshot['ss'][number]),
      pk: this.pickups.map(p => [Math.round(p.x * 10) / 10, Math.round(p.z * 10) / 10] as Snapshot['pk'][number]),
      bub: this.bubbles.map(b => [Math.round(b.x), Math.round(b.z), Math.round(b.r)] as Snapshot['bub'][number]),
      bh: this.boss ? this.boss.hp : 0,
      bmx: this.boss ? this.boss.maxhp : 0,
    }
  }

  /** Folds state into a hash — used by determinism unit tests. */
  hash(): string {
    let h = 2166136261
    const mix = (n: number) => {
      h ^= Math.imul(n | 0, 16777619)
      h = Math.imul(h ^ (h >>> 13), 0x5bd1e995)
    }
    mix(this.kills); mix(this.wave); mix(this.enemies.length)
    for (const p of this.players) { mix(p.x * 64); mix(p.z * 64); mix(p.score); mix(p.lives) }
    for (const e of this.enemies) { mix(e.id); mix(e.x * 64); mix(e.z * 64); mix(e.ti) }
    for (const b of this.bullets) { mix(b.x * 64); mix(b.z * 64) }
    for (const q of this.props) { if (q.alive) { mix(q.id); mix(q.x * 64); mix(q.z * 64); mix(q.rot * 64) } }
    for (const m of this.mortars) { mix(m.x * 64); mix(m.z * 64) }
    return (h >>> 0).toString(16)
  }

  /* ------------------------------------------------ test hooks (used by unit tests only) ------------------------------------------------ */

  /** Directly kill N enemies without touching the field (drives wave transitions). */
  debugAddKills(n: number, by = 0): void {
    this.kills += n
    this.players[by]!.kills += n
    this.players[by]!.score += n * 100
    const w = this.kills < WAVE2_KILLS ? 1 : this.kills < WAVE3_KILLS ? 2 : 3
    if (w !== this.wave) this.startWave(w)
  }

  /** Type a key aimed at a specific enemy id, bypassing nearest-match search. */
  debugTypeAt(pid: number, ch: string, enemyId: number): KeyResult {
    const p = this.players[pid]!
    const e = this.enemies.find(x => x.id === enemyId)
    if (!e || !p.alive || this.over !== 0 || !KEYS.includes(ch)) return 'none'
    if (e.seq[e.ti] !== ch) {
      e.ti = 0
      p.lockId = -1
      this.miss(p)
      return 'miss'
    }
    p.lockId = e.id
    p.correct++
    p.combo++
    p.comboT = COMBO_WINDOW
    p.bestCombo = Math.max(p.bestCombo, p.combo)
    e.ti++
    if (e.ti >= e.seq.length) {
      this.completeSequence(p, e)
      return 'complete'
    }
    return 'advance'
  }
}
