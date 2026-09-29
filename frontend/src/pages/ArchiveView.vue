<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Back,
  Delete,
  DocumentCopy,
  EditPen,
  FolderOpened,
  RefreshLeft,
  RefreshRight,
  WarnTriangleFilled
} from '@element-plus/icons-vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import StatBadge from '@/components/common/StatBadge.vue'
import { useHallStore } from '@/stores/hallStore'
import { useArchiveStore, ArchiveValidationError } from '@/stores/archiveStore'
import {
  ARCHIVE_ENTITY_LABELS,
  ARCHIVE_ORIGIN_LABELS,
  versionLabel,
  type ArchiveRecord,
  type BrokenRef
} from '@/types/archive'
import { bundleCounts } from '@/utils/archive'

const router = useRouter()
const hallStore = useHallStore()
const archiveStore = useArchiveStore()

/** 档案页默认展示当前选中殿宇；可在下拉中切换 */
const selectedHallId = ref<string | null>(hallStore.currentHallId)

/** 归档 / 刷新草稿被校验拦截时，按草稿 id 存放断链明细，页面逐条指出断开的记录 */
const brokenByDraft = ref<Record<string, BrokenRef[]>>({})
const busyId = ref<string | null>(null)

const selectableHalls = computed(() =>
  [...hallStore.halls].sort((a, b) => b.updatedAt - a.updatedAt)
)

const currentHall = computed(() =>
  selectedHallId.value ? hallStore.hallById(selectedHallId.value) ?? null : null
)

const draft = computed<ArchiveRecord | null>(() =>
  selectedHallId.value ? archiveStore.draftOfHall(selectedHallId.value) : null
)

const snapshots = computed<ArchiveRecord[]>(() =>
  selectedHallId.value ? archiveStore.snapshotsOfHall(selectedHallId.value) : []
)

const currentVersion = computed<ArchiveRecord | null>(() =>
  selectedHallId.value ? archiveStore.currentVersionOfHall(selectedHallId.value) : null
)

/** 其它殿宇仍有档案，便于在切换殿宇之外掌握全局归档进度 */
const hallSummaries = computed(() =>
  selectableHalls.value.map((hall) => {
    const records = archiveStore.recordsOfHall(hall.id)
    return {
      hall,
      draftCount: records.filter((record) => record.kind === 'draft').length,
      snapshotCount: records.filter((record) => record.kind === 'snapshot').length,
      currentVersionId: hall.currentVersionId
    }
  })
)

const totalSnapshots = computed(() =>
  archiveStore.archives.filter((record) => record.kind === 'snapshot').length
)
const totalDrafts = computed(() =>
  archiveStore.archives.filter((record) => record.kind === 'draft').length
)

function selectHall(id: string): void {
  selectedHallId.value = id
  hallStore.setCurrentHall(id)
}

function goElements(): void {
  if (selectedHallId.value) void router.push(`/halls/${selectedHallId.value}/elements`)
}

function countsOf(record: ArchiveRecord) {
  return bundleCounts(record.bundle)
}

function formatTime(ms: number | null): string {
  if (!ms) return '—'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false })
}

/** 草稿与其父版本之间的内容是否已经一致（无变化则无需重复刷新） */
function draftChanged(record: ArchiveRecord): boolean {
  if (!record.parentId) return true
  const parent = archiveStore.archiveById(record.parentId)
  if (!parent) return true
  return JSON.stringify(parent.bundle) !== JSON.stringify(record.bundle)
}

async function createDraft(): Promise<void> {
  if (!selectedHallId.value) return
  busyId.value = 'create'
  try {
    const record = await archiveStore.createDraft({ hallId: selectedHallId.value })
    const broken = await archiveStore.validateDraft(record.id)
    if (broken.length > 0) brokenByDraft.value[record.id] = broken
    ElMessage.success('已建立会审草稿，复查记录将保存在草稿中，不再覆盖原判断')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '建立草稿失败')
  } finally {
    busyId.value = null
  }
}

