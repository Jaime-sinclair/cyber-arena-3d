/**
 * Audio: WebAudio synth SFX + a layered procedural soundtrack.
 *
 * The music is a 132 BPM step sequencer (bass / arp / kick / hats / pad)
 * whose layers unmute as the player's combo climbs — intensity without
 * asset downloads, and no overlapping random tracks (the original's bug).
 */
export type SfxName =
  | 'hit' | 'miss' | 'step' | 'damage' | 'boom' | 'dash' | 'pickup'
  | 'ui' | 'wave' | 'boss' | 'shoot' | 'shock' | 'win' | 'lose'
  | 'blast' | 'mortar' | 'thud' | 'windup' | 'milestone' | 'combo'

export interface AudioSettings {
  musicVolume: number
  sfxVolume: number
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private musicGain: GainNode | null = null
  private sfxGain: GainNode | null = null
  private musicTimer: ReturnType<typeof setInterval> | null = null
  private step = 0
  private nextNoteTime = 0
  private intensity = 0
  private targetIntensity = 0
  private musicOn = false
  settings: AudioSettings = { musicVolume: 0.6, sfxVolume: 0.8 }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!AC) return
      this.ctx = new AC()
      this.master = this.ctx.createGain()
      this.master.connect(this.ctx.destination)
      this.musicGain = this.ctx.createGain()
      this.musicGain.gain.value = this.settings.musicVolume
      this.musicGain.connect(this.master)
      this.sfxGain = this.ctx.createGain()
      this.sfxGain.gain.value = this.settings.sfxVolume
      this.sfxGain.connect(this.master)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
  }

  applySettings(s: Partial<AudioSettings>): void {
    this.settings = { ...this.settings, ...s }
    if (this.musicGain) this.musicGain.gain.value = this.settings.musicVolume
    if (this.sfxGain) this.sfxGain.gain.value = this.settings.sfxVolume
  }

  /* ---------------- SFX ---------------- */

  private tone(freq: number, dur: number, vol: number, type: OscillatorType, k = 0.4, when = 0): void {
    if (!this.ctx || !this.sfxGain) return
    const t = this.ctx.currentTime + when
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.connect(g)
    g.connect(this.sfxGain)
    o.frequency.setValueAtTime(freq, t)
    o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * k), t + dur)
    g.gain.setValueAtTime(vol, t)
    g.gain.exponentialRampToValueAtTime(0.001, t + dur)
    o.start(t)
    o.stop(t + dur)
  }

  private noise(dur: number, vol: number, freq: number, when = 0): void {
    if (!this.ctx || !this.sfxGain) return
    const t = this.ctx.currentTime + when
    const n = (this.ctx.sampleRate * dur) | 0
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n) ** 2
    const src = this.ctx.createBufferSource()
    src.buffer = buf
    const f = this.ctx.createBiquadFilter()
    f.type = 'lowpass'
    f.frequency.value = freq
    const g = this.ctx.createGain()
    g.gain.value = vol
    src.connect(f)
    f.connect(g)
    g.connect(this.sfxGain)
    src.start(t)
  }

  sfx(name: SfxName): void {
    if (!this.ctx) return
    switch (name) {
      case 'hit': this.tone(820, 0.12, 0.14, 'sine', 1.5); break
      case 'miss': this.tone(130, 0.08, 0.09, 'sawtooth', 0.4); break
      case 'step': this.tone(550, 0.07, 0.05, 'sine', 0.4); break
      case 'damage': this.tone(80, 0.3, 0.12, 'sawtooth', 0.4); this.noise(0.2, 0.12, 600); break
      case 'boom': this.noise(0.4, 0.22, 700); this.tone(60, 0.35, 0.1, 'sine', 0.3); break
      case 'dash': this.noise(0.18, 0.1, 2400); this.tone(300, 0.15, 0.06, 'sine', 2.2); break
      case 'pickup': this.tone(660, 0.1, 0.1, 'sine', 1.5); this.tone(990, 0.12, 0.1, 'sine', 1.2, 0.08); break
      case 'ui': this.tone(440, 0.06, 0.06, 'square', 1.4); break
      case 'wave': [523, 659, 784].forEach((f, i) => this.tone(f, 0.2, 0.08, 'square', 1.1, i * 0.09)); break
      case 'boss': this.tone(55, 1.2, 0.16, 'sawtooth', 0.5); this.noise(0.8, 0.14, 300); break
      case 'shoot': this.tone(220, 0.08, 0.05, 'sawtooth', 0.5); break
      case 'windup': this.tone(860, 0.22, 0.045, 'triangle', 1.45); break
      case 'milestone': this.tone(72, 0.35, 0.16, 'sine', 0.45); [587, 740, 880, 1175].forEach((f, i) => this.tone(f, 0.24, 0.08, 'triangle', 1.05, i * 0.055)); break
      case 'combo': [660, 990].forEach((f, i) => this.tone(f, 0.14, 0.07, 'sine', 1.15, i * 0.05)); break
      case 'shock': this.tone(90, 0.5, 0.12, 'sawtooth', 0.3); this.noise(0.5, 0.1, 400); break
      case 'blast': this.noise(0.7, 0.3, 320); this.tone(46, 0.55, 0.2, 'sine', 0.5); this.noise(0.22, 0.18, 1500, 0.02); this.noise(0.5, 0.12, 900, 0.06); break
      case 'mortar': this.tone(1350, 0.85, 0.06, 'sine', 0.24); break
      case 'thud': this.noise(0.13, 0.16, 240); this.tone(62, 0.14, 0.11, 'sine', 0.5); break
      case 'win': [523, 659, 784, 1046].forEach((f, i) => this.tone(f, 0.35, 0.09, 'sine', 1, i * 0.1)); break
      case 'lose': [400, 300, 200, 100].forEach((f, i) => this.tone(f, 0.3, 0.1, 'sawtooth', 0.8, i * 0.12)); break
    }
  }

  /** Combo-pitched typing hit confirmation for crisp tactile feedback. */
  hitKey(combo: number): void {
    if (!this.ctx) return
    const pitch = 500 * (1 + Math.min(combo, 18) * 0.035)
    this.tone(pitch, 0.065, 0.055, 'triangle', 0.65)
  }

  /* ---------------- procedural music ---------------- */

  startMusic(): void {
    if (!this.ctx || this.musicOn) return
    this.musicOn = true
    this.step = 0
    this.nextNoteTime = this.ctx.currentTime + 0.1
    this.musicTimer = setInterval(() => this.scheduler(), 25)
  }

  stopMusic(): void {
    this.musicOn = false
    if (this.musicTimer) clearInterval(this.musicTimer)
    this.musicTimer = null
  }

  /** 0..1 — driven by combo by the session. */
  setIntensity(x: number): void {
    this.targetIntensity = Math.max(0, Math.min(1, x))
  }

  private scheduler(): void {
    if (!this.ctx) return
    this.intensity += (this.targetIntensity - this.intensity) * 0.05
    const SPB = 60 / 132 / 4 // 16th notes
    while (this.nextNoteTime < this.ctx.currentTime + 0.12) {
      this.scheduleStep(this.step, this.nextNoteTime)
      this.nextNoteTime += SPB
      this.step++
    }
  }

  private mNote(freq: number, when: number, dur: number, vol: number, type: OscillatorType, filterFreq?: number): void {
    if (!this.ctx || !this.musicGain) return
    const o = this.ctx.createOscillator()
    const g = this.ctx.createGain()
    o.type = type
    o.frequency.value = freq
    o.connect(g)
    if (filterFreq) {
      const f = this.ctx.createBiquadFilter()
      f.type = 'lowpass'
      f.frequency.value = filterFreq
      g.connect(f)
      f.connect(this.musicGain)
    } else {
      g.connect(this.musicGain)
    }
    g.gain.setValueAtTime(0, when)
    g.gain.linearRampToValueAtTime(vol, when + 0.01)
    g.gain.exponentialRampToValueAtTime(0.001, when + dur)
    o.start(when)
    o.stop(when + dur + 0.05)
  }

  private scheduleStep(step: number, when: number): void {
    const s16 = step % 16
    const bar = Math.floor(step / 16) % 8
    const A = 55 // A1
    const roots = [A, A, A * 1.19, A * 1.19, A * 1.335, A * 1.335, A * 0.89, A * 1.19] // Am C D G-ish loop

    // Pad — always on, soft.
    if (s16 === 0) {
      const root = roots[bar]!
      this.mNote(root * 2, when, 2.2, 0.035, 'sawtooth', 500)
      this.mNote(root * 2 * 1.5, when, 2.2, 0.025, 'sawtooth', 500)
    }
    // Bass — always on.
    if (s16 % 4 === 0) this.mNote(roots[bar]!, when, 0.22, 0.09, 'square', 300)
    // Kick — always on.
    if (s16 % 4 === 0) this.mNote(70, when, 0.14, 0.16, 'sine', 200)
    // Arp — from intensity 0.25.
    if (this.intensity > 0.25 && s16 % 2 === 0) {
      const arpNotes = [1, 1.5, 2, 3, 2, 1.5, 2, 2.5]
      const n = arpNotes[(step / 2) % 8 | 0]!
      this.mNote(roots[bar]! * 4 * n, when, 0.12, 0.03 + this.intensity * 0.03, 'square', 2400)
    }
    // Hats — from intensity 0.5.
    if (this.intensity > 0.5 && s16 % 2 === 1) this.mNote(6000 + Math.random() * 500, when, 0.04, 0.015 + this.intensity * 0.02, 'square', 9000)
    // Lead stab — from intensity 0.8.
    if (this.intensity > 0.8 && s16 === 14) this.mNote(roots[bar]! * 8, when, 0.3, 0.04, 'sawtooth', 3500)
  }
}
