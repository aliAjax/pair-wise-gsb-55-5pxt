<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import type { FormInstance, FormRules } from 'element-plus'
import { ElMessage } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import GuardCurveCanvas from '@/components/GuardCurveCanvas.vue'
import { useAppStore } from '@/stores/app'
import { deviceKindLabels, operationModes } from '@/data/mock'
import { effectiveSettings as resolveEffectiveSettings, findOverride } from '@/services/settings'
import type { Device, ProtectionSetting } from '@/types/domain'

const route = useRoute()
const router = useRouter()
const store = useAppStore()
const { devices, settings, effectiveSettings, activeMode, overrides, migrationActive } =
  storeToRefs(store)
const formRef = ref<FormInstance>()
const settingFormRef = ref<FormInstance>()
const settingDialog = ref(false)
/** 定值编辑目标：base 表示基础定值，其余值为运行方式（保存为方式覆盖） */
const editTarget = ref<string>('base')

const deviceId = computed(() => (typeof route.params.id === 'string' ? route.params.id : ''))
const isCreating = computed(() => !deviceId.value || deviceId.value === 'new')
const editingDevice = computed(() => devices.value.find((device) => device.id === deviceId.value))
/** 当前运行方式下的有效定值：覆盖字段优先，其余继承基础定值 */
const relaySettings = computed(() =>
  effectiveSettings.value.filter((setting) => setting.relayId === deviceId.value),
)

const emptyDevice = (): Omit<Device, 'id'> => ({
  code: '',
  name: '',
  kind: 'relay',
  station: '东郊变电站',
  voltage: 110,
  status: 'running',
  operationModes: ['正常方式'],
})

const deviceForm = reactive<Omit<Device, 'id'>>(emptyDevice())
const settingForm = reactive<ProtectionSetting>({
  id: '',
  relayId: deviceId.value,
  protectedDeviceId: '',
  stage: 'I',
  currentA: 5,
  timeS: 0.2,
  direction: 'forward',
  sensitivity: 1.5,
  recloseEnabled: false,
  recloseDelayS: 0,
  startCondition: '相电流越限启动',
  updatedAt: new Date().toISOString(),
})

const deviceRules: FormRules = {
  code: [{ required: true, message: '请输入设备编号', trigger: 'blur' }],
  name: [{ required: true, message: '请输入设备名称', trigger: 'blur' }],
  station: [{ required: true, message: '请输入所属站所', trigger: 'blur' }],
}

const settingRules: FormRules = {
  protectedDeviceId: [{ required: true, message: '请选择保护对象', trigger: 'change' }],
  currentA: [{ required: true, message: '请输入电流定值', trigger: 'blur' }],
  timeS: [{ required: true, message: '请输入动作时限', trigger: 'blur' }],
  sensitivity: [{ required: true, message: '请输入灵敏度', trigger: 'blur' }],
  startCondition: [{ required: true, message: '请输入启动条件', trigger: 'blur' }],
}

const isNewSetting = computed(
  () => !!settingForm.id && !settings.value.some((item) => item.id === settingForm.id),
)
const editingOverride = computed(() =>
  editTarget.value === 'base'
    ? undefined
    : findOverride(overrides.value, settingForm.id, editTarget.value),
)
const overrideModesOf = (settingId: string) =>
  overrides.value.filter((item) => item.settingId === settingId).map((item) => item.operationMode)

watch(
  editingDevice,
  (device) => {
    if (device) {
      Object.assign(deviceForm, {
        code: device.code,
        name: device.name,
        kind: device.kind,
        station: device.station,
        voltage: device.voltage,
        parentId: device.parentId,
        status: device.status,
        operationModes: [...device.operationModes],
      })
    }
  },
  { immediate: true },
)

async function saveDevice() {
  await formRef.value?.validate()
  if (isCreating.value) {
    const created = await store.addDevice({ ...deviceForm, operationModes: [...deviceForm.operationModes] })
    ElMessage.success('设备已创建')
    await router.replace(`/devices/${created.id}`)
    return
  }
  if (!editingDevice.value) return
  await store.updateDevice({
    ...editingDevice.value,
    ...deviceForm,
    operationModes: [...deviceForm.operationModes],
  })
  ElMessage.success('设备信息已保存')
}

/** 按编辑目标载入表单：基础定值取基础值，方式覆盖取该方式的有效值（基础 + 已有覆盖） */
function loadSettingForm(id: string, target: string) {
  const base = settings.value.find((item) => item.id === id)
  if (!base) return
  const source =
    target === 'base'
      ? base
      : (resolveEffectiveSettings(settings.value, overrides.value, target).find(
          (item) => item.id === id,
        ) ?? base)
  Object.assign(settingForm, source)
}

watch(editTarget, (target) => {
  if (!isNewSetting.value) loadSettingForm(settingForm.id, target)
})