async function refreshDraft(record: ArchiveRecord): Promise<void> {
  busyId.value = record.id
  try {
    const updated = await archiveStore.refreshDraft(record.id)
    brokenByDraft.value[record.id] = updated.brokenRefs
    ElMessage.success(
      updated.brokenRefs.length > 0
        ? '草稿已刷新整包数据，发现引用断开，请先处理后再归档'
        : '草稿已同步当前殿宇的构件、层位、病害与工序整包数据'
    )
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '刷新草稿失败')
  } finally {
    busyId.value = null
  }
}

async function removeDraft(record: ArchiveRecord): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `将删除会审草稿「${record.title}」，其中未落档的复查记录会一并丢弃；历史快照不受影响。是否继续？`,
    '删除草稿',
    { type: 'warning', confirmButtonText: '删除草稿', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  busyId.value = record.id
  try {
    await archiveStore.removeDraft(record.id)
    delete brokenByDraft.value[record.id]
    ElMessage.success('草稿已删除')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '删除草稿失败')
  } finally {
    busyId.value = null
  }
}

async function archiveDraft(record: ArchiveRecord): Promise<void> {
  const { value: title } = await ElMessageBox.prompt('为本次会审命名（归档后成为不可修改的历史快照）', '归档会审草稿', {
    confirmButtonText: '执行归档',
    cancelButtonText: '取消',
    inputValue: record.title && record.title !== '会审草稿' ? record.title : `第 ${archiveStore.nextSeq(record.hallId)} 次会审`,
    inputValidator: (value: string) => value.trim().length > 0 || '请填写会审名称'
  }).catch(() => ({ value: '' }))
  if (!title) return
  busyId.value = record.id
  try {
    const archived = await archiveStore.archiveDraft(record.id, { title })
    delete brokenByDraft.value[record.id]
    ElMessage.success(`已归档为「${archived.title}」（${versionLabel(archived)}），当前版本指针已更新`)
  } catch (err) {
    if (err instanceof ArchiveValidationError) {
      brokenByDraft.value[record.id] = err.brokenRefs
      ElMessage.error(`归档被拦截：发现 ${err.brokenRefs.length} 处断开的记录，整批未写入任何半成品`)
    } else {
      ElMessage.error(err instanceof Error ? err.message : '归档失败')
    }
  } finally {
    busyId.value = null
  }
}

async function restoreSnapshot(record: ArchiveRecord): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `将用「${record.title}」（${versionLabel(record)}）覆盖该殿宇当前的工作数据：现有构件、层位、病害、工序会被替换为快照内容；该历史快照本身及其后归档的档案均保留。`,
    '恢复为当前版本',
    {
      type: 'warning',
      confirmButtonText: '恢复并继续会审',
      cancelButtonText: '取消',
      distinguishCancelAndClose: true
    }
  ).catch((action: string) => action)
  if (confirmed !== 'confirm') return
  busyId.value = record.id
  try {
    await archiveStore.restoreSnapshot(record.id, { withDraft: true })
    ElMessage.success('已恢复为当前版本，并生成一份「恢复后会审」草稿')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败')
  } finally {
    busyId.value = null
  }
}

/** 断开档案（殿宇主记录已缺失）：直接恢复快照可重建殿宇主记录 */
async function restoreOrphan(record: ArchiveRecord): Promise<void> {
  const confirmed = await ElMessageBox.confirm(
    `档案「${record.hallName} / ${record.title}」的父级殿宇主记录已缺失。恢复将重建殿宇及其整包数据，原档案保留。是否继续？`,
    '重建断开的殿宇',
    { type: 'warning', confirmButtonText: '重建并恢复', cancelButtonText: '取消' }
  ).catch(() => false)
  if (!confirmed) return
  busyId.value = record.id
  try {
    await archiveStore.restoreSnapshot(record.id, { withDraft: false })
    selectedHallId.value = record.hallId
    ElMessage.success('殿宇主记录与整包数据已重建')
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '恢复失败')
  } finally {
    busyId.value = null
  }
}

