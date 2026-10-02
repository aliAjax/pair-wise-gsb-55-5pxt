import type {
  LegacyProtectionSetting,
  ProtectionSetting,
  SettingOverride,
  SettingValueField,
} from '@/types/domain'

/** 允许按运行方式覆盖的定值字段 */
export const SETTING_VALUE_FIELDS: SettingValueField[] = [
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
]

export const settingFieldLabels: Record<SettingValueField, string> = {
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}

export function findOverride(
  overrides: SettingOverride[],
  settingId: string,
  mode: string,
): SettingOverride | undefined {
  return overrides.find((item) => item.settingId === settingId && item.operationMode === mode)
}

/**
 * 合成指定运行方式下的有效定值：基础定值 + 该方式覆盖的差异字段，
 * 未覆盖字段继承基础定值。
 */
export function effectiveSettings(
  settings: ProtectionSetting[],
  overrides: SettingOverride[],
  mode: string,
): ProtectionSetting[] {
  return settings.map((setting) => {
    const override = findOverride(overrides, setting.id, mode)
    if (!override) return { ...setting }
    return { ...setting, ...override.changes, updatedAt: override.updatedAt }
  })
}

/** 只保留与基础定值不同的字段，作为方式覆盖内容 */
export function extractChanges(
  base: ProtectionSetting,
  values: ProtectionSetting,
): SettingOverride['changes'] {
  const changes: SettingOverride['changes'] = {}
  SETTING_VALUE_FIELDS.forEach((field) => {
    if (values[field] !== base[field]) {
      ;(changes as Record<string, string | number | boolean>)[field] = values[field]
    }
  })
  return changes
}

/** 基础定值变更的字段列表 */
export function changedValueFields(
  previous: ProtectionSetting,
  next: ProtectionSetting,
): SettingValueField[] {
  return SETTING_VALUE_FIELDS.filter((field) => previous[field] !== next[field])
}

/** 判断旧版数据：定值按运行方式各存一整份（记录上带 operationMode） */
export function isLegacySettings(settings: ProtectionSetting[]): boolean {
  return settings.some(
    (item) => typeof (item as LegacyProtectionSetting).operationMode === 'string',
  )
}

/**
 * 旧数据的只读折叠视图：按 装置+段位 取基础方式（或首份）整份定值，
 * 供升级完成前的界面展示，不改动原始数据。
 */
export function collapseLegacySettings(
  settings: ProtectionSetting[],
  baseMode: string,
): ProtectionSetting[] {
  const ordered = [...settings].sort((a, b) => {
    const aBase = (a as LegacyProtectionSetting).operationMode === baseMode ? 0 : 1
    const bBase = (b as LegacyProtectionSetting).operationMode === baseMode ? 0 : 1
    return aBase - bBase
  })
  const collapsed = new Map<string, ProtectionSetting>()
  ordered.forEach((item) => {
    const key = `${item.relayId}:${item.stage}`
    if (collapsed.has(key)) return
    const rest = { ...item } as Partial<LegacyProtectionSetting>
    delete rest.operationMode
    collapsed.set(key, rest as ProtectionSetting)
  })
  return [...collapsed.values()]
}
