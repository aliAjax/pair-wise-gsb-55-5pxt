import type { AppState } from '@/types/domain'
import { createInitialState, operationModes } from '@/data/mock'
import {
  collapseLegacySettings,
  effectiveSettings,
  findOverride,
  isLegacySettings,
  settingFieldLabels,
  SETTING_VALUE_FIELDS,
} from '@/services/settings'
import { BASE_MODE, createMigrationCheckpoint } from '@/services/migration'

const STORAGE_KEY = 'grid-protection-review-v1'

/**
 * 归一化持久化数据：补齐新增字段；识别按运行方式整份存储的旧数据并
 * 建立迁移断点；上次升级中断（running 残留）标记为失败以便断点重试。
 */
function normalizeState(parsed: AppState): AppState {
  const state = { ...parsed }
  state.overrides = state.overrides ?? []
  state.activeMode = state.activeMode || operationModes[0]
  if (isLegacySettings(state.settings)) {
    if (!state.migration || state.migration.status === 'done') {
      state.migration = createMigrationCheckpoint(state.settings)
    } else if (state.migration.status === 'running') {
      state.migration = {
        ...state.migration,
        status: 'failed',
        error: '升级过程被中断，已完成的方式保留在断点中，可继续重试。',
        updatedAt: new Date().toISOString(),
      }
    }
  }
  return state
}

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  try {
    return normalizeState(JSON.parse(raw) as AppState)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

/** 展示/导出用的基础定值：旧数据先折叠为基础方式视图 */
function viewableSettings(state: AppState) {
  return isLegacySettings(state.settings)
    ? collapseLegacySettings(state.settings, BASE_MODE)
    : state.settings
}

/** 按当前运行方式导出有效定值：覆盖字段取自方式覆盖，其余继承基础定值 */
export function exportSettingsText(state: AppState): string {
  const mode = state.activeMode || operationModes[0]
  const base = viewableSettings(state)
  const effective = effectiveSettings(base, state.overrides ?? [], mode)
  const lines = [
    '电网继电保护定值清单',
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `运行方式：${mode}（方式覆盖优先，其余字段继承基础定值）`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件,方式覆盖字段',
  ]
  effective.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    const override = findOverride(state.overrides ?? [], setting.id, mode)
    const coveredFields = SETTING_VALUE_FIELDS.filter(
      (field) => override && field in override.changes,
    )
      .map((field) => settingFieldLabels[field])
      .join('、')
    lines.push(
      [
        setting.relayId,
        relay,
        target,
        setting.stage,
        setting.currentA,
        setting.timeS,
        setting.direction,
        setting.sensitivity,
        setting.recloseEnabled ? '投入' : '退出',
        setting.recloseDelayS,
        setting.startCondition,
        coveredFields || '-',
      ].join(','),
    )
  })
  return lines.join('\n')
}