function brokenList(record: ArchiveRecord): BrokenRef[] {
  return brokenByDraft.value[record.id] ?? record.brokenRefs ?? []
}

function parentTitle(record: ArchiveRecord): string {
  if (!record.parentId) return record.kind === 'snapshot' && record.seq === 0 ? '（版本起点）' : '—'
  const parent = archiveStore.archiveById(record.parentId)
  return parent ? `${versionLabel(parent)} · ${parent.title}` : '（父版本缺失）'
}
</script>

<template>
  <div>
    <div class="page-title">
      <div>
        <h2>会审档案</h2>
        <p>每座殿宇的构件、层位、病害与修复工序整包形成会审草稿；归档后成为不可变历史快照，可随时恢复为当前版本。</p>
      </div>
      <el-button v-if="selectedHallId" :icon="Back" @click="goElements">返回构件与层位</el-button>
    </div>

    <div class="stat-row">
      <StatBadge label="殿宇" :value="hallStore.halls.length" suffix="处" icon="Collection" tone="primary" />
      <StatBadge label="历史快照" :value="totalSnapshots" suffix="版" icon="Files" tone="info" />
      <StatBadge label="会审草稿" :value="totalDrafts" suffix="份" icon="EditPen" tone="warning" />
      <StatBadge label="断开档案" :value="archiveStore.orphanArchives.length" suffix="份" icon="WarnTriangleFilled" tone="danger" />
    </div>

    <div class="section-card">
      <div class="section-card__head">
        <h3>选择殿宇</h3>
        <span class="muted">当前版本指针随归档自动更新</span>
      </div>
      <el-radio-group :model-value="selectedHallId ?? ''" @update:model-value="selectHall">
        <el-radio-button v-for="item in hallSummaries" :key="item.hall.id" :value="item.hall.id">
          {{ item.hall.name }}
          <span class="radio-meta">
            快照 {{ item.snapshotCount }} · 草稿 {{ item.draftCount }}
          </span>
        </el-radio-button>
      </el-radio-group>
    </div>

    <div v-if="!selectedHallId" class="section-card">
      <EmptyPanel
        title="尚未选择殿宇"
        description="请先在殿宇总览选择一座殿宇，或从上方按钮切换；每座殿宇各自维护草稿与版本链。"
        action-text="去殿宇总览"
        @action="router.push('/halls')"
      />
    </div>

    <template v-else>
      <div v-if="!currentHall" class="section-card broken-banner">
        <el-icon><WarnTriangleFilled /></el-icon>
        <span>选中殿宇的主记录已不存在，但下方仍保留它的会审档案，可通过恢复快照重建。</span>
      </div>

      <!-- 会审草稿 -->
      <div class="section-card">
        <div class="section-card__head">
          <h3>会审草稿</h3>
          <el-button v-if="!draft" type="primary" plain :icon="EditPen" :loading="busyId === 'create'" @click="createDraft">
            建立会审草稿
          </el-button>
        </div>

        <div v-if="!draft" class="muted draft-empty">
          尚未建立草稿。复查记录直接改在工作数据上会覆盖原判断；建立草稿后，每次会审的构件、层位、病害与工序整包都可单独留档。
        </div>

        <article v-else class="record-card draft-card">
          <header class="record-card__head">
            <div>
              <div class="record-card__title-row">
                <el-tag type="warning" effect="dark" round>草稿</el-tag>
                <h4>{{ draft.title }}</h4>
                <el-tag size="small" effect="plain">{{ ARCHIVE_ORIGIN_LABELS[draft.origin] }}</el-tag>
                <el-tag v-if="!draftChanged(draft)" size="small" type="success" effect="plain">与父版本一致</el-tag>
              </div>
              <p class="muted">
                基于 {{ parentTitle(draft) }} · 更新于 {{ formatTime(draft.updatedAt) }}
              </p>
            </div>
            <div class="record-card__actions">
              <el-button size="small" :icon="RefreshRight" :loading="busyId === draft.id" @click="refreshDraft(draft)">
                同步当前数据
              </el-button>
              <el-button size="small" type="primary" :icon="FolderOpened" :loading="busyId === draft.id" @click="archiveDraft(draft)">
                归档为历史快照
              </el-button>
              <el-button size="small" type="danger" text :icon="Delete" :loading="busyId === draft.id" @click="removeDraft(draft)">
                弃稿
              </el-button>
            </div>
          </header>

          <div class="record-card__counts">
            <span>构件 <b>{{ countsOf(draft).elements }}</b></span>
            <span>层位 <b>{{ countsOf(draft).layers }}</b></span>
            <span>病害 <b>{{ countsOf(draft).decays }}</b></span>
            <span>工序 <b>{{ countsOf(draft).repairSteps }}</b></span>
          </div>

          <div v-if="brokenList(draft).length > 0" class="broken-panel">
            <div class="broken-panel__head">
              <el-icon><WarnTriangleFilled /></el-icon>
              <strong>发现 {{ brokenList(draft).length }} 处断开的记录，已阻止归档（整批未留下半成品）：</strong>
            </div>
            <ul>
              <li v-for="(ref, index) in brokenList(draft)" :key="`${ref.entity}-${ref.id}-${index}`">
                <el-tag size="small" type="danger" effect="plain">{{ ARCHIVE_ENTITY_LABELS[ref.entity] }}</el-tag>
                <span class="broken-label">{{ ref.label }}</span>
                <code class="mono">{{ ref.field }}={{ ref.id || '（空）' }}</code>
                <span class="muted">{{ ref.message }}</span>
              </li>
            </ul>
          </div>
        </article>
      </div>

      <!-- 历史快照时间线 -->
      <div class="section-card">
        <div class="section-card__head">
          <h3>历史快照</h3>
          <span class="muted">
            当前版本：
            <template v-if="currentVersion">
              <el-tag size="small" type="success" effect="dark">{{ versionLabel(currentVersion) }} · {{ currentVersion.title }}</el-tag>
            </template>
            <template v-else>尚未归档</template>
          </span>
        </div>

        <el-timeline v-if="snapshots.length > 0" class="snapshot-timeline">
          <el-timeline-item
            v-for="record in snapshots"
            :key="record.id"
            :timestamp="formatTime(record.archivedAt)"
            placement="top"
            :type="record.id === currentHall?.currentVersionId ? 'success' : 'primary'"
            :hollow="record.id !== currentHall?.currentVersionId"
          >
            <article class="record-card snapshot-card" :class="{ 'is-current': record.id === currentHall?.currentVersionId }">
              <header class="record-card__head">
                <div>
                  <div class="record-card__title-row">
                    <el-tag :type="record.seq === 0 ? 'info' : 'primary'" effect="dark" round>
                      {{ versionLabel(record) }}
                    </el-tag>
                    <h4>{{ record.title }}</h4>
                    <el-tag size="small" effect="plain">{{ ARCHIVE_ORIGIN_LABELS[record.origin] }}</el-tag>
                    <el-tag v-if="record.id === currentHall?.currentVersionId" size="small" type="success" effect="dark">
                      当前版本
                    </el-tag>
                  </div>
                  <p class="muted">
                    父版本：{{ parentTitle(record) }}
                    <template v-if="record.restoredFromId">
                      · 恢复自 {{ archiveStore.archiveById(record.restoredFromId)?.title ?? '（已缺失）' }}
                    </template>
                    <template v-if="record.sourceExportedAt"> · 旧备份导出于 {{ record.sourceExportedAt }}</template>
                  </p>
                  <p v-if="record.note" class="snapshot-note">{{ record.note }}</p>
                </div>
                <div class="record-card__actions">
                  <el-button size="small" :icon="RefreshLeft" :loading="busyId === record.id" @click="restoreSnapshot(record)">
                    恢复为当前版本
                  </el-button>
                </div>
              </header>
              <div class="record-card__counts">
                <span>构件 <b>{{ countsOf(record).elements }}</b></span>
                <span>层位 <b>{{ countsOf(record).layers }}</b></span>
                <span>病害 <b>{{ countsOf(record).decays }}</b></span>
                <span>工序 <b>{{ countsOf(record).repairSteps }}</b></span>
              </div>
            </article>
          </el-timeline-item>
        </el-timeline>
        <div v-else class="muted draft-empty">该殿宇还没有历史快照。旧备份导入会自动生成「初始版本」，新档案需先建立草稿再归档。</div>
      </div>
    </template>

    <!-- 父级殿宇缺失的断开档案 -->
    <div v-if="archiveStore.orphanArchives.length > 0" class="section-card">
      <div class="section-card__head">
        <h3>断开的档案（{{ archiveStore.orphanArchives.length }} 份）</h3>
        <el-tag type="danger" effect="plain">父级殿宇主记录缺失</el-tag>
      </div>
      <p class="muted">下列档案的殿宇主记录已不在工作数据中，档案本身仍完整保留；可通过恢复重建殿宇，或保留作为历史凭证。</p>
      <div class="orphan-list">
        <article v-for="record in archiveStore.orphanArchives" :key="record.id" class="record-card orphan-card">
          <header class="record-card__head">
            <div>
              <div class="record-card__title-row">
                <el-tag :type="record.kind === 'draft' ? 'warning' : 'info'" effect="plain" round>
                  {{ versionLabel(record) }}
                </el-tag>
                <h4>{{ record.hallName }} / {{ record.title }}</h4>
              </div>
              <p class="muted">
                {{ ARCHIVE_ORIGIN_LABELS[record.origin] }} · {{ formatTime(record.archivedAt ?? record.updatedAt) }}
              </p>
            </div>
            <div class="record-card__actions">
              <el-button
                v-if="record.kind === 'snapshot' && record.bundle.hall"
                size="small"
                type="warning"
                plain
                :icon="DocumentCopy"
                :loading="busyId === record.id"
                @click="restoreOrphan(record)"
              >
                重建殿宇并恢复
              </el-button>
              <el-tag v-else-if="!record.bundle.hall" size="small" type="danger" effect="plain">
                档案包内殿宇主记录缺失，无法恢复
              </el-tag>
            </div>
          </header>
        </article>
      </div>
    </div>
  </div>
