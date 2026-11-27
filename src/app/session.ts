/**
 * Session: owns one run end-to-end. Wires input → sim (or net client) →
 * view model → renderer/HUD/VFX/audio, runs the fixed-timestep loop with
 * hit-stop, pause, retry and game-over flow.
 */
import * as THREE from 'three'
import {
  FIXED_DT, KEYS, KILL_MSGS, KINDS,
} from '../core/constants'
import { Sim } from '../core/sim'
import { randomCode } from '../core/rng'
import { accuracy, wpm } from '../core/stats'
import type { EnemyKind, InputState, SimEvent, ViewModel } from '../core/types'
import { emptyInput } from '../core/types'
import type { GameRenderer } from '../render/renderer'
import { World } from '../render/world'
import { createActor, createPlayerActor } from '../render/actorfactory'
import type { ActorView } from '../render/actor'
import { LabelSystem } from '../render/labels'
import { VFX } from '../render/vfx'
import { PropRenderer } from '../render/props'
import { Hud } from '../render/hud'
import type { AudioEngine } from '../render/audio'
import { OverlayScreens } from '../ui/overlay'
import type { Settings } from '../ui/menu'
import type { NetHost } from '../net/host'
import type { NetClient } from '../net/client'
import type { Transport } from '../net/transport'
import { BLAST_LAUNCH, BLAST_POWER, BLAST_RADIUS } from '../core/constants'

export type SessionMode = 'solo' | 'daily' | 'coop-host' | 'coop-guest'

export interface SessionConfig {
  mode: SessionMode
  seed: string
  renderer: GameRenderer
  fxLayer: HTMLElement
  speedlinesEl: HTMLElement
  settings: Settings
  audio: AudioEngine
  net?: { room: Transport; host?: NetHost; client?: NetClient }
  onExitToMenu: () => void
}

interface EnemyView {
  holder: THREE.Group
  actor: ActorView
  kind: EnemyKind
  /** Ragdoll state after the kill event: ballistic tumble + ground bounces. */
  rag?: { dx: number; dz: number; spin: number; vy: number; y: number }
  /** Previous frame position — velocity estimate drives flinches. */
  lastX?: number
  lastZ?: number
}

const BULLET_GEO = new THREE.BoxGeometry(0.5, 0.5, 2.6)
const BULLET_MAT = new THREE.MeshBasicMaterial({ color: 0xd8542a })

export class Session {
  private readonly cfg: SessionConfig
  private readonly world: World
  private readonly vfx: VFX
  private readonly labels: LabelSystem
  private readonly hud: Hud
  private readonly screens: OverlayScreens

  private sim: Sim | null
  private readonly host: NetHost | null
  private readonly client: NetClient | null

  private readonly playerActors: ActorView[] = []
  private readonly playerHolders: THREE.Group[] = []
  private readonly enemies = new Map<number, EnemyView>()
  private readonly dying: { view: EnemyView; t: number }[] = []
  private readonly bulletPool: THREE.Mesh[] = []
  private readonly shockPool: THREE.Mesh[] = []
  private readonly pickupPool: THREE.Group[] = []
  private readonly bubbleMeshes: THREE.Group[] = []
  private readonly propFx: PropRenderer
  /** Local player fall tracking for landing thuds. */
  private prevLocalY = 0
  private prevLocalVy = 0

  private raf = 0
  private lastFrame = 0
  private accumulator = 0
  private running = false
  paused = false
  private gameOverShown = false
  private overHandled = false
  private startedAt = 0

  private readonly held = new Set<string>()
  private pendingKey: string | null = null
  private jumpQueued = false
  private dashQueued = false
  private lockFeedbackId = -1
  private fireFlashT = 0
  private localAng = Math.PI / 2
  private lockLookTarget: { x: number; z: number } | null = null

  private frameMsEma = 16
  private qualityChecked = false
  private readonly localId: number
  private readonly keydown = (e: KeyboardEvent): void => this.onKeyDown(e)
  private readonly keyup = (e: KeyboardEvent): void => this.onKeyUp(e)
  private readonly blur = (): void => this.onBlur()

