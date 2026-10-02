import type { AppState } from '@/types/domain'
import { createInitialState } from '@/data/mock'
import { migrateState, type LegacyAppState } from '@/services/migration'
import { BASE_MODE, changesLabel, resolveSettings } from '@/services/overrides'

const STORAGE_KEY = 'grid-protection-review-v1'

export function loadState(): AppState {
  if (typeof window === 'undefined') return createInitialState()
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
  try {
    // 旧版数据在这里升级为「基础定值 + 方式覆盖」，失败时保留断点等待重试
    return migrateState(JSON.parse(raw) as LegacyAppState, saveState)
  } catch {
    const initial = createInitialState()
    saveState(initial)
    return initial
  }
}

export function saveState(state: AppState | LegacyAppState): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetState(): AppState {
  const initial = createInitialState()
  saveState(initial)
  return initial
}

export function exportSettingsText(state: AppState): string {
  const mode = state.activeMode ?? BASE_MODE
  const modeOverrides = (state.overrides ?? []).filter((item) => item.mode === mode)
  const effective = resolveSettings(state.settings, state.overrides ?? [], mode)
  const lines = [
    '电网继电保护定值清单',
    `运行方式：${mode}（基础定值 ${state.settings.length} 条，本方式覆盖 ${modeOverrides.length} 项）`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    '装置编号,保护装置,保护对象,段位,电流定值(A),时限(s),方向,灵敏度,重合闸,重合延迟(s),启动条件,取值来源',
  ]
  effective.forEach((setting) => {
    const relay = state.devices.find((device) => device.id === setting.relayId)?.name ?? setting.relayId
    const target =
      state.devices.find((device) => device.id === setting.protectedDeviceId)?.name ??
      setting.protectedDeviceId
    const override = modeOverrides.find((item) => item.settingId === setting.id)
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
        override ? `本方式覆盖：${changesLabel(override.changes)}` : '基础定值',
      ].join(','),
    )
  })
  return lines.join('\n')
}
