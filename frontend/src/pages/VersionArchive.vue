<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Files,
  Delete,
  Edit,
  Refresh,
  WarningFilled,
  Plus
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useHallStore } from '@/stores/hallStore'
import { useVersionStore } from '@/stores/versionStore'
import { useRepairStore } from '@/stores/repairStore'
import { detectBrokenRefs } from '@/utils/version'
import type { ArchiveVersion } from '@/types/version'

const hallStore = useHallStore()
const versionStore = useVersionStore()
const repairStore = useRepairStore()

const creatingForHall = ref<string | null>(null)
const draftNote = ref('')
const archivingId = ref<string | null>(null)
const restoringId = ref<string | null>(null)

/** 全量数据中的断开引用 */
const brokenRefs = computed(() =>
  detectBrokenRefs(
    hallStore.halls,
    hallStore.elements,
    hallStore.layers,
    hallStore.decays,
    repairStore.steps
  )
)

const hasBroken = computed(() => brokenRefs.value.length > 0)

/** 每座殿宇的版本数量统计 */
const hallVersionStats = computed(() => {
  const map: Record<string, { drafts: number; archived: number }> = {}
  hallStore.halls.forEach((hall) => {
    const versions = versionStore.versionsOfHall(hall.id)
    map[hall.id] = {
      drafts: versions.filter((v) => v.status === 'draft').length,
      archived: versions.filter((v) => v.status === 'archived').length
    }
  })
  return map
})

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function snapshotCounts(version: ArchiveVersion): string {
  const s = version.snapshot
  return `构件 ${s.elements.length} · 层位 ${s.layers.length} · 病害 ${s.decays.length} · 工序 ${s.repairSteps.length}`
}

function startCreateDraft(hallId: string): void {
  creatingForHall.value = hallId
  draftNote.value = ''
}

async function confirmCreateDraft(): Promise<void> {
  if (!creatingForHall.value) return
  const hallId = creatingForHall.value
  try {
    const version = await versionStore.createDraft(hallId, draftNote.value)
    ElMessage.success(`已为「${hallStore.hallById(hallId)?.name ?? ''}」创建第 ${version.versionNo} 次会审草稿`)
    creatingForHall.value = null
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '创建草稿失败')
  }
}