function openSetting(setting?: ProtectionSetting) {
  if (setting) {
    editTarget.value = 'base'
    loadSettingForm(setting.id, 'base')
  } else {
    editTarget.value = 'base'
    Object.assign(settingForm, {
      id: `set-${Date.now()}`,
      relayId: deviceId.value,
      protectedDeviceId: editingDevice.value?.parentId ?? '',
      stage: 'I',
      currentA: 5,
      timeS: 0.2,
      direction: 'forward',
      sensitivity: 1.5,
      recloseEnabled: false,
      recloseDelayS: 0,
      startCondition: '相电流越限启动',
      updatedAt: new Date().toISOString(),
    })
  }
  settingDialog.value = true
}

async function saveSetting() {
  await settingFormRef.value?.validate()
  try {
    if (editTarget.value === 'base') {
      await store.saveSetting({ ...settingForm, relayId: deviceId.value })
      ElMessage.success('基础定值已保存，未覆盖的方式将自动继承')
    } else {
      await store.saveOverride(settingForm.id, editTarget.value, {
        ...settingForm,
        relayId: deviceId.value,
      })
      ElMessage.success(`已保存「${editTarget.value}」方式覆盖，仅差异字段生效`)
    }
    settingDialog.value = false
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '定值保存失败')
  }
}

async function clearOverride() {
  if (editTarget.value === 'base') return
  try {
    await store.removeOverride(settingForm.id, editTarget.value)
    ElMessage.success('已清除该方式覆盖，恢复继承基础定值')
    loadSettingForm(settingForm.id, editTarget.value)
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '清除覆盖失败')
  }
}
</script>

