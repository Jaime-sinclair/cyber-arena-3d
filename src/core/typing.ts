/** Progressive hybrid typing curriculum, vocabulary bank, mastery tracker, and adaptive pace helpers. */
import type { RNG } from './rng'

export type TrainingStage = 1 | 2 | 3
export type VocabLevel = 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' | 'EXPERT'
export type CurriculumEnemyKind = 'RUNNER' | 'GRUNT' | 'FLANKER' | 'ELITE' | 'BOSS'

export interface VocabEntry {
  word: string
  level: VocabLevel
}

export interface MasteryConfig {
  /** Clean completions required to master a word. */
  minSuccesses: number
  /** Consecutive clean completions without a miss to master. */
  minCleanStreak: number
  /** Recent-word window size to avoid repetition. */
  recentWindow: number
  /** Mastered words in current level needed to unlock next level early. */
  promoteThreshold: number
}

export const DEFAULT_MASTERY_CONFIG: MasteryConfig = {
  minSuccesses: 2,
  minCleanStreak: 2,
  recentWindow: 10,
  promoteThreshold: 8,
}

/** Configurable vocabulary bank grouped by difficulty tier. */
export const VOCABULARY_BANK: Record<VocabLevel, readonly string[]> = {
  BEGINNER: [
    'fad', 'sad', 'had', 'all', 'ask', 'lag', 'gas', 'jag', 'ash', 'has',
    'add', 'aid', 'air', 'ear', 'far', 'jar', 'kid', 'lid', 'rid', 'sir',
    'fall', 'hall', 'half', 'dash', 'flag', 'glad', 'hash', 'lash', 'sash',
    'jade', 'lake', 'safe', 'sail', 'raid', 'fair', 'fire', 'rise', 'fast',
    'high', 'rush', 'dark', 'mark', 'hard', 'card',
  ],
  INTERMEDIATE: [
    'glass', 'flash', 'salsa', 'laser', 'flare', 'armor', 'guard', 'radar',
    'cover', 'squad', 'surge', 'pulse', 'flank', 'scout', 'burst', 'aside',
    'slide', 'fresh', 'safer', 'ready', 'range', 'storm', 'crack', 'spark',
    'breach', 'shield', 'target', 'reload', 'impact', 'sprint', 'vector',
    'strike', 'charge', 'sentry', 'bunker', 'tracer', 'hazard', 'launch',
    'steady', 'sniper',
  ],
  ADVANCED: [
    'storm', 'squad', 'crack', 'target', 'sprint', 'reload', 'impact', 'danger',
    'trigger', 'barrage', 'armored', 'phantom', 'assault', 'command', 'warhead',
    'breaker', 'striker', 'sentinel', 'operator', 'defender', 'tactical',
    'training', 'protocol', 'vanguard', 'crossfire', 'kinetic', 'overwatch',
    'precision', 'barricade', 'ricochet', 'shockwave', 'telemetry', 'intercept',
    'calibrate', 'stabilize', 'momentum', 'escalation', 'perimeter',
  ],
  EXPERT: [
    'warhead', 'armored', 'barrage', 'striker', 'sentinel',
    'juggernaut', 'cybernetics', 'overclocked', 'ballistics', 'annihilate',
    'exoskeleton', 'unstoppable', 'suppression', 'transponder', 'equilibrium',
    'synchronized', 'hypervelocity', 'countermeasure', 'reconnaissance',
  ],
}

export const VOCAB_LEVEL_ORDER: readonly VocabLevel[] = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'EXPERT']

export interface WordMasteryState {
  seen: number
  successes: number
  misses: number
  streak: number
  bestMs: number
  mastered: boolean
  reviewCooldown: number
}

export interface CurriculumSnapshot {
  level: VocabLevel
  wave: number
  masteredCount: number
  levelTotal: number
  remainingInLevel: number
  accuracy: number
  levelProgress: number
  difficultyLabel: string
  reviewCount: number
}

export const HOME_ROW_KEYS: readonly string[] = ['F', 'J', 'A', 'S', 'D', 'G', 'H', 'K', 'L', ';']
export const INDEX_MIDDLE_KEYS: readonly string[] = ['E', 'I', 'R', 'U']

export const STAGE_ONE_WORDS: readonly string[] = VOCABULARY_BANK.BEGINNER
export const STAGE_TWO_WORDS: readonly string[] = VOCABULARY_BANK.INTERMEDIATE
export const STAGE_THREE_WORDS: readonly string[] = VOCABULARY_BANK.ADVANCED

export function trainingStage(kills: number): TrainingStage {
  if (kills < 50) return 1
  if (kills < 100) return 2
  return 3
}

