import { describe, expect, it } from 'vitest'
import { Sim, pickKind } from '../../src/core/sim'
import { KEYS, KINDS, OBSTACLES } from '../../src/core/constants'
import { emptyInput } from '../../src/core/types'
import { RNG } from '../../src/core/rng'

function drive(sim: Sim, ticks: number, input = emptyInput()): void {
  for (let i = 0; i < ticks; i++) sim.step(1 / 60, [input])
}

function firstEnemy(sim: Sim) {
  return sim.enemies[0]
}

describe('waves', () => {
  it('spawns enemies on first step, capped', () => {
    const sim = new Sim({ seed: 'w1', playerCount: 1 })
    drive(sim, 5)
    expect(sim.enemies.length).toBeGreaterThan(0)
    expect(sim.enemies.length).toBeLessThanOrEqual(14)
    expect(sim.enemies.every(e => e.seq === e.seq.toUpperCase())).toBe(true)
    expect(sim.enemies.every(e => e.seq.length >= 3)).toBe(true)
  })

  it('accepts uppercase keyboard input for generated training words', () => {
    const sim = new Sim({ seed: 'typing-input', playerCount: 1 })
    drive(sim, 5)
    const target = firstEnemy(sim)
    expect(target.seq.length).toBeGreaterThan(1)
    expect(sim.typeKey(0, target.seq[0]!)).toBe('advance')
  })

  it('transitions to wave 2 at 50 kills; wave-2 enemies use unlocked 4-5 letter words', () => {
    const sim = new Sim({ seed: 'w2', playerCount: 1 })
    drive(sim, 5)
    sim.debugAddKills(50)
    drive(sim, 5)
    expect(sim.wave).toBe(2)
    expect(sim.events.some(e => e.t === 'wave' && e.w === 2)).toBe(true)
    // Clear the wave-1 leftovers.
    for (const e of [...sim.enemies]) {
      while (sim.enemies.includes(e)) sim.debugTypeAt(0, e.seq[e.ti]!, e.id)
    }
    drive(sim, 5)
    expect(sim.enemies.length).toBeGreaterThan(0)
    for (const e of sim.enemies) {
      expect(e.seq.length).toBeGreaterThanOrEqual(4)
      expect(e.seq.length).toBeLessThanOrEqual(5)
    }
  })

  it('wave-2 mix is elite-heavy, wave-1 grunt-heavy (pickKind distribution)', () => {
    const rng = new RNG('mix')
    const wave2 = Array.from({ length: 2000 }, () => pickKind(2, rng))
    const elites = wave2.filter(k => k === 'ELITE').length
    expect(elites).toBeGreaterThan(1100)
    expect(elites).toBeLessThan(1500)
    const rng2 = new RNG('mix2')
    const wave1 = Array.from({ length: 2000 }, () => pickKind(1, rng2))
    const runners = wave1.filter(k => k === 'RUNNER').length
    expect(runners).toBeGreaterThan(550)
    expect(runners).toBeLessThan(850)
  })

  it('clears the field and summons the boss at 100 kills', () => {
    const sim = new Sim({ seed: 'w3', playerCount: 1 })
    drive(sim, 5)
    sim.debugAddKills(100)
    drive(sim, 5)
    expect(sim.wave).toBe(3)
    expect(sim.boss).not.toBeNull()
    expect(sim.boss!.kind).toBe('BOSS')
    expect(sim.boss!.seq.length).toBe(7)
    expect(sim.enemies.filter(e => e.kind !== 'BOSS').length).toBe(0)
    expect(sim.events.some(e => e.t === 'boss')).toBe(true)
  })

  it('same seed produces identical spawns', () => {
    const a = new Sim({ seed: 'same', playerCount: 1 })
    const b = new Sim({ seed: 'same', playerCount: 1 })
    drive(a, 30)
    drive(b, 30)
    expect(a.hash()).toBe(b.hash())
  })
})