<template>
  <div>
    <PageHeader
      :title="isCreating ? '新增设备' : `编辑 ${editingDevice?.name ?? '设备'}`"
      description="维护设备层级、运行方式与保护装置定值；定值按「基础定值 + 方式覆盖」存储，未覆盖字段自动继承。"
    >
      <template #actions>
        <el-button @click="router.push('/devices')">返回台账</el-button>
        <el-button type="primary" :loading="store.saving" @click="saveDevice">保存设备</el-button>
      </template>
    </PageHeader>

    <el-alert
      v-if="migrationActive"
      title="检测到待升级的旧版定值数据，升级完成前定值只读。请前往「审计与导出 → 数据升级」执行拆分。"
      type="warning"
      :closable="false"
      show-icon
      style="margin-bottom: 16px"
    />

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>设备属性</h3></div>
        <el-form ref="formRef" :model="deviceForm" :rules="deviceRules" label-width="110px">
          <el-form-item label="设备编号" prop="code">
            <el-input v-model="deviceForm.code" placeholder="例如 PR-L301" />
          </el-form-item>
          <el-form-item label="设备名称" prop="name">
            <el-input v-model="deviceForm.name" placeholder="输入设备中文名称" />
          </el-form-item>
          <el-form-item label="设备类型" prop="kind">
            <el-select v-model="deviceForm.kind" style="width: 100%">
              <el-option v-for="(label, value) in deviceKindLabels" :key="value" :label="label" :value="value" />
            </el-select>
          </el-form-item>
          <el-form-item label="所属站所" prop="station">
            <el-input v-model="deviceForm.station" />
          </el-form-item>
          <el-form-item label="电压等级" prop="voltage">
            <el-input-number v-model="deviceForm.voltage" :min="10" :max="1000" :step="5" />
            <span class="form-note"> kV</span>
          </el-form-item>
          <el-form-item label="上级设备">
            <el-select v-model="deviceForm.parentId" clearable placeholder="无" style="width: 100%">
              <el-option
                v-for="device in devices.filter((item) => item.id !== deviceId)"
                :key="device.id"
                :label="`${device.name} (${device.code})`"
                :value="device.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="运行状态">
            <el-radio-group v-model="deviceForm.status">
              <el-radio-button value="running">运行</el-radio-button>
              <el-radio-button value="maintenance">检修</el-radio-button>
              <el-radio-button value="stopped">停用</el-radio-button>
            </el-radio-group>
          </el-form-item>
          <el-form-item label="运行方式">
            <el-select v-model="deviceForm.operationModes" multiple style="width: 100%">
              <el-option v-for="mode in operationModes" :key="mode" :label="mode" :value="mode" />
            </el-select>
          </el-form-item>
        </el-form>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>配合曲线预览</h3>
          <el-tag effect="plain">当前方式：{{ activeMode }}</el-tag>
        </div>
        <GuardCurveCanvas :settings="relaySettings" :selected-relay-id="deviceId" />
        <p class="form-note">
          曲线按当前运行方式的有效定值绘制（方式覆盖优先，其余继承基础定值）。滚轮调整时间轴，按住 Shift 滚轮调整电流轴。
        </p>
      </section>
    </div>

    <section v-if="!isCreating && editingDevice?.kind === 'relay'" class="panel">
      <div class="panel-title">
        <div>
          <h3>保护定值</h3>
          <span class="muted">当前方式：{{ activeMode }}，表格显示该方式有效值</span>
        </div>
        <el-button type="primary" :disabled="migrationActive" @click="openSetting()">新增定值段</el-button>
      </div>
      <el-table :data="relaySettings">
        <el-table-column prop="stage" label="段位" width="70" />
        <el-table-column label="保护对象" min-width="150">
          <template #default="{ row }">
            {{ devices.find((device) => device.id === row.protectedDeviceId)?.name ?? row.protectedDeviceId }}
          </template>
        </el-table-column>
        <el-table-column prop="currentA" label="电流定值(A)" width="110" />
        <el-table-column prop="timeS" label="时限(s)" width="90" />
        <el-table-column prop="direction" label="方向" width="110" />
        <el-table-column prop="sensitivity" label="灵敏度" width="90" />
        <el-table-column label="重合闸" width="100">
          <template #default="{ row }">
            {{ row.recloseEnabled ? `${row.recloseDelayS}s` : '退出' }}
          </template>
        </el-table-column>
        <el-table-column prop="startCondition" label="启动条件" min-width="150" />
        <el-table-column label="方式覆盖" min-width="150">
          <template #default="{ row }">
            <el-tag
              v-if="overrideModesOf(row.id).includes(activeMode)"
              type="warning"
              effect="plain"
              size="small"
            >
              当前方式已覆盖
            </el-tag>
            <el-tag
              v-else-if="overrideModesOf(row.id).length"
              type="info"
              effect="plain"
              size="small"
            >
              {{ overrideModesOf(row.id).length }} 种方式覆盖
            </el-tag>
            <span v-else class="muted">继承基础</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :disabled="migrationActive" @click="openSetting(row)">编辑</el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog
      v-model="settingDialog"
      :title="editTarget === 'base' ? '基础定值段' : `方式覆盖 · ${editTarget}`"
      width="560px"
    >
      <el-form ref="settingFormRef" :model="settingForm" :rules="settingRules" label-width="110px">
        <el-form-item v-if="!isNewSetting" label="编辑范围">
          <el-radio-group v-model="editTarget">
            <el-radio-button value="base">基础定值</el-radio-button>
            <el-radio-button v-for="mode in operationModes" :key="mode" :value="mode">
              {{ mode }}
            </el-radio-button>
          </el-radio-group>
          <p class="form-note" style="width: 100%">
            基础定值改动会被未覆盖的方式自动继承；方式覆盖只保存与基础定值不同的字段。
          </p>
        </el-form-item>
        <el-alert
          v-if="editTarget !== 'base'"
          :title="editingOverride ? '该方式已有覆盖，保存时仅更新差异字段。' : '该方式暂无覆盖，当前显示继承自基础定值的有效值。'"
          type="info"
          :closable="false"
          show-icon
          style="margin-bottom: 14px"
        />
        <el-form-item label="段位">
          <el-radio-group v-model="settingForm.stage" :disabled="editTarget !== 'base'">
            <el-radio-button value="I">I 段</el-radio-button>
            <el-radio-button value="II">II 段</el-radio-button>
            <el-radio-button value="III">III 段</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="保护对象" prop="protectedDeviceId">
          <el-select v-model="settingForm.protectedDeviceId" style="width: 100%" :disabled="editTarget !== 'base'">
            <el-option
              v-for="device in devices.filter((item) => item.kind !== 'relay')"
              :key="device.id"
              :label="`${device.name} (${device.code})`"
              :value="device.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="电流定值" prop="currentA">
          <el-input-number v-model="settingForm.currentA" :min="0.1" :max="100" :step="0.1" />
          <span class="form-note"> A</span>
        </el-form-item>
        <el-form-item label="动作时限" prop="timeS">
          <el-input-number v-model="settingForm.timeS" :min="0" :max="10" :step="0.05" />
          <span class="form-note"> s</span>
        </el-form-item>
        <el-form-item label="方向">
          <el-select v-model="settingForm.direction" style="width: 100%">
            <el-option label="正向" value="forward" />
            <el-option label="反向" value="reverse" />
            <el-option label="无方向" value="non-directional" />
          </el-select>
        </el-form-item>
        <el-form-item label="灵敏度" prop="sensitivity">
          <el-input-number v-model="settingForm.sensitivity" :min="0.5" :max="5" :step="0.01" />
        </el-form-item>
        <el-form-item label="重合闸">
          <el-switch v-model="settingForm.recloseEnabled" />
          <el-input-number
            v-if="settingForm.recloseEnabled"
            v-model="settingForm.recloseDelayS"
            :min="0"
            :max="20"
            :step="0.1"
            style="margin-left: 12px"
          />
          <span v-if="settingForm.recloseEnabled" class="form-note"> s</span>
        </el-form-item>
        <el-form-item label="启动条件" prop="startCondition">
          <el-input v-model="settingForm.startCondition" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button
          v-if="editTarget !== 'base' && editingOverride"
          type="danger"
          plain
          @click="clearOverride"
        >
          清除该方式覆盖
        </el-button>
        <el-button @click="settingDialog = false">取消</el-button>
        <el-button type="primary" @click="saveSetting">
          {{ editTarget === 'base' ? '保存基础定值' : '保存方式覆盖' }}
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>
