import type { ModeOverride, ProtectionSetting, SettingFieldKey } from '@/types/domain'

/** 基础方式：该方式下的修改直接写入基础定值 */
export const BASE_MODE = '正常方式'

export const SETTING_FIELDS: SettingFieldKey[] = [
  'currentA',
  'timeS',
  'direction',
  'sensitivity',
  'recloseEnabled',
  'recloseDelayS',
  'startCondition',
]

export const settingFieldLabels: Record<SettingFieldKey, string> = {
  currentA: '电流定值',
  timeS: '动作时限',
  direction: '方向',
  sensitivity: '灵敏度',
  recloseEnabled: '重合闸投入',
  recloseDelayS: '重合延迟',
  startCondition: '启动条件',
}

/** 用指定方式的覆盖项合并基础定值，得到该方式下的有效定值 */
export function resolveSettings(
  base: ProtectionSetting[],
  overrides: ModeOverride[],
  mode: string,
): ProtectionSetting[] {
  const bySetting = new Map(
    overrides.filter((item) => item.mode === mode).map((item) => [item.settingId, item]),
  )
  return base.map((setting) => {
    const override = bySetting.get(setting.id)
    return override ? { ...setting, ...override.changes } : { ...setting }
  })
}

export function overrideFor(
  overrides: ModeOverride[],
  mode: string,
  settingId: string,
): ModeOverride | undefined {
  return overrides.find((item) => item.mode === mode && item.settingId === settingId)
}

/** 只保留与基础定值不同的字段，作为方式覆盖内容 */
export function diffToChanges(
  base: ProtectionSetting,
  edited: ProtectionSetting,
): ModeOverride['changes'] {
  const changes: Record<string, string | number | boolean> = {}
  SETTING_FIELDS.forEach((field) => {
    if (edited[field] !== base[field]) changes[field] = edited[field]
  })
  return changes as ModeOverride['changes']
}

export function changesLabel(changes: ModeOverride['changes']): string {
  const labels = SETTING_FIELDS.filter((field) => field in changes).map(
    (field) => settingFieldLabels[field],
  )
  return labels.length ? labels.join('、') : '无差异字段'
}