async function archiveDraft(version: ArchiveVersion): Promise<void> {
  const hallName = hallStore.hallById(version.hallId)?.name ?? ''
  try {
    await ElMessageBox.confirm(
      `归档后该草稿将固化为历史快照，不可再编辑。确认归档「${hallName}」第 ${version.versionNo} 次会审草稿？`,
      '归档确认',
      { type: 'warning', confirmButtonText: '确认归档', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  archivingId.value = version.id
  try {
    await versionStore.archiveVersion(version.id)
    ElMessage.success(`已归档为历史快照（第 ${version.versionNo} 版）`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '归档失败')
  } finally {
    archivingId.value = null
  }
}

async function refreshDraft(version: ArchiveVersion): Promise<void> {
  try {
    await versionStore.refreshDraft(version.id)
    ElMessage.success('草稿快照已刷新为当前数据')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '刷新失败')
  }
}

async function restoreVersion(version: ArchiveVersion): Promise<void> {
  const hallName = hallStore.hallById(version.hallId)?.name ?? ''
  try {
    await ElMessageBox.confirm(
      `将用第 ${version.versionNo} 版快照覆盖「${hallName}」的当前工作数据，原快照与后续档案仍保留。是否继续？`,
      '恢复确认',
      { type: 'warning', confirmButtonText: '确认恢复', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  restoringId.value = version.id
  try {
    await versionStore.restoreVersion(version.id)
    ElMessage.success(`已恢复为第 ${version.versionNo} 版快照`)
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败')
  } finally {
    restoringId.value = null
  }
}

async function deleteVersion(version: ArchiveVersion): Promise<void> {
  const hallName = hallStore.hallById(version.hallId)?.name ?? ''
  const label = version.status === 'archived' ? '历史快照' : '草稿'
  try {
    await ElMessageBox.confirm(
      `确认删除「${hallName}」第 ${version.versionNo} 版${label}？此操作不可撤销。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '确认删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  await versionStore.deleteVersion(version.id)
  ElMessage.success(`已删除第 ${version.versionNo} 版${label}`)
}

async function editNote(version: ArchiveVersion): Promise<void> {
  try {
    const { value } = await ElMessageBox.prompt('请输入版本说明', '编辑说明', {
      inputValue: version.note,
      confirmButtonText: '保存',
      cancelButtonText: '取消'
    })
    if (value !== null) {
      await versionStore.updateNote(version.id, value)
      ElMessage.success('版本说明已更新')
    }
  } catch {
    // 用户取消
  }
}

onMounted(() => {
  // 数据由 liveQuery 自动订阅，无需手动加载
})
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>档案版本</h2>
        <p>每座殿宇的构件、层位、病害与修复工序一起形成草稿版本，归档后成为历史快照；快照可恢复为当前版本。</p>
      </div>
    </div>

    <div class="stat-row">
      <StatBadge label="殿宇" :value="hallStore.halls.length" suffix="处" icon="OfficeBuilding" tone="primary" />
      <StatBadge label="草稿版本" :value="versionStore.versions.filter((v) => v.status === 'draft').length" suffix="份" icon="Edit" tone="info" />
      <StatBadge label="历史快照" :value="versionStore.versions.filter((v) => v.status === 'archived').length" suffix="份" icon="Files" tone="success" />
      <StatBadge label="断开引用" :value="brokenRefs.length" suffix="处" icon="WarningFilled" tone="danger" />
    </div>

    <div v-if="hasBroken" class="section-card broken-warn">
      <div class="broken-warn__head">
        <el-icon><WarningFilled /></el-icon>
        <strong>检测到 {{ brokenRefs.length }} 处断开的引用记录</strong>
      </div>
      <p class="muted">以下记录指向了不存在的父级数据，归档时会被拦截。请先修复引用关系。</p>
      <ul class="broken-list">
        <li v-for="(item, index) in brokenRefs" :key="index" class="broken-list__item">
          <el-tag size="small" type="danger" effect="plain">{{ item.childTable }}</el-tag>
          <span>{{ item.message }}</span>
        </li>
      </ul>
    </div>

    <div v-if="hallStore.halls.length === 0" class="section-card">
      <EmptyPanel
        title="暂无殿宇档案"
        description="请先在殿宇总览中创建殿宇并录入构件、层位、病害与修复工序，然后在此建立会审草稿版本。"
        action-text="前往殿宇总览"
        @action="$router.push('/halls')"
      />
    </div>

    <div v-for="hall in hallStore.halls" :key="hall.id" class="section-card hall-archive">
      <div class="hall-archive__head">
        <div>
          <h3>{{ hall.name }}</h3>
          <p class="muted">
            {{ hall.era }} · {{ hall.structureType }} · {{ hall.roofType }}顶 ·
            草稿 {{ hallVersionStats[hall.id]?.drafts ?? 0 }} · 快照 {{ hallVersionStats[hall.id]?.archived ?? 0 }}
          </p>
        </div>
        <el-button type="primary" plain size="small" :icon="Plus" @click="startCreateDraft(hall.id)">
          新建会审草稿
        </el-button>
      </div>

      <div v-if="creatingForHall === hall.id" class="create-draft">
        <el-input v-model="draftNote" placeholder="版本说明（会审场次、复查事由等）" maxlength="60" show-word-limit />
        <div class="create-draft__actions">
          <el-button size="small" type="primary" @click="confirmCreateDraft">创建草稿</el-button>
          <el-button size="small" @click="creatingForHall = null">取消</el-button>
        </div>
      </div>

      <!-- 草稿版本 -->
      <div
        v-for="version in versionStore.draftsOfHall(hall.id)"
        :key="version.id"
        class="version-card is-draft"
      >
        <div class="version-card__head">
          <div class="version-card__title">
            <el-tag size="small" type="info" effect="plain">草稿</el-tag>
            <strong>第 {{ version.versionNo }} 版</strong>
            <span class="muted version-card__note">{{ version.note }}</span>
          </div>
          <div class="version-card__actions">
            <el-button size="small" text :icon="Edit" @click="editNote(version)">说明</el-button>
            <el-button size="small" text :icon="Refresh" @click="refreshDraft(version)">刷新快照</el-button>
            <el-button size="small" type="primary" text :icon="Files" :loading="archivingId === version.id" @click="archiveDraft(version)">
              归档
            </el-button>
            <el-button size="small" type="danger" text :icon="Delete" @click="deleteVersion(version)">删除</el-button>
          </div>
        </div>
        <p class="version-card__meta muted">
          创建于 {{ formatTime(version.createdAt) }} · {{ snapshotCounts(version) }}
        </p>
      </div>

      <!-- 已归档版本 -->
      <div
        v-for="version in versionStore.archivedOfHall(hall.id)"
        :key="version.id"
        class="version-card is-archived"
      >
        <div class="version-card__head">
          <div class="version-card__title">
            <el-tag size="small" type="success" effect="plain">已归档</el-tag>
            <strong>第 {{ version.versionNo }} 版</strong>
            <span class="muted version-card__note">{{ version.note }}</span>
          </div>
          <div class="version-card__actions">
            <el-button size="small" text :icon="Edit" @click="editNote(version)">说明</el-button>
            <el-button size="small" type="primary" text :icon="Refresh" :loading="restoringId === version.id" @click="restoreVersion(version)">
              恢复为当前版本
            </el-button>
            <el-button size="small" type="danger" text :icon="Delete" @click="deleteVersion(version)">删除</el-button>
          </div>
        </div>
        <p class="version-card__meta muted">
          归档于 {{ formatTime(version.archivedAt) }} · {{ snapshotCounts(version) }}
        </p>
      </div>

      <EmptyPanel
        v-if="versionStore.versionsOfHall(hall.id).length === 0 && creatingForHall !== hall.id"
        compact
        title="暂无版本档案"
        description="点击「新建会审草稿」捕获当前殿宇数据，归档后成为历史快照。"
        action-text="新建会审草稿"
        @action="startCreateDraft(hall.id)"
      />
    </div>
  </div>
</template>

<style scoped>
.broken-warn {
  background: #fdecea;
  border-color: #f2c4bd;
}

.broken-warn__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #c0392b;
}

.broken-warn__head strong {
  color: #c0392b;
}

.broken-list {
  margin: 8px 0 0;
  padding: 0;
  list-style: none;
}

.broken-list__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  font-size: 13px;
  color: #8c8479;
}

.hall-archive {
  margin-bottom: 16px;
}

.hall-archive__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.hall-archive__head h3 {
  margin: 0;
  font-size: 16px;
}

.hall-archive__head p {
  margin: 2px 0 0;
  font-size: 12px;
}

.create-draft {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  margin-bottom: 12px;
  background: #faf7f1;
  border: 1px dashed #ddd3c2;
  border-radius: 8px;
}

.create-draft__actions {
  display: flex;
  gap: 8px;
}

.version-card {
  padding: 12px 14px;
  margin-bottom: 8px;
  background: #fbf9f5;
  border: 1px solid #e6e0d6;
  border-radius: 8px;
}

.version-card.is-draft {
  border-left: 3px solid #4a6fa5;
}

.version-card.is-archived {
  border-left: 3px solid #1e8449;
}

.version-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.version-card__title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.version-card__note {
  font-size: 13px;
}

.version-card__actions {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.version-card__meta {
  margin: 6px 0 0;
  font-size: 12px;
}
</style>
