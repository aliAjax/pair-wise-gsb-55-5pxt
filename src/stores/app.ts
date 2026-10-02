import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AppState,
  AuditEntry,
  BaselineVersion,
  Device,
  ProtectionSetting,
  ReviewComment,
  ReviewStatus,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState, createLegacyState, operationModes } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import { persistState } from '@/api/client'
import { loadState, saveState } from '@/services/storage'
import {
  BASE_MODE,
  SETTING_FIELDS,
  changesLabel,
  diffToChanges,
  resolveSettings,
} from '@/services/overrides'

const createId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`

const now = () => new Date().toISOString()

function checksum(settings: ProtectionSetting[]): string {
  const source = settings
    .map((item) => `${item.id}:${item.currentA}:${item.timeS}:${item.recloseDelayS}`)
    .join('|')
  let value = 0
  for (let index = 0; index < source.length; index += 1) {
    value = (value * 31 + source.charCodeAt(index)) >>> 0
  }
  return value.toString(16).toUpperCase().padStart(8, '0').match(/.{4}/g)?.join('-') ?? '0000-0000'
}

/** 重新生成问题时保留同 id 问题的处理状态，避免已关闭问题反复出现 */
function mergeIssues(previous: ValidationIssue[], next: ValidationIssue[]): ValidationIssue[] {
  const byId = new Map(previous.map((issue) => [issue.id, issue]))
  return next.map((issue) => {
    const existing = byId.get(issue.id)
    return existing
      ? { ...issue, status: existing.status, createdAt: existing.createdAt }
      : issue
  })
}

function settingsChanged(before: ProtectionSetting[], after: ProtectionSetting[]): boolean {
  if (before.length !== after.length) return true
  return before.some((setting, index) =>
    SETTING_FIELDS.some((field) => setting[field] !== after[index]?.[field]),
  )
}

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  const settings = computed(() => data.value.settings)
  const overrides = computed(() => data.value.overrides ?? [])
  const activeMode = computed(() => data.value.activeMode ?? BASE_MODE)
  const effectiveSettings = computed(() =>
    resolveSettings(data.value.settings, overrides.value, activeMode.value),
  )
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
  const pendingReconfirmScenarios = computed(() =>
    data.value.scenarios.filter((scenario) => scenario.reconfirmRequired),
  )
  const migration = computed(() => data.value.migration)
  const activeBaseline = computed(() =>
    data.value.baselines.find((baseline) => baseline.id === data.value.activeBaselineId),
  )

  function hydrate(state: AppState) {
    data.value = state
    hydrated.value = true
  }

  async function commit(message: string) {
    saving.value = true
    try {
      const saved = await persistState(JSON.parse(JSON.stringify(data.value)) as AppState)
      data.value = saved
      lastMessage.value = message
    } finally {
      saving.value = false
    }
  }

  function appendAudit(entry: Omit<AuditEntry, 'id' | 'createdAt'>) {
    data.value.audit.unshift({
      ...entry,
      id: createId('audit'),
      createdAt: now(),
    })
  }

  /** 按当前方式的有效定值重新校核 */
  function revalidateCurrentMode() {
    data.value.issues = mergeIssues(
      data.value.issues,
      validateSettings(effectiveSettings.value, data.value.devices),
    )
  }

  function snapshotEffectiveByMode(): Map<string, ProtectionSetting[]> {
    return new Map(
      operationModes.map((mode) => [
        mode,
        resolveSettings(data.value.settings, overrides.value, mode),
      ]),
    )
  }

  function affectedModesSince(before: Map<string, ProtectionSetting[]>): string[] {
    return operationModes.filter((mode) =>
      settingsChanged(
        before.get(mode) ?? [],
        resolveSettings(data.value.settings, overrides.value, mode),
      ),
    )
  }

  /** 受影响方式下已流转的场景标记为待重新确认，动作序列与停电范围原样保留 */
  function flagAffectedScenarios(modes: string[]): number {
    if (!modes.length) return 0
    let count = 0
    data.value.scenarios.forEach((scenario) => {
      const reviewable = ['reviewing', 'approved', 'locked'].includes(scenario.status)
      if (modes.includes(scenario.operationMode) && reviewable && !scenario.reconfirmRequired) {
        scenario.reconfirmRequired = true
        count += 1
      }
    })
    return count
  }

  async function addDevice(device: Omit<Device, 'id'>) {
    const item = { ...device, id: createId('device') }
    data.value.devices.push(item)
    appendAudit({
      action: '新增设备',
      target: item.name,
      operator: '当前用户',
      detail: `设备类型：${item.kind}，电压等级：${item.voltage}kV。`,
    })
    await commit(`已新增 ${item.name}`)
    return item
  }

  async function updateDevice(device: Device) {
    const index = data.value.devices.findIndex((item) => item.id === device.id)
    if (index < 0) return
    data.value.devices[index] = { ...device, operationModes: [...device.operationModes] }
    appendAudit({
      action: '更新设备',
      target: device.name,
      operator: '当前用户',
      detail: `运行状态调整为 ${device.status}。`,
    })
    await commit(`已更新 ${device.name}`)
  }

  async function switchMode(mode: string) {
    if (!mode || mode === activeMode.value) return
    data.value.activeMode = mode
    revalidateCurrentMode()
    appendAudit({
      action: '切换运行方式',
      target: mode,
      operator: '当前用户',
      detail: `已按「${mode}」有效定值重新校核，当前 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit(`已切换到「${mode}」并重新校核`)
  }

  async function saveSetting(setting: ProtectionSetting) {
    const mode = activeMode.value
    const before = snapshotEffectiveByMode()
    let action: string
    let detail: string
    if (mode === BASE_MODE) {
      const index = data.value.settings.findIndex((item) => item.id === setting.id)
      const next = { ...setting, updatedAt: now() }
      if (index >= 0) data.value.settings[index] = next
      else data.value.settings.push(next)
      action = index >= 0 ? '修改基础定值' : '新增基础定值'
      detail = `电流 ${setting.currentA}A，时限 ${setting.timeS}s；未覆盖该字段的方式同步继承。`
    } else {
      const base = data.value.settings.find((item) => item.id === setting.id)
      if (!base) {
        throw new Error(`「${mode}」方式下只能调整已有定值的覆盖，请先在${BASE_MODE}新增定值段。`)
      }
      const changes = diffToChanges(base, setting)
      const existing = data.value.overrides.find(
        (item) => item.mode === mode && item.settingId === setting.id,
      )
      if (!Object.keys(changes).length) {
        if (existing) {
          data.value.overrides = data.value.overrides.filter((item) => item.id !== existing.id)
        }
        action = '清除方式覆盖'
        detail = `与基础定值一致，「${mode}」恢复继承。`
      } else if (existing) {
        existing.changes = changes
        existing.updatedAt = now()
        action = '修改方式覆盖'
        detail = `「${mode}」覆盖字段：${changesLabel(changes)}。`
      } else {
        data.value.overrides.push({
          id: createId('ovr'),
          mode,
          settingId: setting.id,
          changes,
          updatedAt: now(),
        })
        action = '新增方式覆盖'
        detail = `「${mode}」覆盖字段：${changesLabel(changes)}，其余字段继承基础定值。`
      }
    }
    const reconfirmCount = flagAffectedScenarios(affectedModesSince(before))
    revalidateCurrentMode()
    appendAudit({
      action,
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail: reconfirmCount ? `${detail} ${reconfirmCount} 个故障场景待重新确认。` : detail,
    })
    await commit('定值已保存')
  }

  async function clearOverride(settingId: string) {
    const mode = activeMode.value
    const existing = data.value.overrides.find(
      (item) => item.mode === mode && item.settingId === settingId,
    )
    if (!existing) return
    const before = snapshotEffectiveByMode()
    data.value.overrides = data.value.overrides.filter((item) => item.id !== existing.id)
    flagAffectedScenarios(affectedModesSince(before))
    revalidateCurrentMode()
    appendAudit({
      action: '恢复继承基础定值',
      target: settingId,
      operator: '当前用户',
      detail: `已清除「${mode}」的覆盖字段：${changesLabel(existing.changes)}。`,
    })
    await commit('已恢复继承基础定值')
  }

  async function runValidation() {
    data.value.issues = mergeIssues(
      data.value.issues,
      validateSettings(effectiveSettings.value, data.value.devices),
    )
    appendAudit({
      action: '批量校验',
      target: `${activeMode.value}有效定值`,
      operator: '当前用户',
      detail: `生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit('批量校验完成')
    return data.value.issues
  }

  async function updateIssue(issue: ValidationIssue) {
    const index = data.value.issues.findIndex((item) => item.id === issue.id)
    if (index >= 0) data.value.issues[index] = issue
    appendAudit({
      action: '更新问题状态',
      target: issue.pairLabel,
      operator: '当前用户',
      detail: `状态更新为 ${issue.status}。`,
    })
    await commit('问题状态已更新')
  }

  async function addComment(comment: Omit<ReviewComment, 'id' | 'createdAt'>) {
    data.value.comments.unshift({
      ...comment,
      id: createId('comment'),
      createdAt: now(),
    })
    appendAudit({
      action: '提交会签意见',
      target: comment.targetId,
      operator: comment.author,
      detail: comment.content,
    })
    await commit('意见已提交')
  }

  async function updateScenarioStatus(id: string, status: ReviewStatus) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario) return
    scenario.status = status
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
  }

  async function confirmScenario(id: string) {
    const scenario = data.value.scenarios.find((item) => item.id === id)
    if (!scenario || !scenario.reconfirmRequired) return
    scenario.reconfirmRequired = false
    appendAudit({
      action: '重新确认场景',
      target: scenario.name,
      operator: '当前用户',
      detail: '定值变更后复核完成，原动作序列与停电范围继续保留。',
    })
    await commit('场景已重新确认')
  }

  async function addScenario(
    scenario: Omit<AppState['scenarios'][number], 'id' | 'createdAt' | 'steps' | 'status'>,
  ) {
    const item = {
      ...scenario,
      id: createId('scenario'),
      status: 'draft' as const,
      steps: [],
      createdAt: now(),
    }
    data.value.scenarios.unshift(item)
    appendAudit({
      action: '新增故障场景',
      target: item.name,
      operator: '当前用户',
      detail: `运行方式：${item.operationMode}，故障类型：${item.faultType}。`,
    })
    await commit('故障场景已创建')
    return item
  }

  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const snapshot = JSON.parse(JSON.stringify(effectiveSettings.value)) as ProtectionSetting[]
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      mode: activeMode.value,
      snapshot,
      checksum: checksum(snapshot),
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: `${note}（方式：${activeMode.value}）`,
    })
    await commit('基线已创建并提交会签')
    return baseline
  }

  async function approveBaseline(id: string) {
    const baseline = data.value.baselines.find((item) => item.id === id)
    if (!baseline) return
    if (data.value.issues.some((issue) => issue.level === 'high' && issue.status !== 'closed')) {
      throw new Error('存在未关闭的高风险问题，不能锁定基线')
    }
    baseline.status = 'locked'
    baseline.lockedAt = now()
    data.value.activeBaselineId = baseline.id
    appendAudit({
      action: '锁定基线',
      target: baseline.version,
      operator: '当前用户',
      detail: `校验码 ${baseline.checksum}。`,
    })
    await commit('基线已锁定')
  }

  async function recordExport(format: string, count: number) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `按「${activeMode.value}」导出 ${count} 条有效定值。`,
    })
    await commit('导出记录已写入审计')
  }

  /** 迁移失败后从断点重试，已拆分的方式不会重复处理 */
  async function retryMigration() {
    const migrated = loadState()
    data.value = migrated
    const state = migrated.migration
    appendAudit({
      action: '旧数据迁移重试',
      target: '定值结构升级',
      operator: '当前用户',
      detail:
        state?.status === 'failed'
          ? `重试仍失败：${state.error ?? '未知原因'}`
          : `断点续传完成，已拆分 ${state?.processedModes.length ?? 0} 个方式。`,
    })
    await commit(state?.status === 'failed' ? '迁移重试失败' : '旧数据迁移完成')
    return state
  }

  /** 演示：把当前数据回写为旧版整份定值结构，再执行拆分迁移 */
  async function simulateLegacyUpgrade() {
    saveState(createLegacyState(data.value))
    const migrated = loadState()
    data.value = migrated
    const state = migrated.migration
    appendAudit({
      action: '旧数据迁移',
      target: '按方式整份定值',
      operator: '当前用户',
      detail:
        state?.status === 'failed'
          ? `迁移中断：${state.error ?? '未知原因'}，断点已保留可重试。`
          : `拆分 ${state?.totalModes.length ?? 0} 个运行方式，生成 ${migrated.overrides.length} 项方式覆盖；历史基线仍按原快照保留。`,
    })
    await commit(state?.status === 'failed' ? '迁移失败，断点已保留' : '旧版数据已升级')
    return state
  }

  async function reset() {
    data.value = createInitialState()
    await commit('已恢复演示数据')
  }

  return {
    data,
    hydrated,
    saving,
    lastMessage,
    devices,
    settings,
    overrides,
    activeMode,
    effectiveSettings,
    issues,
    scenarios,
    pendingReconfirmScenarios,
    migration,
    activeBaseline,
    hydrate,
    addDevice,
    updateDevice,
    switchMode,
    saveSetting,
    clearOverride,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    confirmScenario,
    addScenario,
    createBaseline,
    approveBaseline,
    recordExport,
    retryMigration,
    simulateLegacyUpgrade,
    reset,
  }
})
