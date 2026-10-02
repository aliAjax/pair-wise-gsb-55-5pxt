import type {
  LegacyProtectionSetting,
  MigrationState,
  ProtectionSetting,
  SettingOverride,
} from '@/types/domain'
import { extractChanges } from '@/services/settings'

/** 基础定值优先取自该运行方式 */
export const BASE_MODE = '正常方式'

const now = () => new Date().toISOString()

/** 旧数据中出现的运行方式，基础方式排在最前 */
export function legacyModes(settings: ProtectionSetting[]): string[] {
  const modes: string[] = []
  settings.forEach((item) => {
    const mode = (item as LegacyProtectionSetting).operationMode
    if (typeof mode === 'string' && !modes.includes(mode)) modes.push(mode)
  })
  return modes.sort((a, b) => (a === BASE_MODE ? -1 : b === BASE_MODE ? 1 : 0))
}

/** 待迁移的运行方式（基础方式作为基准保留，不生成覆盖） */
export function pendingModes(settings: ProtectionSetting[], doneModes: string[]): string[] {
  return legacyModes(settings).filter((mode) => mode !== BASE_MODE && !doneModes.includes(mode))
}

export function createMigrationCheckpoint(settings: ProtectionSetting[]): MigrationState {
  const total = legacyModes(settings).filter((mode) => mode !== BASE_MODE).length
  return { status: 'pending', totalModes: total, doneModes: [], updatedAt: now() }
}

/**
 * 拆分一个运行方式：把该方式的整份定值与基础定值逐字段对比，
 * 差异字段生成方式覆盖，相同字段不再重复存储。
 * 基础组严格取基础方式的整份定值；某方式出现基础方式中不存在的段
 * 时视为数据残缺并抛错，由调用方记录断点。
 */
export function migrateModeToOverrides(
  settings: ProtectionSetting[],
  mode: string,
): SettingOverride[] {
  const baseMode = legacyModes(settings)[0]
  const baseByKey = new Map<string, ProtectionSetting>()
  settings
    .filter((item) => (item as LegacyProtectionSetting).operationMode === baseMode)
    .forEach((base) => {
      const rest = { ...base } as Partial<LegacyProtectionSetting>
      delete rest.operationMode
      baseByKey.set(`${base.relayId}:${base.stage}`, rest as ProtectionSetting)
    })
  const group = settings.filter(
    (item) => (item as LegacyProtectionSetting).operationMode === mode,
  )
  if (!group.length) {
    throw new Error(`运行方式「${mode}」没有可迁移的定值记录`)
  }
  const overrides: SettingOverride[] = []
  group.forEach((legacy) => {
    const base = baseByKey.get(`${legacy.relayId}:${legacy.stage}`)
    if (!base) {
      throw new Error(
        `运行方式「${mode}」中 ${legacy.relayId} ${legacy.stage} 段缺少对应基础定值，迁移中断`,
      )
    }
    const rest = { ...legacy } as Partial<LegacyProtectionSetting>
    delete rest.operationMode
    const changes = extractChanges(base, rest as ProtectionSetting)
    if (Object.keys(changes).length) {
      overrides.push({
        id: `ovr-${base.id}-${mode}`,
        settingId: base.id,
        operationMode: mode,
        changes,
        updatedAt: now(),
      })
    }
  })
  return overrides
}

/** 迁移收尾：基础定值取基础方式的整份定值，其余方式的记录已被拆为覆盖 */
export function finalizeSettings(settings: ProtectionSetting[]): ProtectionSetting[] {
  const baseMode = legacyModes(settings)[0]
  return settings
    .filter((item) => (item as LegacyProtectionSetting).operationMode === baseMode)
    .map((item) => {
      const rest = { ...item } as Partial<LegacyProtectionSetting>
      delete rest.operationMode
      return rest as ProtectionSetting
    })
}
