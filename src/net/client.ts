/**
 * Net guest: sends inputs to the host, receives snapshots + events.
 * Own movement is predicted locally (same physics as the host) and blended
 * toward authoritative positions; everything else is interpolated between
 * snapshots ~120ms behind live.
 */
import { movePlayerBody } from '../core/sim'
import { INTERP_DELAY, OBSTACLES } from '../core/constants'
import type { Bubble, EnemyKind, InputState, SimEvent, Snapshot, ViewModel } from '../core/types'
import { ENEMY_KIND_ORDER, emptyInput } from '../core/types'
import type { Transport } from './transport'

export class NetClient {
  private readonly room: Transport
  private snaps: Snapshot[] = []
  private readonly seqs = new Map<number, { seq: string; kind: EnemyKind }>()
  private readonly self = {
    id: 1, name: 'YOU', alive: true, x: 4, z: 0, y: 0, vy: 0, vx: 0, vz: 0, kx: 0, kz: 0, ang: 0, facing: 0,
    lives: 3, inv: 0, score: 0, kills: 0, combo: 0, comboT: 0, bestCombo: 0,
    correct: 0, wrong: 0, dashT: 0, dashCd: 0, dashDirX: 0, dashDirZ: 1,
    moving: false, lockId: -1, slowed: false,
  }
  private lastSend = 0
  private lastInputSent: InputState = emptyInput()
  seed = ''
  hostName = 'HOST'
  started = false
  onEvent: (e: SimEvent) => void = () => {}
  onStart: () => void = () => {}
  onKick: (reason: string) => void = () => {}

  constructor(room: Transport, private readonly selfName: string) {
    this.room = room
    room.onPeerJoin(peerId => room.sendMsg({ v: 1, t: 'hello', name: this.selfName }, peerId))
    room.onPeerLeave(() => this.onKick('HOST DISCONNECTED'))
    room.onMessage(msg => {
      switch (msg.t) {
        case 'welcome':
          this.seed = msg.seed
          this.hostName = msg.names[0]
          this.self.name = msg.names[1]
          break
        case 'full':
          this.onKick('ROOM ALREADY FULL')
          break
        case 'start':
          this.started = true
          this.onStart()
          break
        case 'snap':
          this.pushSnap(msg.s)
          break
        case 'ev':
          this.handleEvent(msg.e)
          break
        case 'bye':
          this.onKick('HOST LEFT')
          break
      }
    })
  }

  private pushSnap(s: Snapshot): void {
    const newest = this.snaps[this.snaps.length - 1]
    // Timeline went backwards → host rebooted the run: full reset.
    if (newest && s.t < newest.t - 1) {
      this.snaps = []
      this.seqs.clear()
    }
    this.snaps.push(s)
    if (this.snaps.length > 12) this.snaps.shift()
  }

  private handleEvent(e: SimEvent): void {
    if (e.t === 'seq') this.seqs.set(e.id, { seq: e.seq, kind: e.kind })
    if (e.t === 'kill') this.seqs.delete(e.id)
    this.onEvent(e)
  }

  /** Send current input: keys immediately, movement at 10 Hz. */
  sendInput(inp: InputState, now: number): void {
    if (!this.started) return
    const immediate = inp.key !== null || inp.jump || inp.dash
    const moved = inp.mx !== this.lastInputSent.mx || inp.mz !== this.lastInputSent.mz
    if (immediate || moved || now - this.lastSend > 100) {
      this.lastSend = now
      this.lastInputSent = { ...inp, key: null }
      this.room.sendMsg({
        v: 1, t: 'input',
        mx: inp.mx, mz: inp.mz,
        j: inp.jump ? 1 : 0,
        d: inp.dash ? 1 : 0,
        k: inp.key,
      })
    }
  }

  /** Local prediction of own movement between snapshots. */
  predict(dt: number, inp: InputState): void {
    const latest = this.snaps[this.snaps.length - 1]
    const bubbles: Bubble[] = latest ? latest.bub.map(([x, z, r]) => ({ x, z, r })) : []
    movePlayerBody(this.self, inp, dt, { obstacles: OBSTACLES, bubbles, arena: 90 }, 0)
  }

  /**
   * Local blast prediction: the authoritative impulse arrives with the next
   * snapshot, but the launch is felt now (game-feel: feedback latency 0).
   */
  applyBlast(cx: number, cz: number, radius: number, power: number, launch: number): void {
    const dx = this.self.x - cx
    const dz = this.self.z - cz
    const d = Math.hypot(dx, dz)
    if (d > radius) return
    const falloff = 1 - d / radius
    const inv = d > 0.001 ? 1 / d : 0
    this.self.kx += dx * inv * power * (0.35 + falloff) * 0.6
    this.self.kz += dz * inv * power * (0.35 + falloff) * 0.6
    this.self.vy = Math.max(this.self.vy, launch * falloff)
  }