export function enemyWordLength(kind: CurriculumEnemyKind, stage: TrainingStage): number {
  if (kind === 'BOSS') return stage >= 3 ? 7 : stage === 2 ? 5 : 3
  if (kind === 'RUNNER') return stage === 1 ? 3 : stage === 2 ? 4 : 5
  if (kind === 'FLANKER') return stage === 1 ? 3 : stage === 2 ? 4 : 5
  if (kind === 'GRUNT') return stage === 1 ? 4 : stage === 2 ? 5 : 6
  return stage === 1 ? 4 : stage === 2 ? 5 : 7
}

export function adaptiveEnemySpeedScale(wpm: number): number {
  if (wpm <= 15) return 0.55
  if (wpm >= 100) return 1
  return 0.55 + ((wpm - 15) / 85) * 0.45
}

export function selectTrainingWord(kind: CurriculumEnemyKind, kills: number, index: number): string {
  const stage = trainingStage(kills)
  const pool = stage === 1 ? STAGE_ONE_WORDS : stage === 2 ? STAGE_TWO_WORDS : STAGE_THREE_WORDS
  const desired = enemyWordLength(kind, stage)
  const matching = pool.filter(word => word.length <= desired)
  const sameLength = matching.filter(word => word.length === desired)
  const candidates = sameLength.length ? sameLength : matching
  if (!candidates.length) return stage === 1 ? 'had' : stage === 2 ? 'fire' : 'target'
  return candidates[Math.abs(index) % candidates.length]!
}

/**
 * Stateful hybrid curriculum tracker: combines wave unlocking with per-word
 * mastery, anti-repetition history, active-enemy deduplication, and missed-word
 * spaced review without ever blocking wave progression.
 */
export class CurriculumTracker {
  private readonly cfg: MasteryConfig
  private readonly mastery = new Map<string, WordMasteryState>()
  private readonly recent: string[] = []
  private readonly reviewQueue: string[] = []
  private totalAttempts = 0
  private totalClean = 0

  constructor(cfg: Partial<MasteryConfig> = {}) {
    this.cfg = { ...DEFAULT_MASTERY_CONFIG, ...cfg }
  }

  /** Highest unlocked vocabulary tier given wave + current mastery. */
  currentLevel(wave: number): VocabLevel {
    const begMastered = this.masteredInLevel('BEGINNER')
    const intMastered = this.masteredInLevel('INTERMEDIATE')
    const advMastered = this.masteredInLevel('ADVANCED')
    if (wave >= 3) {
      return intMastered >= this.cfg.promoteThreshold || advMastered >= 4 ? 'EXPERT' : 'ADVANCED'
    }
    if (wave === 2) {
      return intMastered >= this.cfg.promoteThreshold ? 'ADVANCED' : 'INTERMEDIATE'
    }
    return begMastered >= this.cfg.promoteThreshold ? 'INTERMEDIATE' : 'BEGINNER'
  }

  private masteredInLevel(level: VocabLevel): number {
    let n = 0
    for (const w of VOCABULARY_BANK[level]) {
      if (this.mastery.get(w.toUpperCase())?.mastered) n++
    }
    return n
  }

  private recordRecent(word: string): void {
    const up = word.toUpperCase()
    const idx = this.recent.indexOf(up)
    if (idx >= 0) this.recent.splice(idx, 1)
    this.recent.push(up)
    if (this.recent.length > this.cfg.recentWindow) this.recent.shift()
  }