describe('combat', () => {
  it('advances a letter, locks, and kills on completion', () => {
    const sim = new Sim({ seed: 'c1', playerCount: 1 })
    drive(sim, 5)
    const e = firstEnemy(sim)
    const pid = 0
    let guard = 0
    while (sim.enemies.includes(e) && guard++ < 50) {
      const ch = e.seq[e.ti]
      const r = sim.debugTypeAt(pid, ch, e.id)
      expect(r === 'advance' || r === 'complete').toBe(true)
    }
    expect(sim.enemies.includes(e)).toBe(false)
    expect(sim.kills).toBe(1)
    expect(sim.players[0]!.kills).toBe(1)
    expect(sim.players[0]!.score).toBeGreaterThan(0)
    expect(sim.players[0]!.correct).toBe(e.seq.length)
  })

  it('MISS BREAKS THE COMBO (the fix the original README promised)', () => {
    const sim = new Sim({ seed: 'c2', playerCount: 1 })
    drive(sim, 5)
    sim.debugAddKills(50)
    drive(sim, 5)
    // Cull wave-1 leftovers so wave-2 spawns refill the field.
    for (const e of [...sim.enemies]) {
      while (sim.enemies.includes(e)) sim.debugTypeAt(0, e.seq[e.ti]!, e.id)
    }
    drive(sim, 5)
    expect(sim.enemies.length).toBeGreaterThan(0)
    // Grab a wave-2 spawn (multi-letter word).
    const e = sim.enemies[0]!
    expect(e.seq.length).toBeGreaterThanOrEqual(4)
    // Advance one correct letter to build the lock + grow the combo.
    const comboBefore = sim.players[0]!.combo
    expect(sim.debugTypeAt(0, e.seq[0]!, e.id)).toBe('advance')
    expect(sim.players[0]!.combo).toBe(comboBefore + 1)
    expect(sim.players[0]!.lockId).toBe(e.id)
    // Type a wrong letter mid-sequence.
    const wrong = KEYS.find(k => k !== e.seq[1])!
    expect(sim.debugTypeAt(0, wrong, e.id)).toBe('miss')
    expect(sim.players[0]!.combo).toBe(0)
    expect(sim.players[0]!.wrong).toBe(1)
    expect(e.ti).toBe(0) // sequence reset
  })

  it('typing a key matching nothing counts as a miss', () => {
    const sim = new Sim({ seed: 'c3', playerCount: 1 })
    drive(sim, 5)
    // A guaranteed-free key exists outside the currently spawned sequences.
    const candidates = new Set(sim.enemies.map(e => e.seq[e.ti]))
    const dead = KEYS.find(k => !candidates.has(k))
    expect(dead).toBeDefined()
    const p = sim.players[0]!
    p.combo = 5
    expect(sim.typeKey(0, dead!)).toBe('miss')
    expect(p.combo).toBe(0)
    expect(p.wrong).toBe(1)
  })

  it('boss takes 10 sequences, changes phases, and ends the game when down', () => {
    const sim = new Sim({ seed: 'c4', playerCount: 1 })
    drive(sim, 5)
    sim.debugAddKills(100)
    drive(sim, 5)
    const boss = sim.boss!
    expect(boss.hp).toBe(10)
    let rounds = 0
    while (sim.boss && rounds++ < 40) {
      for (const ch of boss.seq) {
        if (!sim.boss) break
        sim.debugTypeAt(0, ch, boss.id)
      }
      drive(sim, 2)
    }
    expect(sim.boss).toBeNull()
    expect(sim.over).toBe(1) // win
    expect(rounds).toBe(10)
    // Phase events fired somewhere along the way.
    const phases = sim.events.filter(e => e.t === 'bossphase').map(e => (e as { phase: number }).phase)
    expect(phases).toContain(3)
  })

  it('combo multiplies kill score by the documented formula', () => {
    const sim = new Sim({ seed: 'c5', playerCount: 1 })
    drive(sim, 3)
    const a = sim.enemies[0]!
    const valA = KINDS[a.kind].value
    const before = sim.players[0]!.score
    for (const ch of a.seq) sim.debugTypeAt(0, ch, a.id)
    const gained = sim.players[0]!.score - before
    // Combo equals sequence length at the moment of the killing blow.
    expect(gained).toBe(Math.round(valA * (1 + a.seq.length * 0.25)))
  })
})