  /** Interpolated view for the renderer; local player first. */
  view(): ViewModel {
    const latest = this.snaps[this.snaps.length - 1]
    if (!latest) return this.emptyView()
    // Snapshot timeline: render ~INTERP_DELAY behind the newest.
    const t = latest.t - INTERP_DELAY
    let s0 = this.snaps[0]!
    let s1 = latest
    for (let i = 0; i < this.snaps.length - 1; i++) {
      const a = this.snaps[i]!
      const b = this.snaps[i + 1]!
      if (a.t <= t && t <= b.t) {
        s0 = a
        s1 = b
        break
      }
    }
    const span = s1.t - s0.t
    const f = span > 0 ? Math.max(0, Math.min(1, (t - s0.t) / span)) : 1
    const lerp = (a: number, b: number): number => a + (b - a) * f

    const snapSelf = s1.ps[1] // newest authoritative self
    if (snapSelf) {
      const [x, z, y, , lives, inv, score, combo, alive, correct, wrong, bestCombo, kills] = snapSelf
      this.self.lives = lives
      this.self.inv = inv
      this.self.score = score
      this.self.combo = combo
      this.self.alive = alive === 1
      this.self.correct = correct
      this.self.wrong = wrong
      this.self.bestCombo = bestCombo
      this.self.kills = kills
      // Reconcile predicted position: snap on big drift, blend otherwise.
      if (Math.hypot(this.self.x - x, this.self.z - z) > 2.2 || !this.self.alive) {
        this.self.x = x
        this.self.z = z
        this.self.y = y
        this.self.vy = 0
        this.self.vx = 0
        this.self.vz = 0
      } else {
        this.self.x += (x - this.self.x) * 0.12
        this.self.z += (z - this.self.z) * 0.12
        // Vertical: only correct when the host disagrees hard (launches).
        if (Math.abs(this.self.y - y) > 1.6) {
          this.self.y = y
          this.self.vy = 0
        }
      }
    }

    const partnerRaw = s0.ps[0]
    const partnerNew = s1.ps[0]
    const partner = partnerNew
      ? {
        id: 0,
        x: partnerRaw ? lerp(partnerRaw[0], partnerNew[0]) : partnerNew[0],
        z: partnerRaw ? lerp(partnerRaw[1], partnerNew[1]) : partnerNew[1],
        y: partnerRaw ? lerp(partnerRaw[2], partnerNew[2]) : partnerNew[2],
        ang: partnerNew[3],
        lives: partnerNew[4],
        inv: partnerNew[5],
        score: partnerNew[6],
        combo: partnerNew[7],
        alive: partnerNew[8] === 1,
        moving: false,
        dashing: false,
        dashCd: 0,
        slowed: false,
        hurtFlash: 0,
      }
      : null

    const prevById = new Map(s0.es.map(e => [e[0], e]))
    const invSpan = span > 1e-4 ? 1 / span : 0
    const enemies = s1.es.flatMap(e => {
      const meta = this.seqs.get(e[0])
      if (!meta) return []
      const prev = prevById.get(e[0])
      const x = prev ? lerp(prev[2], e[2]) : e[2]
      const z = prev ? lerp(prev[3], e[3]) : e[3]
      const y = prev ? lerp(prev[7], e[7]) : e[7]
      const vx = prev ? (e[2] - prev[2]) * invSpan : 0
      const vz = prev ? (e[3] - prev[3]) * invSpan : 0
      const ang = Math.hypot(vx, vz) > 0.6 ? Math.atan2(vx, vz) : undefined
      return [{
        id: e[0],
        kind: ENEMY_KIND_ORDER[e[1]] ?? 'GRUNT',
        x, z, y, vx, vz, ang,
        ti: e[4],
        seq: meta.seq,
        hp: e[5],
        maxhp: e[6],
      }]
    })

    const props = (s1.pr ?? []).map(p => ({
      id: p[0],
      kind: (p[1] === 0 ? 'CRATE' : 'BARREL') as 'CRATE' | 'BARREL',
      expl: p[1] === 2,
      x: p[2],
      z: p[3],
      y: p[4],
      rot: p[5],
    }))

    return {
      time: s1.tm,
      wave: s1.w,
      kills: s1.k,
      over: s1.ov,
      players: [
        { id: 1, x: this.self.x, z: this.self.z, y: this.self.y, ang: this.self.ang, lives: this.self.lives, inv: this.self.inv, score: this.self.score, combo: this.self.combo, alive: this.self.alive, moving: this.self.moving, dashing: this.self.dashT > 0, dashCd: this.self.dashCd, slowed: this.self.slowed, hurtFlash: 0 },
        ...(partner ? [partner] : []),
      ],
      enemies,
      bullets: s1.bs.map(([x, z, dx, dz]) => ({ x, z, dx, dz })),
      shocks: s1.ss.map(([x, z, r]) => ({ x, z, r })),
      pickups: s1.pk.map(([x, z]) => ({ x, z })),
      bubbles: s1.bub.map(([x, z, r]) => ({ x, z, r })),
      props,
      bossHp: s1.bh,
      bossMax: s1.bmx,
      lockId: -1,
    }
  }

  private emptyView(): ViewModel {
    return {
      time: 0, wave: 1, kills: 0, over: 0,
      players: [{ id: 1, x: this.self.x, z: this.self.z, y: 0, ang: 0, lives: 3, inv: 0, score: 0, combo: 0, alive: true, moving: false, dashing: false, dashCd: 0, slowed: false, hurtFlash: 0 }],
      enemies: [], bullets: [], shocks: [], pickups: [], bubbles: [], props: [],
      bossHp: 0, bossMax: 0, lockId: -1,
    }
  }

  get selfState() {
    return this.self
  }

  get hasSnapshots(): boolean {
    return this.snaps.length > 0
  }

  /** Estimated sequence length progress for the local player's optimistic label feedback. */
  getEnemySeq(id: number): string | undefined {
    return this.seqs.get(id)?.seq
  }
}
