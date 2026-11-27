/** Global tuning constants. Pure data — no runtime imports. */

export const VERSION = '2.2.0'
export const GAME_ID = 'cyber-arena-3d-elite'

/** Combat keys expand as the adaptive curriculum unlocks reaches. */
export const KEYS: readonly string[] = [
  ...'ASDFGHJKL;',
  ...'EIRU',
  ...'BCMNOPQTVWXYZ',
]

/** Arena half-size (playfield spans -90..90 on X and Z). */
export const ARENA = 90

export const PLAYER_SPEED = 30
export const PLAYER_RADIUS = 1.6
export const GRAVITY = 70
export const JUMP_VY = 26
export const DASH_TIME = 0.18
export const DASH_MULT = 3
export const DASH_CD = 1.8
export const DASH_INV = 0.3

export const LIVES_MAX = 3
export const INV_TIME = 1
export const COMBO_WINDOW = 2.2
export const COMBO_SPEED_PER = 0.03
export const COMBO_SPEED_MAX = 0.36
export const COMBO_SCORE_PER = 0.25
export const COMBO_SCORE_CAP = 20

/** Enemy threat ramps with total kills (shared across players). */
export const THREAT_BASE = 0.4
export const THREAT_GAIN = 1.1
export const THREAT_KILLS = 140
export const THREAT_MAX = 1.5

export const WAVE2_KILLS = 50
export const WAVE3_KILLS = 100

/** Fixed simulation timestep (60 Hz). */
export const TICK = 1 / 60

/** Snapshot broadcast rate for co-op host. */
export const SNAP_HZ = 10
/** Guest renders this far behind the newest snapshot, for smooth interpolation. */
export const INTERP_DELAY = 0.12

export const FIXED_DT = TICK

export type EnemyKind = 'RUNNER' | 'GRUNT' | 'FLANKER' | 'ELITE' | 'BOSS'

export interface KindDef {
  color: number
  scale: number
  speed: number
  radius: number
  value: number
  gun: boolean
  shoot: boolean
  boss: boolean
}

/** Kind colors: real-world paint — sand, brick, tactical teal, rust, signal red. */
export const KINDS: Record<EnemyKind, KindDef> = {
  RUNNER: { color: 0xdfa93b, scale: 0.82, speed: 14.5, radius: 1.4, value: 80, gun: false, shoot: false, boss: false },
  GRUNT: { color: 0xc0452f, scale: 1.16, speed: 7.4, radius: 2.0, value: 110, gun: false, shoot: false, boss: false },
  FLANKER: { color: 0x56c2a8, scale: 0.94, speed: 11.4, radius: 1.5, value: 140, gun: true, shoot: false, boss: false },
  ELITE: { color: 0xcc5f26, scale: 1.15, speed: 7.2, radius: 1.9, value: 200, gun: true, shoot: true, boss: false },
  BOSS: { color: 0xa83524, scale: 2.3, speed: 3.5, radius: 4.5, value: 2000, gun: false, shoot: false, boss: true },
}

/** Power generator obstacles: static AABBs (x, z, half-w, half-d, height). */
export interface Obstacle { x: number; z: number; hw: number; hd: number; h: number }
export const OBSTACLES: readonly Obstacle[] = [
  { x: -42, z: -28, hw: 9, hd: 6, h: 7 },
  { x: 42, z: -32, hw: 8, hd: 6.5, h: 8 },
  { x: -40, z: 34, hw: 10, hd: 6.5, h: 7 },
  { x: 44, z: 30, hw: 9, hd: 6, h: 8 },
  { x: 0, z: -56, hw: 13, hd: 4.5, h: 9 },
  { x: 0, z: 56, hw: 13, hd: 4.5, h: 9 },
]

export const BULLET_LIFE = 4
export const PICKUP_LIFE = 25

/*
 * Combat physics 2.0 — impulse dynamics in the fixed 60 Hz step.
 *
 * Tuned per the physics-tuning discipline: tunnelling guard
 * (PROP_MAX_SPEED / 60 = 0.63 < thinnest prop radius 1.15), mass ratios
 * within 1:10, per-kind friction/restitution, sleeping thresholds, and a
 * named collision layer matrix (see src/core/physics.ts header).
 */
export const PLAYER_ACCEL = 11 // ground steering rate (1/s)
export const PLAYER_AIR_ACCEL = 4.2 // reduced air control
export const PLAYER_KNOCK_DECAY = 5.5 // knockback velocity decay (1/s)
export const LAND_BOUNCE = 0.24 // landing rebound below this speed fraction
export const PLAYER_PUSH_FORCE = 17 // player shoves crates

export const PROP_FRICTION = 2.3 // ground drag (1/s)
export const PROP_BOUNCE = 0.36 // restitution vs walls/ground
export const PROP_MAX_SPEED = 38 // tunnelling guard
export const PROP_SLEEP_V = 0.4 // below this speed a settled body sleeps…
export const PROP_SLEEP_T = 0.6 // …after this many seconds
export const BARREL_R = 1.15
export const CRATE_R = 1.9
export const BARRELS_EXPLOSIVE = 6
export const BARRELS_INERT = 3
export const CRATES_N = 5

export const BLAST_RADIUS = 16
export const BLAST_KILL_RADIUS = 14.5
export const BLAST_POWER = 34 // horizontal impulse at epicenter
export const BLAST_LAUNCH = 19 // vertical launch at epicenter
export const CHAIN_DELAY_MIN = 0.12
export const CHAIN_DELAY_RAND = 0.14
export const KILL_FUSE_RADIUS = 8 // kills this close damage explosive barrels

export const MORTAR_VY = 38
export const MORTAR_CD = 6.5
export const MORTAR_RADIUS = 12
export const MORTAR_KILL_RADIUS = 9
export const MORTAR_POWER = 24
export const MORTAR_LAUNCH = 14

export const KILL_MSGS: readonly string[] = [
  'GOOD HIT', 'CENTER MASS', 'STEEL DOWN', 'DOUBLE TAP',
  'HOSTILE DOWN', 'FAST HANDS', 'CLEAN KILL', 'TARGET OUT',
]

/** Character height in world units (drives actor scaling). */
export const ACTOR_H = 8.5