  constructor(cfg: SessionConfig) {
    this.cfg = cfg
    this.host = cfg.net?.host ?? null
    this.client = cfg.net?.client ?? null
    this.sim = this.host ? null : this.client ? null : new Sim({ seed: cfg.seed, playerCount: 1, names: [cfg.settings.name || 'PLAYER 1', 'PLAYER 2'] })
    this.localId = this.client ? 1 : 0

    cfg.renderer.scene.clear()
    this.world = new World(cfg.renderer.scene)
    this.labels = new LabelSystem(cfg.renderer.scene)
    this.vfx = new VFX(cfg.renderer.scene, {
      fxLayer: cfg.fxLayer,
      speedlinesEl: cfg.speedlinesEl,
      camera: cfg.renderer.camera,
      shakeEnabled: () => cfg.settings.shake,
    })
    this.screens = new OverlayScreens(cfg.fxLayer.parentElement ?? document.body)
    this.hud = new Hud(cfg.fxLayer.parentElement ?? document.body, {
      onPause: () => this.togglePause(),
      onCycleCamera: () => this.cycleCamera(),
    })
    this.propFx = new PropRenderer(cfg.renderer.scene, (x, y, z, color, n, power) =>
      this.vfx.sparkBurst(x, y, z, color, n, power))

    // Player actors.
    const playerCount = this.host || this.client ? 2 : 1
    for (let i = 0; i < playerCount; i++) {
      const holder = new THREE.Group()
      const actor = createPlayerActor(i === this.localId)
      holder.add(actor.root)
      cfg.renderer.scene.add(holder)
      this.playerHolders.push(holder)
      this.playerActors.push(actor)
    }

    // Co-op wiring.
    if (this.host) {
      this.host.onEvent = e => this.handleEvent(e)
    }
    if (this.client) {
      this.client.onEvent = e => this.handleEvent(e)
      this.client.onKick = reason => {
        this.stop()
        cfg.onExitToMenu()
        this.screens.toast(reason, 'err')
      }
    }

    this.hud.show(true)
    const modeLabel = cfg.mode === 'daily' ? 'DAILY' : cfg.mode === 'solo' ? 'SOLO' : 'CO-OP'
    this.hud.setMode(modeLabel, cfg.mode === 'solo' ? '' : cfg.seed.toUpperCase())
    if (playerCount > 1) {
      const partnerName = this.host ? this.host.guestNameResolved : (this.client?.hostName ?? 'PARTNER')
      this.hud.setPartner(partnerName)
    }

    window.addEventListener('keydown', this.keydown)
    window.addEventListener('keyup', this.keyup)
    window.addEventListener('blur', this.blur)
    document.addEventListener('visibilitychange', this.blur)
  }

  /* ------------------------------------------------ input ------------------------------------------------ */

