<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import PageHeader from '@/components/PageHeader.vue'
import { useExportMutation } from '@/api/queries'
import { useAppStore } from '@/stores/app'

const store = useAppStore()
const { data, migration, activeMode } = storeToRefs(store)
const exportMutation = useExportMutation()
const keyword = ref('')
const action = ref('')
const preview = ref('')
const migrating = ref(false)

const actions = computed(() => [...new Set(data.value.audit.map((item) => item.action))])
const filtered = computed(() =>
  data.value.audit.filter((item) => {
    const matchesKeyword =
      !keyword.value ||
      `${item.action}${item.target}${item.detail}`.toLowerCase().includes(keyword.value.toLowerCase())
    return matchesKeyword && (!action.value || item.action === action.value)
  }),
)

const migrationStatusText = computed(() => {
  const status = migration.value?.status
  if (!status) return '无需升级'
  return { pending: '待升级', running: '升级中', failed: '升级中断', done: '已完成' }[status]
})
const migrationPercent = computed(() => {
  const item = migration.value
  if (!item || !item.totalModes) return item?.status === 'done' ? 100 : 0
  return Math.round((item.doneModes.length / item.totalModes) * 100)
})

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
  await store.recordExport('CSV')
  ElMessage.success(`已按当前方式「${activeMode.value}」导出并写入审计`)
}

async function runMigration() {
  migrating.value = true
  try {
    await store.runMigration()
    ElMessage.success('旧数据已拆分为基础定值与方式覆盖')
  } catch (error) {
    ElMessage.error(
      `${error instanceof Error ? error.message : '升级失败'}；断点已保留，可重试继续`,
    )
  } finally {
    migrating.value = false
  }
}

async function loadLegacyDemo() {
  await ElMessageBox.confirm(
    '将用「按运行方式各存一整份定值」的旧版演示数据覆盖当前数据，用于验证拆分升级流程。',
    '载入旧版演示数据',
    { confirmButtonText: '确认载入', cancelButtonText: '取消', type: 'warning' },
  )
  await store.loadLegacyDemo()
  preview.value = ''
  ElMessage.success('旧版演示数据已载入，可执行拆分升级')
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
      description="追踪设备、定值、问题、场景、基线和导出操作，按当前运行方式生成可核对的定值清单。"
    >
      <template #actions>
        <el-button @click="resetData">恢复演示数据</el-button>
        <el-button type="primary" :loading="exportMutation.isPending.value" @click="exportList">
          导出定值清单（{{ activeMode }}）
        </el-button>
      </template>
    </PageHeader>

    <section class="panel">
      <div class="panel-title">
        <div>
          <h3>旧数据升级</h3>
          <span class="muted">把按运行方式整份存储的定值拆分为「基础定值 + 方式覆盖」，历史基线仍按原快照查看</span>
        </div>
        <el-tag
          :type="migration?.status === 'done' ? 'success' : migration?.status === 'failed' ? 'danger' : 'info'"
          effect="plain"
        >
          {{ migrationStatusText }}
        </el-tag>
      </div>
      <template v-if="migration">
        <el-progress :percentage="migrationPercent" :status="migration.status === 'failed' ? 'exception' : undefined" />
        <p class="muted">
          断点进度：{{ migration.doneModes.length }} / {{ migration.totalModes }} 种方式
          <template v-if="migration.doneModes.length">（已完成：{{ migration.doneModes.join('、') }}）</template>
        </p>
        <el-alert
          v-if="migration.status === 'failed'"
          :title="`升级到「${migration.failedMode}」时中断：${migration.error}`"
          description="已完成的方式保留在断点中，点击重试将从中断处继续，不会重复拆分。"
          type="error"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        />
        <el-button
          v-if="migration.status !== 'done'"
          type="primary"
          :loading="migrating"
          @click="runMigration"
        >
          {{ migration.status === 'failed' ? '从断点重试' : '开始拆分升级' }}
        </el-button>
        <el-alert
          v-else
          title="拆分完成：各方式只保留与基础定值不同的字段，其余字段继承基础定值。"
          type="success"
          :closable="false"
          show-icon
          style="margin-bottom: 12px"
        />
        <el-button v-if="migration.status === 'done'" @click="loadLegacyDemo">再次载入旧版演示数据</el-button>
      </template>
      <template v-else>
        <p class="muted">当前数据已是「基础定值 + 方式覆盖」结构，无需升级。</p>
        <el-button @click="loadLegacyDemo">载入旧版演示数据</el-button>
      </template>
    </section>

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
          <el-tag effect="plain">{{ activeMode }} · 有效定值</el-tag>
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
          title="导出内容按当前运行方式合成有效定值（方式覆盖优先，其余继承基础定值），不会上传到后端。"
          type="info"
          :closable="false"
          show-icon
          style="margin-top: 12px"
        />
      </section>
    </div>
  </div>
</template>