  /** Select the next word for an enemy, avoiding active duplicates and mastered repeats. */
  pickWord(kind: CurriculumEnemyKind, wave: number, kills: number, activeWords: ReadonlySet<string>, rng: RNG): string {
    for (const st of this.mastery.values()) {
      if (st.reviewCooldown > 0) st.reviewCooldown--
    }
    const level = this.currentLevel(wave)
    const stage = trainingStage(kills)
    const targetLen = enemyWordLength(kind, stage)
    const activeFirst = new Set([...activeWords].map(w => w[0]))

    // 1. Spaced review of missed words when ready and length-compatible.
    for (let i = 0; i < this.reviewQueue.length; i++) {
      const w = this.reviewQueue[i]!
      const st = this.mastery.get(w)
      if (st && st.reviewCooldown <= 0 && !activeWords.has(w) && w.length <= targetLen + 1 && (wave !== 2 || (w.length >= 4 && w.length <= 5)) && (kind !== 'BOSS' || w.length === 7)) {
        this.reviewQueue.splice(i, 1)
        this.recordRecent(w)
        return w
      }
    }

    // 2. Build candidate pool from unlocked levels respecting wave length envelopes.
    const levelIdx = VOCAB_LEVEL_ORDER.indexOf(level)
    const unlockedLevels = VOCAB_LEVEL_ORDER.slice(0, levelIdx + 1)
    const rawPool: string[] = []
    for (const lv of unlockedLevels) {
      for (const w of VOCABULARY_BANK[lv]) rawPool.push(w.toUpperCase())
    }
    // Also guarantee exact-length boss/wave words are always present.
    const lengthOk = rawPool.filter(w => {
      if (kind === 'BOSS') return w.length === targetLen
      if (wave === 2) return w.length >= 4 && w.length <= 5
      if (wave === 1) return w.length >= 3 && w.length <= 4
      return w.length >= 4 && w.length <= Math.max(targetLen + 1, 7)
    })
    const pool = lengthOk.length ? lengthOk : [selectTrainingWord(kind, kills, rng.int(100)).toUpperCase()]

    // Filter hierarchy: unmastered + not active + not recent + unique starting letter.
    const filter = (allowMastered: boolean, allowRecent: boolean, allowSameFirst: boolean, allowActive: boolean): string[] =>
      pool.filter(w => {
        if (!allowActive && activeWords.has(w)) return false
        if (!allowRecent && this.recent.includes(w)) return false
        if (!allowSameFirst && activeFirst.has(w[0])) return false
        if (!allowMastered && this.mastery.get(w)?.mastered) return false
        return true
      })

    let candidates = filter(false, false, false, false)
    if (!candidates.length) candidates = filter(false, false, true, false)
    if (!candidates.length) candidates = filter(false, true, true, false)
    if (!candidates.length) candidates = filter(true, false, false, false)
    if (!candidates.length) candidates = filter(true, false, true, false)
    if (!candidates.length) candidates = filter(true, true, true, false)
    if (!candidates.length) candidates = pool

    // Prefer words close to targetLen for archetype distinction.
    const exact = candidates.filter(w => w.length === targetLen)
    const finalPool = exact.length ? exact : candidates
    const chosen = finalPool[rng.int(finalPool.length)]!
    const st = this.mastery.get(chosen)
    if (st) st.seen++
    else this.mastery.set(chosen, { seen: 1, successes: 0, misses: 0, streak: 0, bestMs: 0, mastered: false, reviewCooldown: 0 })
    this.recordRecent(chosen)
    return chosen
  }

  /** Record a word completion or mistake for mastery & spaced review. */
  recordResult(word: string, clean: boolean, durationMs = 0): void {
    const up = word.toUpperCase()
    let st = this.mastery.get(up)
    if (!st) {
      st = { seen: 1, successes: 0, misses: 0, streak: 0, bestMs: 0, mastered: false, reviewCooldown: 0 }
      this.mastery.set(up, st)
    }
    this.totalAttempts++
    if (clean) {
      this.totalClean++
      st.successes++
      st.streak++
      if (durationMs > 0 && (st.bestMs === 0 || durationMs < st.bestMs)) st.bestMs = durationMs
      if (st.successes >= this.cfg.minSuccesses && st.streak >= this.cfg.minCleanStreak && (st.misses === 0 || st.successes >= st.misses + 2)) {
        st.mastered = true
      }
      const rqIdx = this.reviewQueue.indexOf(up)
      if (rqIdx >= 0 && st.streak >= 1) this.reviewQueue.splice(rqIdx, 1)
    } else {
      st.misses++
      st.streak = 0
      st.mastered = false
      st.reviewCooldown = 3
      if (!this.reviewQueue.includes(up)) this.reviewQueue.push(up)
    }
  }

  snapshot(wave: number, fallbackAccuracy = 100): CurriculumSnapshot {
    const level = this.currentLevel(wave)
    const bank = VOCABULARY_BANK[level]
    const masteredCount = this.masteredInLevel(level)
    const levelTotal = bank.length
    const remainingInLevel = Math.max(0, levelTotal - masteredCount)
    const accuracy = this.totalAttempts > 0 ? Math.round((this.totalClean / this.totalAttempts) * 100) : fallbackAccuracy
    const levelProgress = levelTotal > 0 ? Math.min(1, masteredCount / Math.min(levelTotal, this.cfg.promoteThreshold)) : 1
    const difficultyLabel =
      level === 'BEGINNER' ? 'HOME ROW · 3–4 CH'
        : level === 'INTERMEDIATE' ? 'TACTICAL · 4–6 CH'
          : level === 'ADVANCED' ? 'COMPLEX · 6–9 CH'
            : 'MASTER · 7–12 CH'
    return {
      level,
      wave,
      masteredCount,
      levelTotal,
      remainingInLevel,
      accuracy,
      levelProgress,
      difficultyLabel,
      reviewCount: this.reviewQueue.length,
    }
  }
}