  private onKeyDown(e: KeyboardEvent): void {
    this.cfg.audio.unlock()
    if (e.repeat) return
    if (this.gameOverShown) {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.retry()
      }
      return
    }
    const k = e.key.toLowerCase()
    if (k in { arrowup: 1, arrowdown: 1, arrowleft: 1, arrowright: 1 }) {
      e.preventDefault()
      if (!this.paused) this.screens.toast('HOME ROW ANCHORED — MOVEMENT IS AUTOMATIC', 'info')
      return
    }
    if (k === ' ') {
      e.preventDefault()
      if (this.paused) return
      this.jumpQueued = true
      return
    }
    if (e.key === 'Shift') {
      if (!this.paused) this.dashQueued = true
      return
    }
    if (e.key === 'Tab') {
      e.preventDefault()
      if (!this.paused) this.cycleCamera()
      return
    }
    if (e.key === 'Escape') {
      this.togglePause()
      return
    }
    const ch = e.key.length === 1 ? e.key.toUpperCase() : ''
    if (!ch || !KEYS.includes(ch)) return
    if (this.paused) return
    this.pendingKey = ch
    this.predictFireFeedback(ch)
  }

  private cycleCamera(): void {
    this.vfx.cycleCameraMode()
    const label = this.vfx.cameraModeLabel()
    this.hud.setCameraMode(label)
    this.cfg.audio.sfx('ui')
    this.screens.toast(`CAMERA: ${label}`, 'info')
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.held.delete(e.key.toLowerCase())
  }

  private onBlur(): void {
    this.held.clear()
    if (this.cfg.mode === 'solo' || this.cfg.mode === 'daily') {
      if (this.running && !this.paused && !this.gameOverShown) this.togglePause()
    }
  }

  private buildInput(): InputState {
    const inp: InputState = {
      mx: (this.held.has('arrowright') ? 1 : 0) - (this.held.has('arrowleft') ? 1 : 0),
      mz: (this.held.has('arrowdown') ? 1 : 0) - (this.held.has('arrowup') ? 1 : 0),
      jump: this.jumpQueued,
      dash: this.dashQueued,
      key: this.pendingKey,
    }
    this.pendingKey = null
    this.jumpQueued = false
    this.dashQueued = false
    return inp
  }

  /** Instant local feedback for typing: lock-preserving beam + sfx before the tick lands. */
  private predictFireFeedback(ch: string): void {
    const vm = this.lastVM
    if (!vm) return
    const activeId = vm.lockId >= 0 ? vm.lockId : this.lockFeedbackId
    const lock = activeId >= 0 ? vm.enemies.find(e => e.id === activeId) : undefined
    let target = null as (typeof vm.enemies)[number] | null
    if (lock) {
      // Strictly never switch mid-sequence while locked onto a live enemy.
      target = lock.seq[lock.ti] === ch ? lock : null
    } else {
      const p0 = vm.players[0]
      if (!p0) return
      let bestScore = Infinity
      for (const e of vm.enemies) {
        if (e.seq[e.ti] !== ch) continue
        const d = Math.hypot(e.x - p0.x, e.z - p0.z)
        const threat = ((e.windup ?? 0) > 0 ? 18 : 0) + (e.kind === 'ELITE' ? 6 : e.kind === 'RUNNER' ? 4 : e.kind === 'FLANKER' ? 3 : 0)
        const lower = e.z > p0.z + 6 ? 4 : 0
        const s = d - threat - (e.ti > 0 ? 8 : 0) - lower
        if (s < bestScore) { bestScore = s; target = e }
      }
    }
    if (!target) {
      this.cfg.audio.sfx('miss')
      this.vfx.addShake(0.15)
      this.lockFeedbackId = -1
      return
    }
    this.lockFeedbackId = target.id
    this.fireFlashT = 0.4
    this.cfg.audio.hitKey((vm.players[0]?.combo ?? 0) + 1)
    this.playerActors[this.localId]?.shoot()
    this.enemies.get(target.id)?.actor.hit()
    const from = this.playerActors[this.localId]?.muzzle() ?? new THREE.Vector3()
    const hitY = KINDS[target.kind].scale * 4.5
    this.vfx.showBeam(from, new THREE.Vector3(target.x, hitY, target.z), 0.1)
    this.vfx.impactFlash(target.x, hitY, target.z, 0xffd9a0, 1.3, 0.11)
    this.vfx.sparkBurst(target.x, hitY * 0.75, target.z, 0xffd9a0, 8, 0.9)
  }

  /* ------------------------------------------------ loop ------------------------------------------------ */

  start(): void {
    this.running = true
    this.startedAt = performance.now()
    this.lastFrame = performance.now()
    this.cfg.audio.startMusic()
    this.raf = requestAnimationFrame(this.frame)
  }

  private frame = (now: number): void => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.frame)
    const raw = Math.min(50, now - this.lastFrame)
    this.lastFrame = now
    const realDt = Math.min(0.05, raw / 1000)
    let dt = Math.min(0.033, raw / 1000)

    // Quality governor: drop bloom if frames are consistently slow.
    this.frameMsEma += (raw - this.frameMsEma) * 0.02
    if (!this.qualityChecked && now - this.startedAt > 4000) {
      this.qualityChecked = true
      if (this.frameMsEma > 26 && this.cfg.renderer.quality === 'high') {
        this.cfg.renderer.setQuality('low')
        this.screens.toast('PERFORMANCE MODE: EFFECTS REDUCED', 'info')
      }
    }

    if (this.vfx.hitStop > 0) {
      this.vfx.hitStop -= dt
      dt *= 0.03
    }
    this.fireFlashT = Math.max(0, this.fireFlashT - dt)

    if (!this.paused) {
      if (this.client) {
        this.client.predict(dt, this.buildInputPredicted())
        this.client.sendInput(this.lastPredictedInput, now)
      } else if (this.host) {
        this.accumulator += dt
        let steps = 0
        while (this.accumulator >= FIXED_DT && steps < 5) {
          this.host.tick(FIXED_DT, this.buildInput())
          this.accumulator -= FIXED_DT
          steps++
        }
      } else if (this.sim) {
        this.accumulator += dt
        let steps = 0
        while (this.accumulator >= FIXED_DT && steps < 5) {
          const events = this.sim.events
          this.sim.step(FIXED_DT, [this.buildInput()])
          for (const e of events) this.handleEvent(e)
          this.sim.events.length = 0
          this.accumulator -= FIXED_DT
          steps++
        }
      }
    }

    const vm = this.buildVM()
    this.lastVM = vm
    this.syncScene(vm, dt)
    const stats = this.localStats()
    this.hud.update(
      vm,
      this.sim ? this.sim.threat() : this.client ? this.guestThreat(vm.kills) : 0.4,
      wpm(stats.correct, performance.now() - this.startedAt),
      accuracy(stats.correct, stats.wrong),
    )
    const combo = vm.players[0]?.combo ?? 0
    this.cfg.audio.setIntensity(Math.min(1, 0.2 + combo / 14))
    this.propFx.update(dt)
    this.vfx.update(dt, vm, vm.players[0] ?? { x: 0, z: 0, y: 0 }, realDt, this.lockLookTarget)
    this.renderer().render()
  }

  private lastPredictedInput: InputState = emptyInput()

  private buildInputPredicted(): InputState {
    this.lastPredictedInput = this.buildInput()
    return this.lastPredictedInput
  }

  private lastVM: ViewModel | null = null

  private renderer(): GameRenderer {
    return this.cfg.renderer
  }

  private guestThreat(kills: number): number {
    return Math.min(1.5, 0.4 + Math.min(1, kills / 140) * 1.1)
  }

  private localStats(): { correct: number; wrong: number } {
    if (this.sim) {
      const p = this.sim.players[this.localId]!
      return { correct: p.correct, wrong: p.wrong }
    }
    if (this.client) {
      const s = this.client.selfState
      return { correct: s.correct, wrong: s.wrong }
    }
    return { correct: 0, wrong: 0 }
  }

  /* ------------------------------------------------ view model ------------------------------------------------ */

  private buildVM(): ViewModel {
    if (this.client) {
      const vm = this.client.view()
      return vm
    }
    const sim = this.host ? this.host.sim : this.sim!
    const players = sim.players.map(p => ({
      id: p.id,
      x: p.x, z: p.z, y: p.y, ang: p.ang,
      lives: p.lives, inv: p.inv, score: p.score, combo: p.combo,
      alive: p.alive, moving: p.moving, dashing: p.dashT > 0, dashCd: p.dashCd,
      slowed: p.slowed, hurtFlash: 0,
    }))
    if (this.localId === 1 && players.length > 1) players.reverse()
    const enemies = sim.enemies.map(e => ({
      id: e.id, kind: e.kind, x: e.x, z: e.z, y: e.y,
      ang: e.ang, vx: e.vx, vz: e.vz, stag: e.stag, windup: e.windup, recover: e.recover,
      ti: e.ti, seq: e.seq, hp: e.hp, maxhp: e.maxhp,
    }))
    const props = sim.props.filter(p => p.alive).map(p => ({
      id: p.id, kind: p.kind, expl: p.expl,
      x: p.x, z: p.z, y: p.y, rot: p.rot,
    }))
    const localSimPlayer = sim.players[this.localId]
    const acc = localSimPlayer ? accuracy(localSimPlayer.correct, localSimPlayer.wrong) : 100
    return {
      time: sim.runClock,
      wave: sim.wave,
      kills: sim.kills,
      over: sim.over,
      players,
      enemies,
      bullets: sim.bullets.map(b => ({ x: b.x, z: b.z, dx: b.dx, dz: b.dz })),
      shocks: sim.shocks.map(s => ({ x: s.x, z: s.z, r: s.r })),
      pickups: sim.pickups.map(p => ({ x: p.x, z: p.z })),
      bubbles: sim.bubbles,
      props,
      bossHp: sim.boss ? sim.boss.hp : 0,
      bossMax: sim.boss ? sim.boss.maxhp : 0,
      lockId: localSimPlayer?.lockId ?? -1,
      candidateId: sim.bestTargetId(this.localId),
      curriculum: sim.curriculum.snapshot(sim.wave, acc),
    }
  }

  /* ------------------------------------------------ events ------------------------------------------------ */

  private handleEvent(e: SimEvent): void {
    const vm = this.lastVM
    const local = this.localId
    switch (e.t) {
      case 'kill': {
        const color = KINDS[e.kind].color
        this.vfx.sparkBurst(e.x, 3, e.z, color, 26, 1.1)
        this.vfx.sparkBurst(e.x, 3, e.z, 0xffffff, 10, 1.25)
        this.vfx.impactFlash(e.x, 3.2, e.z, color, e.milestone ? 3.2 : 2.1, e.milestone ? 0.24 : 0.16)
        this.vfx.ring(e.x, e.z, color)
        if (e.combo >= 5) this.vfx.ring(e.x, e.z, 0xffd27a)
        this.world.boom(e.x, e.z, color)
        this.vfx.addTrauma(e.milestone ? 0.42 : 0.3)
        this.vfx.hitStop = e.milestone ? 0.055 : 0.035
        this.vfx.addKick(1)
        this.cfg.audio.sfx('boom')
        if (e.milestone) {
          this.cfg.audio.sfx('milestone')
          this.vfx.milestonePulse()
          this.vfx.ring(e.x, e.z, 0xffd27a)
          this.vfx.sparkBurst(e.x, 4, e.z, 0xffd27a, 18, 1.5)
          this.vfx.text(`ELIMINATION STREAK · ${this.lastKillCount(e)}`, e.x, 6.5, e.z)
        } else if (e.by === local && e.combo > 0 && (e.combo === 5 || e.combo === 10 || e.combo === 15 || e.combo === 20 || e.combo === 25)) {
          this.cfg.audio.sfx('combo')
          this.vfx.text(`COMBO ${e.combo}x`, e.x, 6, e.z)
        } else if (e.by === local && e.speedKill) {
          this.vfx.text('FAST HANDS +1', e.x, 5.5, e.z)
        } else if (e.by === local) {
          this.vfx.text(KILL_MSGS[(Math.random() * KILL_MSGS.length) | 0], e.x, 5, e.z)
        }
        // Move actor to dying list with its ragdoll launch parameters.
        const view = this.enemies.get(e.id)
        if (view) {
          this.enemies.delete(e.id)
          this.labels.remove(e.id)
          view.actor.die()
          view.rag = {
            dx: e.dx ?? 0,
            dz: e.dz ?? 1,
            spin: e.spin ?? 5,
            vy: e.vy ?? 11,
            y: view.holder.position.y,
          }
          this.dying.push({ view, t: 0 })
        }
        break
      }
      case 'blast': {
        // Large tier (game-feel): heavy trauma, short hit-stop, fireball.
        const focus = vm?.players[0] ?? { x: 0, z: 0 }
        this.cfg.audio.sfx('blast')
        this.vfx.blast(e.x, e.z, e.r, focus)
        this.vfx.hitStop = Math.min(0.12, this.vfx.hitStop > 0 ? this.vfx.hitStop : 0.05)
        this.world.boom(e.x, e.z, 0xd97e2c, 26)
        this.world.boom(e.x + 2, e.z - 1, 0x552211, 14)
        this.vfx.sparkBurst(e.x, 2.5, e.z, 0xe8742c, 34, 2.1)
        this.vfx.sparkBurst(e.x, 2, e.z, 0xfff0d0, 12, 2.6)
        this.vfx.sparkBurst(e.x, 1.5, e.z, 0x3a362e, 18, 0.5)
        this.vfx.ring(e.x, e.z, 0xb9a67e)
        this.vfx.ring(e.x, e.z, 0xd97e2c)
        this.propFx.reapShells(e.x, e.z)
        // Guest: predict the launch locally so it is felt this frame.
        if (this.client) {
          this.client.applyBlast(e.x, e.z, BLAST_RADIUS, BLAST_POWER, BLAST_LAUNCH)
        }
        break
      }
      case 'mortar': {
        this.cfg.audio.sfx('mortar')
        this.propFx.spawnShell(e.x, e.z, e.vx, e.vz, e.vy)
        break
      }
      case 'hurt': {
        if (e.p === local) {
          this.screens.damageFlash()
          this.vfx.addTrauma(0.6)
          this.cfg.audio.sfx('damage')
          this.playerActors[local]?.hit()
        }
        const px = vm?.players.find(p => p.id === e.p)
        this.vfx.sparkBurst(e.x, 3, e.z, 0xff3355, 26, 1)
        if (px) this.vfx.ring(e.x, e.z, 0xff3355)
        break
      }
      case 'death': {
        if (e.p === local) {
          this.playerActors[local]?.die()
          this.screens.toast('YOU ARE OFFLINE — RUN ENDED', 'err')
        } else {
          this.screens.toast('PARTNER DOWN', 'err')
        }
        break
      }
      case 'wave': {
        this.cfg.audio.sfx('wave')
        const p = vm?.players[0]
        this.vfx.text(e.w === 2 ? 'WAVE 2: INDEX REACHES UNLOCKED' : 'WAVE UP', p?.x ?? 0, 9, p?.z ?? 0)
        break
      }
      case 'boss': {
        this.cfg.audio.sfx('boss')
        this.vfx.text('JUGGERNAUT INBOUND', 0, 14, -20)
        break
      }
      case 'bossphase': {
        this.cfg.audio.sfx('boss')
        this.vfx.text(`JUGGERNAUT PHASE ${e.phase}`, 0, 14, -20)
        const boss = vm?.enemies.find(x => x.kind === 'BOSS')
        if (boss) {
          this.vfx.ring(boss.x, boss.z, 0xff4422)
          this.vfx.impactFlash(boss.x, 6, boss.z, 0xff5533, 3.5, 0.25)
        }
        this.vfx.addTrauma(0.5)
        break
      }
      case 'pickup': {
        this.cfg.audio.sfx('pickup')
        this.vfx.text('+1 ARMOR', e.x, 5, e.z)
        break
      }
      case 'windup': {
        this.cfg.audio.sfx('windup')
        this.vfx.impactFlash(e.x, 4.4, e.z, 0xff4422, 1.1, 0.25)
        this.vfx.ring(e.x, e.z, 0xff4422)
        break
      }
      case 'shot': {
        this.cfg.audio.sfx('shoot')
        if (e.id !== undefined) this.enemies.get(e.id)?.actor.shoot()
        break
      }
      case 'shock': {
        this.cfg.audio.sfx('shock')
        this.vfx.addTrauma(0.4)
        const p = vm?.players[0]
        if (p) this.vfx.text('JUMP!', p.x, 9, p.z)
        break
      }
      case 'over': {
        this.handleGameOver(e.win)
        break
      }
    }
  }

  private lastKillCount(_e: SimEvent): number {
    const vm = this.lastVM
    return (vm?.kills ?? 0) + 1
  }

  private handleGameOver(win: boolean): void {
    if (this.overHandled) return
    this.overHandled = true
    this.cfg.audio.sfx(win ? 'win' : 'lose')
    this.cfg.audio.setIntensity(0)
    const vm = this.lastVM
    if (!vm) return
    window.setTimeout(() => {
      if (!this.running) return
      this.gameOverShown = true
      const playersForStats = this.statsPlayers()
      this.screens.showGameOver(vm, playersForStats, performance.now() - this.startedAt, this.cfg.mode.toUpperCase(), this.cfg.seed, {
        onRetry: () => this.retry(),
        onMenu: () => {
          this.stop()
          this.cfg.onExitToMenu()
        },
        onShare: () => {
          const text = this.screens.getShareText()
          const url = `${location.origin}${location.pathname}?seed=${encodeURIComponent(this.cfg.seed)}`
          void navigator.clipboard?.writeText(`${text}\n${url}`)
            .then(() => this.screens.toast('RESULT COPIED — SEND IT TO A FRIEND', 'ok'))
            .catch(() => this.screens.toast('CLIPBOARD BLOCKED — SELECT & COPY MANUALLY', 'err'))
        },
      })
    }, win ? 2300 : 1100)
  }

  private statsPlayers(): import('../core/types').PlayerState[] {
    if (this.sim) return this.sim.players
    if (this.host) return this.host.sim.players
    if (this.client) {
      const s = this.client.selfState
      return [s as import('../core/types').PlayerState]
    }
    return []
  }

  /* ------------------------------------------------ scene sync ------------------------------------------------ */

  private syncScene(vm: ViewModel, dt: number): void {
    // Reconcile client lock prediction cleanly with authoritative sim lock.
    if (vm.lockId >= 0) {
      this.lockFeedbackId = vm.lockId
    } else if (this.lockFeedbackId >= 0 && !vm.enemies.some(e => e.id === this.lockFeedbackId)) {
      this.lockFeedbackId = -1
    }
    const activeLockId = vm.lockId >= 0 ? vm.lockId : this.lockFeedbackId
    const lockedEnemy = activeLockId >= 0 ? vm.enemies.find(e => e.id === activeLockId) : undefined
    const candidateEnemy = !lockedEnemy && vm.candidateId !== undefined && vm.candidateId >= 0
      ? vm.enemies.find(e => e.id === vm.candidateId)
      : undefined
    const reticleTarget = lockedEnemy ?? candidateEnemy
    this.vfx.setLockReticle(
      reticleTarget ? reticleTarget.x : null,
      reticleTarget ? reticleTarget.z : null,
      reticleTarget ? KINDS[reticleTarget.kind].radius : 2,
      !!lockedEnemy,
    )
    this.lockLookTarget = lockedEnemy ? { x: lockedEnemy.x, z: lockedEnemy.z } : null

    // Players.
    vm.players.forEach((p, i) => {
      const holder = this.playerHolders[i]
      const actor = this.playerActors[i]
      if (!holder || !actor) return
      holder.position.set(p.x, p.y, p.z)
      if (i === this.localId) {
        const wantAng = lockedEnemy
          ? Math.atan2(lockedEnemy.x - p.x, lockedEnemy.z - p.z)
          : p.ang
        let diff = wantAng - this.localAng
        while (diff > Math.PI) diff -= Math.PI * 2
        while (diff < -Math.PI) diff += Math.PI * 2
        this.localAng += diff * Math.min(1, dt * 14)
        holder.rotation.y = this.localAng
      } else {
        holder.rotation.y = p.ang
      }
      holder.visible = p.alive || i === this.localId
      actor.update(dt, {
        moving: p.moving && p.alive,
        aiming: i === this.localId && (this.lockFeedbackId >= 0 || vm.lockId >= 0 || this.fireFlashT > 0),
        speed: 15,
        air: p.y > 0.4,
      })
    })
    // Landing thud: local player touched down from a real fall.
    {
      const p = vm.players[0]
      if (p) {
        const vy = (p.y - this.prevLocalY) / Math.max(dt, 1e-4)
        if (this.prevLocalY > 0.6 && p.y <= 0.05 && this.prevLocalVy < -18) {
          this.vfx.thud()
          this.vfx.addTrauma(0.22)
          this.cfg.audio.sfx('thud')
        }
        this.prevLocalY = p.y
        this.prevLocalVy = vy
      }
    }
    // Blink during invulnerability.
    const localHolder = this.playerHolders[this.localId]
    const localP = vm.players[0]
    if (localHolder && localP) {
      localHolder.visible = localP.alive && (localP.inv <= 0 || Math.floor(localP.inv * 14) % 2 === 0)
    }

    // Enemies: add/update/remove — height + flinch now physical.
    const seen = new Set<number>()
    for (const e of vm.enemies) {
      seen.add(e.id)
      let view = this.enemies.get(e.id)
      if (!view) {
        const holder = new THREE.Group()
        const actor = createActor(e.kind)
        holder.add(actor.root)
        this.renderer().scene.add(holder)
        view = { holder, actor, kind: e.kind }
        this.enemies.set(e.id, view)
        this.vfx.ring(e.x, e.z, KINDS[e.kind].color)
        this.vfx.sparkBurst(e.x, 0.6, e.z, 0xb9a67e, 6, 0.35)
      }
      view.holder.position.set(e.x, e.y, e.z)
      const nearest = vm.players.reduce((a, b) =>
        Math.hypot(a.x - e.x, a.z - e.z) < Math.hypot(b.x - e.x, b.z - e.z) ? a : b)
      const ang = e.ang ?? Math.atan2(nearest.x - e.x, nearest.z - e.z)
      view.holder.rotation.y = ang
      // Flinch when launched hard (knockback velocity estimate).
      const vel = Math.hypot(e.x - (view.lastX ?? e.x), e.z - (view.lastZ ?? e.z)) / Math.max(dt, 1e-4)
      if (e.y > 0.05 && vel > 24) view.actor.hit()
      view.lastX = e.x
      view.lastZ = e.z
      const vx = e.vx ?? 0
      const vz = e.vz ?? 0
      const moveSpeed = Math.hypot(vx, vz)
      // Lateral component in enemy local space for directional strafe lean.
      const rightX = Math.cos(ang)
      const rightZ = -Math.sin(ang)
      const strafe = Math.max(-1, Math.min(1, (vx * rightX + vz * rightZ) / Math.max(1, KINDS[e.kind].speed)))
      view.actor.update(dt, {
        moving: moveSpeed > 0.6 && (e.kind !== 'BOSS' || Math.hypot(nearest.x - e.x, nearest.z - e.z) > 24),
        aiming: KINDS[e.kind].gun,
        speed: 3 + moveSpeed * 0.9,
        air: e.y > 0.5,
        strafe,
        stagger: (e.stag ?? 0) > 0.02,
        windup: Math.min(1, (e.windup ?? 0) / 0.55),
        recover: Math.min(1, (e.recover ?? 0) / 0.35),
        onStep: e.kind === 'BOSS' || e.kind === 'GRUNT'
          ? () => this.vfx.sparkBurst(e.x, 0.3, e.z, 0x8a8272, e.kind === 'BOSS' ? 5 : 2, e.kind === 'BOSS' ? 0.38 : 0.2)
          : undefined,
      })
      this.labels.ensure(e.id, e.kind)
      this.labels.update(
        e.id, e.kind, e.seq, e.ti, this.lockFeedbackId === e.id,
        e.x, this.labels.labelY(e.kind) + e.y, e.z, this.renderer().camera.quaternion,
      )
    }
    for (const [id, view] of this.enemies) {
      if (!seen.has(id)) {
        this.enemies.delete(id)
        this.labels.remove(id)
        view.holder.removeFromParent()
        view.actor.die()
      }
    }

    // Dying actors: physical ragdoll — ballistic tumble with ground bounces.
    for (let i = this.dying.length - 1; i >= 0; i--) {
      const d = this.dying[i]!
      d.t += dt
      const rag = d.view.rag
      if (rag) {
        rag.vy -= 70 * dt
        rag.y += rag.vy * dt
        if (rag.y <= 0 && rag.vy < 0) {
          if (rag.vy < -13) {
            rag.y = 0
            rag.vy = -rag.vy * 0.35
            rag.dx *= 0.6
            rag.dz *= 0.6
            this.vfx.sparkBurst(d.view.holder.position.x, 0.5, d.view.holder.position.z, 0x8a8272, 4, 0.3)
          } else {
            rag.y = 0
            rag.vy = 0
          }
        }
        d.view.holder.position.y = rag.y
        d.view.holder.position.x += rag.dx * 8 * dt
        d.view.holder.position.z += rag.dz * 8 * dt
        d.view.holder.rotation.x += rag.spin * dt
        d.view.holder.rotation.z += rag.spin * 0.4 * dt
      }
      d.view.actor.update(dt, { moving: false, aiming: false, speed: 0, air: (d.view.rag?.y ?? 0) > 0.5 })
      d.view.holder.scale.setScalar(Math.max(0.01, (1.7 - d.t) / 0.35 > 1 ? 1 : (1.7 - d.t) / 0.35))
      if (d.t > 1.7) {
        d.view.holder.removeFromParent()
        this.dying.splice(i, 1)
      }
    }

    // Bullets.
    this.syncBullets(vm)
    // Shockwaves.
    this.syncShocks(vm, dt)
    // Pickups.
    this.syncPickups(vm, dt)
    // Bubbles.
    this.syncBubbles(vm, dt)
    // Dynamic combat-physics props (barrels, crates).
    this.propFx.sync(vm.props, dt)

    // Focus + world + vfx.
    const focus = vm.players[0] ?? { x: 0, z: 0, y: 0 }
    const bossActive = vm.bossMax > 0 && vm.enemies.some(e => e.kind === 'BOSS')
    this.world.setAtmosphere(vm.wave, bossActive)
    this.world.update(dt, focus.x, focus.z, this.renderer().camera.position)
    this.world.decayBoom(dt)
  }

  private syncBullets(vm: ViewModel): void {
    while (this.bulletPool.length < vm.bullets.length) {
      const m = new THREE.Mesh(BULLET_GEO, BULLET_MAT)
      this.renderer().scene.add(m)
      this.bulletPool.push(m)
    }
    this.bulletPool.forEach((m, i) => {
      const b = vm.bullets[i]
      if (!b) {
        m.visible = false
        return
      }
      m.visible = true
      m.position.set(b.x, 1.4, b.z)
      m.rotation.y = Math.atan2(b.dx, b.dz)
    })
  }

  private syncShocks(vm: ViewModel, _dt: number): void {
    while (this.shockPool.length < vm.shocks.length) {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(0.94, 1, 64),
        new THREE.MeshBasicMaterial({ color: 0xff7a2a, transparent: true, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      )
      m.rotation.x = -Math.PI / 2
      this.renderer().scene.add(m)
      this.shockPool.push(m)
    }
    this.shockPool.forEach((m, i) => {
      const s = vm.shocks[i]
      if (!s) {
        m.visible = false
        return
      }
      m.visible = true
      m.position.set(s.x, 0.3, s.z)
      m.scale.setScalar(s.r)
      ;(m.material as THREE.MeshBasicMaterial).opacity = Math.min(1, (150 - s.r) / 60)
    })
  }

  private syncPickups(vm: ViewModel, dt: number): void {
    while (this.pickupPool.length < vm.pickups.length) {
      // Med kit: white crate with a red cross — reads instantly at range.
      const g = new THREE.Group()
      const boxMat = new THREE.MeshStandardMaterial({ color: 0xe9e4d2, roughness: 0.6 })
      const crossMat = new THREE.MeshBasicMaterial({ color: 0xc0392b })
      const a = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.6, 2.2), boxMat)
      const c1 = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.22, 2.25), crossMat)
      c1.position.y = 0.5
      const c2 = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.1, 2.25), crossMat)
      c2.position.y = 0.35
      const lid = new THREE.Mesh(new THREE.BoxGeometry(2.35, 0.22, 2.35), boxMat)
      lid.position.y = 0.85
      g.add(a, c1, c2, lid)
      g.scale.setScalar(1.05)
      this.renderer().scene.add(g)
      this.pickupPool.push(g)
    }
    const t = performance.now() / 1000
    this.pickupPool.forEach((g, i) => {
      const p = vm.pickups[i]
      if (!p) {
        g.visible = false
        return
      }
      g.visible = true
      g.position.set(p.x, 1.9 + Math.sin(t * 3 + i) * 0.35, p.z)
      g.rotation.y += dt * 3
    })
  }

  private syncBubbles(vm: ViewModel, _dt: number): void {
    const key = vm.bubbles.map(b => `${b.x},${b.z},${b.r}`).join(';')
    if (key !== this.bubbleKey) {
      this.bubbleKey = key
      for (const g of this.bubbleMeshes) g.removeFromParent()
      this.bubbleMeshes.length = 0
      vm.bubbles.forEach((b, i) => {
        // Gas hazard: yellow-green haze dome with a painted ground ring.
        const col = i % 2 ? 0x9aa137 : 0x7f8c2c
        const g = new THREE.Group()
        const dome = new THREE.Mesh(
          new THREE.SphereGeometry(b.r, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }),
        )
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(b.r - 0.7, b.r, 48),
          new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
        )
        ring.rotation.x = -Math.PI / 2
        ring.position.y = 0.15
        g.add(dome, ring)
        g.position.set(b.x, 0, b.z)
        this.renderer().scene.add(g)
        this.bubbleMeshes.push(g)
      })
    }
    const t = performance.now() / 1000
    this.bubbleMeshes.forEach((g, i) => {
      g.children[0]?.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.025)
    })
  }

  private bubbleKey = ''

  /* ------------------------------------------------ lifecycle ------------------------------------------------ */

  togglePause(): void {
    if (this.gameOverShown || !this.running) return
    if (this.cfg.mode === 'coop-host' || this.cfg.mode === 'coop-guest') {
      this.screens.toast('CO-OP RUNS STAY LIVE — QUIT VIA MENU', 'info')
      return
    }
    this.paused = !this.paused
    if (this.paused) {
      this.screens.showPause({
        onResume: () => this.togglePause(),
        onRestart: () => {
          this.screens.hidePause()
          this.paused = false
          this.retry()
        },
        onMenu: () => {
          this.stop()
          this.cfg.onExitToMenu()
        },
      })
    } else {
      this.screens.hidePause()
      this.lastFrame = performance.now()
    }
  }

  retry(): void {
    if (this.cfg.mode === 'coop-guest') {
      this.screens.toast('ONLY THE HOST CAN RESTART A SQUAD RUN', 'info')
      return
    }
    this.screens.hideGameOver()
    this.screens.hidePause()
    this.gameOverShown = false
    this.overHandled = false
    this.paused = false
    this.startedAt = performance.now()
    this.accumulator = 0
    this.lockFeedbackId = -1
    this.held.clear()
    this.pendingKey = null
    const seed = this.cfg.mode === 'solo' ? randomCode() : this.cfg.seed
    this.cfg.seed = seed
    const modeLabel = this.cfg.mode === 'daily' ? 'DAILY' : this.cfg.mode === 'solo' ? 'SOLO' : 'CO-OP'
    this.hud.setMode(modeLabel, this.cfg.mode === 'solo' ? '' : seed.toUpperCase())
    if (this.host) {
      this.host.restart(seed)
    } else if (this.sim) {
      this.sim = new Sim({ seed, playerCount: 1, names: [this.cfg.settings.name || 'PLAYER 1', 'PLAYER 2'] })
    }
    // Reset player actors.
    for (const a of this.playerActors) a.reset()
    this.vfx.resetCamera()
    this.propFx.clear()
    this.prevLocalY = 0
    this.prevLocalVy = 0
    this.cfg.audio.setIntensity(0.2)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
    window.removeEventListener('keydown', this.keydown)
    window.removeEventListener('keyup', this.keyup)
    window.removeEventListener('blur', this.blur)
    document.removeEventListener('visibilitychange', this.blur)
    this.cfg.audio.stopMusic()
    this.labels.clear()
    this.hud.show(false)
    this.screens.hideGameOver()
    this.screens.hidePause()
    this.propFx.clear()
    this.world.dispose()
    this.cfg.renderer.scene.clear()
  }
}
