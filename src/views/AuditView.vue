<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useExportMutation } from '@/api/queries'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { data, effectiveSettings, activeMode, migration } = storeToRefs(store)
const exportMutation = useExportMutation()
const keyword = ref('')
const action = ref('')
const preview = ref('')

const actions = computed(() => [...new Set(data.value.audit.map((item) => item.action))])
const filtered = computed(() =>
  data.value.audit.filter((item) => {
    const matchesKeyword =
      !keyword.value ||
      `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.value.toLowerCase())
    return matchesKeyword && (!action.value || item.action === action.value)
  }),
)

async function exportList() {
  const content = await exportMutation.mutateAsync()
  preview.value = content
  const blob = new Blob([`\ufeff${content}`], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `保护定值清单-${activeMode.value}-${new Date().toISOString().slice(0, 10)}.csv`
  anchor.click()
  URL.revokeObjectURL(url)
  await store.recordExport('CSV', effectiveSettings.value.length)
  ElMessage.success(`已按「${activeMode.value}」导出有效定值并写入审计`)
}

const migrationStatusText = computed(() => {
  const status = migration.value?.status
  if (!status) return '已是最新结构'
  return { running: '迁移进行中', failed: '迁移失败（断点已保留）', done: '迁移已完成' }[status]
})

async function retryMigration() {
  const state = await store.retryMigration()
  if (state?.status === 'failed') {
    ElMessage.error(`迁移重试仍失败：${state.error ?? '未知原因'}，断点继续保留`)
  } else {
    ElMessage.success('旧数据迁移已完成')
  }
}

async function simulateLegacyUpgrade() {
  await ElMessageBox.confirm(
    '将把当前数据回写为旧版「按方式整份定值」结构，并立即执行拆分迁移（历史基线快照保持原样）。',
    '模拟旧版数据升级',
    { confirmButtonText: '开始迁移', cancelButtonText: '取消', type: 'warning' },
  )
  const state = await store.simulateLegacyUpgrade()
  if (state?.status === 'failed') {
    ElMessage.error(`迁移中断：${state.error ?? '未知原因'}，可从断点重试`)
  } else {
    ElMessage.success('旧版整份定值已拆分为基础定值 + 方式覆盖')
  }
}

async function resetData() {
  await ElMessageBox.confirm('将清除当前浏览器内的修改并恢复演示数据。', '恢复演示数据', {
    confirmButtonText: '确认恢复',
    cancelButtonText: '取消',
    type: 'warning',
  })
  await store.reset()
  preview.value = ''
  ElMessage.success('演示数据已恢复')
}
</script>

<template>
  <div>
    <PageHeader
      title="审计与导出"
      description="追踪设备、定值、问题、场景、基线和导出操作，生成可核对的定值清单。"
    >
      <template #actions>
        <el-button @click="resetData">恢复演示数据</el-button>
        <el-button type="primary" :loading="exportMutation.isPending.value" @click="exportList">
          导出定值清单
        </el-button>
      </template>
    </PageHeader>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜索操作、对象或说明" clearable style="width: 280px" />
      <el-select v-model="action" placeholder="操作类型" clearable style="width: 180px">
        <el-option v-for="item in actions" :key="item" :label="item" :value="item" />
      </el-select>
      <span class="grow" />
      <span class="muted">共 {{ filtered.length }} 条审计记录</span>
    </div>

    <div class="two-column">
      <section class="panel">
        <div class="panel-title"><h3>操作审计日志</h3></div>
        <el-table :data="filtered" max-height="620">
          <el-table-column label="时间" width="170">
            <template #default="{ row }">{{ new Date(row.createdAt).toLocaleString('zh-CN') }}</template>
          </el-table-column>
          <el-table-column prop="action" label="操作" width="130" />
          <el-table-column prop="target" label="对象" min-width="180" />
          <el-table-column prop="operator" label="操作人" width="95" />
          <el-table-column prop="detail" label="说明" min-width="260" />
        </el-table>
      </section>

      <section class="panel">
        <div class="panel-title">
          <h3>导出预览</h3>
          <el-tag effect="plain">{{ effectiveSettings.length }} 条有效定值 · {{ activeMode }}</el-tag>
        </div>
        <el-input
          v-if="preview"
          v-model="preview"
          type="textarea"
          :rows="24"
          readonly
          class="mono"
        />
        <el-empty v-else description="点击右上角导出后在此预览 CSV 内容" />
        <el-alert
          title="导出内容按当前运行方式的有效定值生成（基础定值 + 本方式覆盖），数据保存在当前浏览器。"
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
      </section>
    </div>

    <section class="panel">
      <div class="panel-title">
        <div>
          <h3>旧数据迁移</h3>
          <span class="muted">按方式整份保存的定值拆分为「基础定值 + 方式覆盖」，失败保留断点可重试</span>
        </div>
        <el-tag
          :type="migration?.status === 'failed' ? 'danger' : migration?.status === 'running' ? 'warning' : 'success'"
          effect="plain"
        >
          {{ migrationStatusText }}
        </el-tag>
      </div>
      <template v-if="migration">
        <el-descriptions :column="4" border>
          <el-descriptions-item label="待拆分方式">
            {{ migration.totalModes.join('、') || '无' }}
          </el-descriptions-item>
          <el-descriptions-item label="已完成断点">
            {{ migration.processedModes.join('、') || '尚未开始' }}
          </el-descriptions-item>
          <el-descriptions-item label="更新时间">
            {{ new Date(migration.updatedAt).toLocaleString('zh-CN') }}
          </el-descriptions-item>
          <el-descriptions-item label="失败原因">
            {{ migration.error ?? '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
      <el-alert
        v-if="migration?.status === 'failed'"
        :title="`迁移在方式断点处中断：${migration.error ?? '未知原因'}。已完成的方式不会重复拆分，可从断点重试。`"
        type="error"
        :closable="false"
        show-icon
        style="margin-top: 12px"
      />
      <div style="margin-top: 12px; display: flex; gap: 10px">
        <el-button
          v-if="migration?.status === 'failed'"
          type="primary"
          :loading="store.saving"
          @click="retryMigration"
        >
          从断点重试迁移
        </el-button>
        <el-button :loading="store.saving" @click="simulateLegacyUpgrade">
          模拟旧版数据升级（演示）
        </el-button>
      </div>
    </section>
  </div>
</template>
