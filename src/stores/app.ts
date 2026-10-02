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
  SettingOverride,
  SettingValueField,
  ValidationIssue,
} from '@/types/domain'
import { createInitialState, createLegacyState } from '@/data/mock'
import { validateSettings } from '@/services/validation'
import {
  changedValueFields,
  collapseLegacySettings,
  effectiveSettings as resolveEffectiveSettings,
  extractChanges,
  findOverride,
  isLegacySettings,
  settingFieldLabels,
} from '@/services/settings'
import {
  BASE_MODE,
  finalizeSettings,
  migrateModeToOverrides,
  pendingModes,
} from '@/services/migration'
import { persistState } from '@/api/client'

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

export const useAppStore = defineStore('grid-review', () => {
  const data = ref<AppState>(createInitialState())
  const hydrated = ref(false)
  const saving = ref(false)
  const lastMessage = ref('')

  const devices = computed(() => data.value.devices)
  /** 基础定值；旧数据升级完成前为按基础方式折叠的只读视图 */
  const settings = computed(() =>
    isLegacySettings(data.value.settings)
      ? collapseLegacySettings(data.value.settings, BASE_MODE)
      : data.value.settings,
  )
  const overrides = computed(() => data.value.overrides)
  const activeMode = computed(() => data.value.activeMode)
  /** 当前运行方式下的有效定值：方式覆盖优先，其余字段继承基础定值 */
  const effectiveSettings = computed(() =>
    resolveEffectiveSettings(settings.value, data.value.overrides, data.value.activeMode),
  )
  const migration = computed(() => data.value.migration)
  const migrationActive = computed(
    () =>
      isLegacySettings(data.value.settings) &&
      !!data.value.migration &&
      data.value.migration.status !== 'done',
  )
  const issues = computed(() => data.value.issues)
  const scenarios = computed(() => data.value.scenarios)
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

  function assertEditable() {
    if (migrationActive.value) {
      throw new Error('检测到待升级的旧版定值数据，请先在「审计与导出 → 数据升级」完成拆分')
    }
  }

  /** 基础定值字段变化后，该运行方式下的有效值是否随之变化（未被覆盖的字段才会继承） */
  function effectiveChangedInMode(settingId: string, mode: string, fields: SettingValueField[]) {
    const override = findOverride(data.value.overrides, settingId, mode)
    const covered = new Set(Object.keys(override?.changes ?? {}))
    return fields.some((field) => !covered.has(field))
  }

  /** 某运行方式下引用了该定值（装置或保护对象）的故障场景 */
  function scenariosUsing(setting: ProtectionSetting, mode: string) {
    return data.value.scenarios.filter(
      (scenario) =>
        scenario.operationMode === mode &&
        (scenario.faultDeviceId === setting.protectedDeviceId ||
          scenario.outageDevices.includes(setting.protectedDeviceId) ||
          scenario.steps.some((step) => step.relayId === setting.relayId)),
    )
  }

  /**
   * 把受影响场景退回会签重新确认；动作序列与停电范围原样保留。
   * 返回被退回的场景名称。
   */
  function reconfirmScenarios(
    setting: ProtectionSetting,
    modes: string[],
    reason: string,
  ): string[] {
    const names: string[] = []
    modes.forEach((mode) => {
      scenariosUsing(setting, mode).forEach((scenario) => {
        if (scenario.status === 'approved' || scenario.status === 'locked') {
          scenario.status = 'reviewing'
          scenario.reconfirmReason = reason
          names.push(scenario.name)
        }
      })
    })
    return names
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

  async function saveSetting(setting: ProtectionSetting) {
    assertEditable()
    const index = data.value.settings.findIndex((item) => item.id === setting.id)
    const previous = index >= 0 ? data.value.settings[index] : undefined
    const next = { ...setting, updatedAt: now() }
    if (index >= 0) data.value.settings[index] = next
    else data.value.settings.push(next)

    const changedFields = previous ? changedValueFields(previous, next) : []
    const fieldText = changedFields.map((field) => settingFieldLabels[field]).join('、')
    let reconfirmed: string[] = []
    if (previous && changedFields.length) {
      // 基础值改动后，逐方式检查有效值是否变化（覆盖字段不继承，不受影响），
      // 受影响方式下引用该定值的故障场景退回会签重新确认
      const affectedModes = [...new Set(data.value.scenarios.map((item) => item.operationMode))]
        .filter((mode) => effectiveChangedInMode(next.id, mode, changedFields))
      reconfirmed = reconfirmScenarios(
        next,
        affectedModes,
        `基础定值变更（${fieldText}），需重新确认`,
      )
    }

    appendAudit({
      action: index >= 0 ? '修改基础定值' : '新增定值',
      target: `${setting.relayId} ${setting.stage} 段`,
      operator: '当前用户',
      detail:
        `电流 ${setting.currentA}A，时限 ${setting.timeS}s。` +
        (changedFields.length ? `变更字段：${fieldText}。` : '') +
        (reconfirmed.length
          ? `${reconfirmed.length} 个故障场景需重新确认（${reconfirmed.join('、')}），原动作序列与停电范围已保留。`
          : ''),
    })
    await commit(
      reconfirmed.length
        ? `基础定值已保存，${reconfirmed.length} 个受影响场景已退回会签`
        : '定值已保存',
    )
  }

  /** 保存方式覆盖：只存与基础定值不同的字段；全部一致时改为继承并清除覆盖 */
  async function saveOverride(settingId: string, mode: string, values: ProtectionSetting) {
    assertEditable()
    const base = settings.value.find((item) => item.id === settingId)
    if (!base) throw new Error('未找到对应的基础定值')
    const changes = extractChanges(base, values)
    const existing = findOverride(data.value.overrides, settingId, mode)

    if (!Object.keys(changes).length) {
      if (!existing) return
      data.value.overrides = data.value.overrides.filter((item) => item.id !== existing.id)
      const reconfirmed = reconfirmScenarios(
        base,
        [mode],
        `「${mode}」方式覆盖清除，恢复继承基础定值，需重新确认`,
      )
      appendAudit({
        action: '清除方式覆盖',
        target: `${base.relayId} ${base.stage} 段 @ ${mode}`,
        operator: '当前用户',
        detail:
          `与基础定值一致，已恢复继承。` +
          (reconfirmed.length
            ? `${reconfirmed.length} 个故障场景需重新确认，原动作序列与停电范围已保留。`
            : ''),
      })
      await commit('该方式与基础定值一致，已清除覆盖并恢复继承')
      return
    }

    const override: SettingOverride = {
      id: existing?.id ?? createId('ovr'),
      settingId,
      operationMode: mode,
      changes,
      updatedAt: now(),
    }
    if (existing) {
      data.value.overrides = data.value.overrides.map((item) =>
        item.id === existing.id ? override : item,
      )
    } else {
      data.value.overrides.push(override)
    }
    const reconfirmed = reconfirmScenarios(
      base,
      [mode],
      `「${mode}」方式覆盖变更（${(Object.keys(changes) as SettingValueField[])
        .map((field) => settingFieldLabels[field])
        .join('、')}），需重新确认`,
    )
    const fieldText = (Object.keys(changes) as SettingValueField[])
      .map((field) => settingFieldLabels[field])
      .join('、')
    appendAudit({
      action: existing ? '修改方式覆盖' : '新增方式覆盖',
      target: `${base.relayId} ${base.stage} 段 @ ${mode}`,
      operator: '当前用户',
      detail:
        `覆盖字段：${fieldText}，其余字段继承基础定值。` +
        (reconfirmed.length
          ? `${reconfirmed.length} 个故障场景需重新确认，原动作序列与停电范围已保留。`
          : ''),
    })
    await commit(
      reconfirmed.length
        ? `方式覆盖已保存，${reconfirmed.length} 个受影响场景已退回会签`
        : `已保存 ${mode} 的方式覆盖`,
    )
  }

  async function removeOverride(settingId: string, mode: string) {
    assertEditable()
    const base = settings.value.find((item) => item.id === settingId)
    const existing = findOverride(data.value.overrides, settingId, mode)
    if (!base || !existing) return
    data.value.overrides = data.value.overrides.filter((item) => item.id !== existing.id)
    const reconfirmed = reconfirmScenarios(
      base,
      [mode],
      `「${mode}」方式覆盖清除，恢复继承基础定值，需重新确认`,
    )
    appendAudit({
      action: '清除方式覆盖',
      target: `${base.relayId} ${base.stage} 段 @ ${mode}`,
      operator: '当前用户',
      detail:
        `已恢复继承基础定值。` +
        (reconfirmed.length
          ? `${reconfirmed.length} 个故障场景需重新确认，原动作序列与停电范围已保留。`
          : ''),
    })
    await commit(`已清除 ${mode} 的方式覆盖`)
  }

  /** 切换运行方式：有效定值随之变化，按新方式重新校核 */
  async function switchMode(mode: string) {
    if (mode === data.value.activeMode) return
    if (migrationActive.value) {
      throw new Error('旧版数据升级完成前不能切换运行方式')
    }
    data.value.activeMode = mode
    data.value.issues = validateSettings(effectiveSettings.value, data.value.devices)
    appendAudit({
      action: '切换运行方式',
      target: mode,
      operator: '当前用户',
      detail: `已按「${mode}」合成有效定值并重新校核，生成 ${data.value.issues.length} 条待处理问题。`,
    })
    await commit(`已切换至 ${mode} 并重新校核`)
  }

  async function runValidation() {
    data.value.issues = validateSettings(effectiveSettings.value, data.value.devices)
    appendAudit({
      action: '批量校验',
      target: `全部保护定值（${data.value.activeMode}）`,
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
    // 重新批准/锁定视为已完成重新确认，清除定值变更标记
    if (status === 'approved' || status === 'locked') scenario.reconfirmReason = undefined
    appendAudit({
      action: '场景状态流转',
      target: scenario.name,
      operator: '当前用户',
      detail: `状态更新为 ${status}。`,
    })
    await commit('场景状态已更新')
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

  /** 创建基线：快照与校验码均按当前运行方式的有效定值生成 */
  async function createBaseline(note: string) {
    const nextNumber = data.value.baselines.length + 1
    const effective = effectiveSettings.value
    const baseline: BaselineVersion = {
      id: createId('baseline'),
      version: `V1.${nextNumber - 1}`,
      status: 'reviewing',
      createdAt: now(),
      createdBy: '当前用户',
      note,
      operationMode: data.value.activeMode,
      snapshot: JSON.parse(JSON.stringify(effective)) as ProtectionSetting[],
      checksum: checksum(effective),
    }
    data.value.baselines.unshift(baseline)
    appendAudit({
      action: '创建基线上会签',
      target: baseline.version,
      operator: '当前用户',
      detail: `${note}（运行方式：${data.value.activeMode}）`,
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

  async function recordExport(format: string) {
    appendAudit({
      action: '导出定值清单',
      target: `${format} 文件`,
      operator: '当前用户',
      detail: `按当前运行方式「${data.value.activeMode}」导出 ${effectiveSettings.value.length} 条有效定值。`,
    })
    await commit('导出记录已写入审计')
  }

  /** 载入按运行方式整份存储的旧版演示数据，等待拆分升级 */
  async function loadLegacyDemo() {
    data.value = createLegacyState()
    await commit('已载入旧版演示数据，待拆分升级')
  }

  /**
   * 旧数据拆分升级：把每种运行方式的整份定值逐方式拆成方式覆盖。
   * 每完成一个方式立即持久化断点；失败时保留断点，可从中断方式继续重试。
   * 注意：commit 会整体替换 state，断点每次都要从 data.value 重新读取。
   */
  async function runMigration() {
    if (!data.value.migration || !isLegacySettings(data.value.settings)) return
    const checkpoint = () => {
      const item = data.value.migration
      if (!item) throw new Error('迁移断点状态丢失')
      return item
    }
    data.value.migration = {
      ...checkpoint(),
      status: 'running',
      error: undefined,
      failedMode: undefined,
    }
    await commit('开始拆分旧版定值数据')

    for (const mode of pendingModes(data.value.settings, checkpoint().doneModes)) {
      // 模拟分批处理，便于观察断点；每批完成后才推进断点
      await new Promise((resolve) => window.setTimeout(resolve, 320))
      try {
        const produced = migrateModeToOverrides(data.value.settings, mode)
        data.value.overrides = [
          ...data.value.overrides.filter((item) => item.operationMode !== mode),
          ...produced,
        ]
        checkpoint().doneModes.push(mode)
        checkpoint().updatedAt = now()
        appendAudit({
          action: '拆分运行方式',
          target: mode,
          operator: '当前用户',
          detail: `已把整份定值拆为 ${produced.length} 条方式覆盖，断点进度 ${checkpoint().doneModes.length}/${checkpoint().totalModes}。`,
        })
        await commit(`已拆分 ${mode}`)
      } catch (error) {
        const failed = checkpoint()
        failed.status = 'failed'
        failed.failedMode = mode
        failed.error = error instanceof Error ? error.message : String(error)
        failed.updatedAt = now()
        appendAudit({
          action: '拆分升级中断',
          target: mode,
          operator: '当前用户',
          detail: `${failed.error} 已完成的方式保留在断点中，可重试继续。`,
        })
        await commit('升级中断，断点已保留')
        throw error
      }
    }

    data.value.settings = finalizeSettings(data.value.settings)
    checkpoint().status = 'done'
    checkpoint().updatedAt = now()
    data.value.issues = validateSettings(effectiveSettings.value, data.value.devices)
    appendAudit({
      action: '拆分升级完成',
      target: '基础定值 + 方式覆盖',
      operator: '当前用户',
      detail: `已生成 ${data.value.settings.length} 条基础定值、${data.value.overrides.length} 条方式覆盖，历史基线仍按原快照查看。`,
    })
    await commit('旧数据已拆分为基础定值与方式覆盖')
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
    migration,
    migrationActive,
    issues,
    scenarios,
    activeBaseline,
    hydrate,
    addDevice,
    updateDevice,
    saveSetting,
    saveOverride,
    removeOverride,
    switchMode,
    runValidation,
    updateIssue,
    addComment,
    updateScenarioStatus,
    addScenario,
    createBaseline,
    approveBaseline,
    recordExport,
    loadLegacyDemo,
    runMigration,
    reset,
  }
})
