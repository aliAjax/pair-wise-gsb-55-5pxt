import type {
  AppState,
  MigrationState,
  ModeOverride,
  ProtectionSetting,
} from '@/types/domain'
import { BASE_MODE, diffToChanges } from '@/services/overrides'

export const SCHEMA_VERSION = 2

/** v1 旧版结构：每个运行方式各留一份完整定值（modeSettings） */
export interface LegacyAppState
  extends Omit<AppState, 'overrides' | 'activeMode' | 'schemaVersion' | 'migration'> {
  schemaVersion?: number
  activeMode?: string
  overrides?: ModeOverride[]
  migration?: MigrationState
  modeSettings?: Record<string, ProtectionSetting[]>
}

const now = () => new Date().toISOString()

export function needsMigration(state: LegacyAppState): boolean {
  return state.schemaVersion !== SCHEMA_VERSION || Boolean(state.modeSettings)
}

/** 把一个方式的整份定值与基础定值逐字段比较，拆成只含差异字段的覆盖项 */
export function splitModeOverrides(
  mode: string,
  copies: ProtectionSetting[],
  base: ProtectionSetting[],
): ModeOverride[] {
  return copies.flatMap((copy) => {
    const baseSetting = base.find((item) => item.id === copy.id)
    if (!baseSetting) {
      throw new Error(`方式「${mode}」中的定值 ${copy.id} 找不到对应的基础定值`)
    }
    const changes = diffToChanges(baseSetting, copy)
    if (!Object.keys(changes).length) return []
    return [
      {
        id: `ovr-${mode}-${copy.id}`,
        mode,
        settingId: copy.id,
        changes,
        updatedAt: copy.updatedAt ?? now(),
      },
    ]
  })
}

/**
 * 把旧版按方式整份保存的定值拆成「基础定值 + 方式覆盖」。
 * 每拆完一个方式就写入一次断点；失败时保留断点，重试从下一个方式继续。
 * 历史基线快照不参与拆分，仍按原快照保留。
 */
export function migrateState(
  input: LegacyAppState,
  persist: (state: LegacyAppState) => void,
): AppState {
  if (!needsMigration(input)) return input as AppState

  const legacyModes = Object.keys(input.modeSettings ?? {})
  const migration: MigrationState =
    input.migration && input.migration.status !== 'done'
      ? { ...input.migration, status: 'running', error: undefined, updatedAt: now() }
      : { status: 'running', processedModes: [], totalModes: legacyModes, updatedAt: now() }
  const overrides: ModeOverride[] = [...(input.overrides ?? [])]
  const working: LegacyAppState = {
    ...input,
    overrides,
    activeMode: input.activeMode ?? BASE_MODE,
    migration,
  }

  try {
    legacyModes.forEach((mode) => {
      if (migration.processedModes.includes(mode)) return
      overrides.push(...splitModeOverrides(mode, input.modeSettings?.[mode] ?? [], input.settings))
      migration.processedModes.push(mode)
      migration.updatedAt = now()
      // 断点：modeSettings 暂不删除，崩溃后重试可从下一个方式继续
      persist({ ...working, overrides: [...overrides], migration: { ...migration } })
    })
  } catch (error) {
    const failed: MigrationState = {
      ...migration,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      updatedAt: now(),
    }
    persist({ ...working, overrides: [...overrides], migration: failed })
    return { ...working, overrides, migration: failed } as AppState
  }

  const done: MigrationState = { ...migration, status: 'done', updatedAt: now() }
  const migrated = { ...working, overrides, schemaVersion: SCHEMA_VERSION, migration: done }
  delete migrated.modeSettings
  persist(migrated)
  return migrated as AppState
}