</template>

<style scoped>
.radio-meta {
  font-size: 11px;
  color: #8c8479;
  margin-left: 4px;
}

.broken-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #c0392b;
  background: #fdecea;
  border-color: #f2c4bd;
}

.draft-empty {
  font-size: 13px;
  line-height: 1.8;
}

.record-card {
  padding: 14px 16px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: #fffdf9;
}

.draft-card {
  border-style: dashed;
  border-color: #e3c79a;
}

.snapshot-card.is-current {
  border-color: #8fbf8f;
  background: #f6fbf4;
}

.record-card__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.record-card__title-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.record-card__title-row h4 {
  margin: 0;
  font-size: 15px;
}

.record-card__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.record-card__counts {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--line);
  font-size: 13px;
  color: #8c8479;
}

.record-card__counts b {
  color: var(--ink);
  font-variant-numeric: tabular-nums;
}

.snapshot-note {
  margin: 6px 0 0;
  font-size: 12px;
}

.broken-panel {
  margin-top: 12px;
  padding: 12px 14px;
  background: #fdecea;
  border: 1px solid #f2c4bd;
  border-radius: 8px;
}

.broken-panel__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: #c0392b;
  margin-bottom: 8px;
}

.broken-panel ul {
  margin: 0;
  padding-left: 4px;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.broken-panel li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.broken-label {
  font-weight: 600;
}

.broken-panel code {
  padding: 1px 6px;
  background: #fff;
  border: 1px solid #f2c4bd;
  border-radius: 4px;
  font-size: 12px;
}

.snapshot-timeline {
  margin-top: 8px;
  padding-left: 4px;
}

.orphan-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 10px;
}

.orphan-card {
  background: #fff7f5;
  border-color: #f2c4bd;
}
</style>