describe('determinism', () => {
  it('identical seeds + scripted inputs = identical hashes over 20 seconds', () => {
    const run = (seed: string) => {
      const sim = new Sim({ seed, playerCount: 2 })
      const rng = new RNG('inputs')
      for (let tick = 0; tick < 1200; tick++) {
        const inputs = [0, 1].map(() => ({
          mx: rng.int(3) - 1,
          mz: rng.int(3) - 1,
          jump: rng.chance(0.02),
          dash: rng.chance(0.01),
          key: rng.chance(0.25) ? KEYS[rng.int(KEYS.length)]! : null,
        }))
        sim.step(1 / 60, inputs)
        if (sim.over !== 0) break
      }
      return sim.hash()
    }
    expect(run('det-1')).toBe(run('det-1'))
    expect(run('det-1')).not.toBe(run('det-2'))
  })
})

describe('ai & steering', () => {
  it('spawns enemies outside obstacles and maintains non-overlapping separation', () => {
    const sim = new Sim({ seed: 'ai-safe', playerCount: 1 })
    drive(sim, 3)
    for (const e of sim.enemies) {
      const r = KINDS[e.kind].radius * 0.6
      const insideObstacle = OBSTACLES.some(
        o => e.x > o.x - o.hw - r && e.x < o.x + o.hw + r && e.z > o.z - o.hd - r && e.z < o.z + o.hd + r,
      )
      expect(insideObstacle).toBe(false)
    }
    drive(sim, 120)
    for (let i = 0; i < sim.enemies.length; i++) {
      for (let j = i + 1; j < sim.enemies.length; j++) {
        const a = sim.enemies[i]!
        const b = sim.enemies[j]!
        const d = Math.hypot(a.x - b.x, a.z - b.z)
        expect(d).toBeGreaterThan((KINDS[a.kind].radius + KINDS[b.kind].radius) * 0.7)
      }
    }
  })

  it('elites telegraph shots with a windup event before firing', () => {
    const sim = new Sim({ seed: 'ai-windup', playerCount: 1 })
    drive(sim, 3)
    sim.debugAddKills(50)
    drive(sim, 2)
    for (const e of [...sim.enemies]) {
      while (sim.enemies.includes(e)) sim.debugTypeAt(0, e.seq[e.ti]!, e.id)
    }
    sim.events.length = 0
    // Keep player alive & invulnerable-checked by stepping 6 seconds so an elite winds up and shoots.
    for (let i = 0; i < 360; i++) {
      sim.players[0]!.lives = 3
      sim.step(1 / 60, [emptyInput()])
    }
    const windups = sim.events.filter(e => e.t === 'windup')
    const shots = sim.events.filter(e => e.t === 'shot')
    expect(windups.length).toBeGreaterThan(0)
    expect(shots.length).toBeGreaterThan(0)
  })

  it('maintains stable target lock without jumping mid-word and clears invalid locks', () => {
    const sim = new Sim({ seed: 'lock-stable', playerCount: 1 })
    drive(sim, 5)
    expect(sim.enemies.length).toBeGreaterThanOrEqual(2)
    const a = sim.enemies[0]!
    const b = sim.enemies[1]!
    // Lock onto enemy a with its first letter.
    expect(sim.debugTypeAt(0, a.seq[0]!, a.id)).toBe('advance')
    expect(sim.players[0]!.lockId).toBe(a.id)

    // Pressing a different enemy's letter (that doesn't match a.seq[1]) must miss, NOT switch to b.
    const wrongForA = KEYS.find(k => k !== a.seq[1] && k === b.seq[0]) ?? KEYS.find(k => k !== a.seq[1])!
    expect(sim.typeKey(0, wrongForA)).toBe('miss')
    expect(sim.players[0]!.lockId).toBe(-1)
    expect(b.ti).toBe(0)

    // Re-lock onto a, then remove a externally (invalid target) -> lock clears cleanly.
    expect(sim.debugTypeAt(0, a.seq[0]!, a.id)).toBe('advance')
    expect(sim.players[0]!.lockId).toBe(a.id)
    sim.enemies.splice(sim.enemies.indexOf(a), 1)
    expect(sim.bestTargetId(0)).not.toBe(a.id)
    const next = sim.enemies[0]!
    expect(sim.typeKey(0, next.seq[0]!)).toBe('advance')
    expect(sim.players[0]!.lockId).toBe(next.id)
  })
})
