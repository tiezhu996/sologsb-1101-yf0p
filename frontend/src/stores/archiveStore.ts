import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useHallStore } from '@/stores/hallStore'
import { useRepairStore } from '@/stores/repairStore'
import type {
  ArchiveBundle,
  ArchiveRecord,
  BrokenRef
} from '@/types/archive'
import { cloneBundle, collectHallBundle, validateBundle } from '@/utils/archive'

/** 归档被引用校验拦截时抛出，档案页据此展示断开的记录 */
export class ArchiveValidationError extends Error {
  brokenRefs: BrokenRef[]
  constructor(brokenRefs: BrokenRef[]) {
    super('归档校验未通过')
    this.name = 'ArchiveValidationError'
    this.brokenRefs = brokenRefs
  }
}

/**
 * 会审档案 store：按殿宇维护草稿与历史快照。
 * - 草稿（draft）：构件、层位、病害、工序与殿宇主记录的整包快照，可反复刷新
 * - 归档：引用完整性通过后草稿转为不可变快照，并回写殿宇当前版本指针
 * - 恢复：用快照覆盖该殿宇当前工作数据，档案表本身不动
 */
export const useArchiveStore = defineStore('archive', () => {
  const archivesTable = useIdbTable<ArchiveRecord>((database) => database.archives, {
    sortByUpdatedAt: false
  })
  const hallStore = useHallStore()
  const repairStore = useRepairStore()

  const archives = computed<ArchiveRecord[]>(() =>
    [...archivesTable.rows.value].sort((a, b) => b.updatedAt - a.updatedAt)
  )
  const loading = computed(() => archivesTable.loading.value)
  const ready = computed(() => archivesTable.ready.value)

  /** 殿宇 id → 该殿宇全部档案（按版本序号倒序） */
  const byHall = computed<Record<string, ArchiveRecord[]>>(() => {
    const grouped: Record<string, ArchiveRecord[]> = {}
    archives.value.forEach((record) => {
      if (!grouped[record.hallId]) grouped[record.hallId] = []
      grouped[record.hallId].push(record)
    })
    Object.values(grouped).forEach((list) =>
      list.sort((a, b) => {
        if (a.kind === 'draft') return -1
        if (b.kind === 'draft') return 1
        return (b.seq ?? -1) - (a.seq ?? -1)
      })
    )
    return grouped
  })

  function recordsOfHall(hallId: string): ArchiveRecord[] {
    return byHall.value[hallId] ?? []
  }

  function draftOfHall(hallId: string): ArchiveRecord | null {
    return archives.value.find((record) => record.hallId === hallId && record.kind === 'draft') ?? null
  }

  function snapshotsOfHall(hallId: string): ArchiveRecord[] {
    return recordsOfHall(hallId)
      .filter((record) => record.kind === 'snapshot')
      .sort((a, b) => (b.seq ?? -1) - (a.seq ?? -1))
  }

  function archiveById(id: string): ArchiveRecord | undefined {
    return archives.value.find((record) => record.id === id)
  }

  /** 殿宇当前版本指针对应的快照 */
  function currentVersionOfHall(hallId: string): ArchiveRecord | null {
    const versionId = hallStore.hallById(hallId)?.currentVersionId
    if (!versionId) return null
    return archiveById(versionId) ?? null
  }

  /** 殿宇主记录已不存在、但会审档案仍在的断开档案（恢复可找回殿宇） */
  const orphanArchives = computed<ArchiveRecord[]>(() =>
    archives.value.filter((record) => !hallStore.hallById(record.hallId))
  )

  /** 取殿宇当前工作数据的整包（不写库） */
  function liveBundleOfHall(hallId: string): ArchiveBundle {
    return collectHallBundle(
      hallId,
      hallStore.halls,
      hallStore.elements,
      hallStore.layers,
      hallStore.decays,
      repairStore.steps
    )
  }

  /** 校验草稿包，落盘断链明细，返回断开记录（空数组表示通过） */
  async function validateDraft(recordId: string): Promise<BrokenRef[]> {
    const record = await archivesTable.getById(recordId)
    if (!record) throw new Error('档案记录不存在')
    const brokenRefs = validateBundle(record.bundle)
    await archivesTable.update(recordId, { brokenRefs })
    return brokenRefs
  }

  /** 从当前工作数据建立会审草稿（每座殿宇至多一份）；默认挂在殿宇当前版本之下 */
  async function createDraft(params: {
    hallId: string
    title?: string
    note?: string
    parentId?: string | null
    restoredFromId?: string | null
    origin?: ArchiveRecord['origin']
  }): Promise<ArchiveRecord> {
    // 直接读库判定，避免归档后 liveQuery 尚未刷新时误把刚转快照的旧草稿当作现存草稿
    const list = await db.archives.where('hallId').equals(params.hallId).toArray()
    const existing = list.find((record) => record.kind === 'draft')
    if (existing) return existing
    // 直接读库拿最新殿宇（含刚回写的 currentVersionId），避免 liveQuery 缓存滞后
    const hall = await db.halls.get(params.hallId)
    if (!hall) throw new Error('父级殿宇不存在，无法建立草稿')
    const now = Date.now()
    // 深拷贝：liveQuery 行是 Vue 响应式代理，直接入 IndexedDB 会触发 DataCloneError
    const bundle = cloneBundle(liveBundleOfHall(params.hallId))
    const brokenRefs = validateBundle(bundle)
    const record: ArchiveRecord = {
      id: createId('arch'),
      hallId: hall.id,
      hallName: hall.name,
      kind: 'draft',
      origin: params.origin ?? 'manual',
      title: params.title?.trim() || '会审草稿',
      note: params.note?.trim() ?? '',
      seq: null,
      parentId: params.parentId !== undefined ? params.parentId : hall.currentVersionId,
      restoredFromId: params.restoredFromId ?? null,
      sourceExportedAt: null,
      bundle,
      brokenRefs,
      createdAt: now,
      updatedAt: now,
      archivedAt: null
    }
    await archivesTable.bulkPut([record])
    return record
  }

  /** 用当前工作数据刷新草稿整包（会审过程中的复查记录不再互相覆盖） */
  async function refreshDraft(recordId: string): Promise<ArchiveRecord> {
    const record = await archivesTable.getById(recordId)
    if (!record) throw new Error('档案记录不存在')
    if (record.kind !== 'draft') throw new Error('历史快照不可刷新')
    const bundle = cloneBundle(liveBundleOfHall(record.hallId))
    const brokenRefs = validateBundle(bundle)
    const hall = hallStore.hallById(record.hallId)
    await archivesTable.update(recordId, {
      bundle,
      brokenRefs,
      ...(hall ? { hallName: hall.name } : {})
    })
    return (await archivesTable.getById(recordId)) as ArchiveRecord
  }

  async function saveDraftMeta(recordId: string, patch: { title?: string; note?: string }): Promise<void> {
    const record = await archivesTable.getById(recordId)
    if (!record || record.kind !== 'draft') throw new Error('仅草稿可编辑')
    await archivesTable.update(recordId, patch)
  }

  /** 仅允许删除草稿；历史快照作为会审档案永久保留 */
  async function removeDraft(recordId: string): Promise<void> {
    const record = await archivesTable.getById(recordId)
    if (!record) return
    if (record.kind !== 'draft') throw new Error('历史快照不可删除')
    await archivesTable.remove(recordId)
  }

  /** 某殿宇下一个快照版本序号（初始版本占 0，其后从 1 起） */
  function nextSeq(hallId: string): number {
    const seqs = snapshotsOfHall(hallId)
      .map((record) => record.seq ?? 0)
      .filter((seq) => seq >= 0)
    return seqs.length === 0 ? 1 : Math.max(...seqs) + 1
  }

  /**
   * 归档草稿：先做引用完整性校验，存在父级缺失 / 引用不完整时整批不写任何半成品，
   * 通过后草稿转为不可变快照，并把殿宇当前版本指针指向新快照（单事务）。
   */
  async function archiveDraft(recordId: string, params: { title?: string; note?: string }): Promise<ArchiveRecord> {
    const draft = await archivesTable.getById(recordId)
    if (!draft) throw new Error('档案记录不存在')
    if (draft.kind !== 'draft') throw new Error('该记录已经是历史快照')

    const brokenRefs = validateBundle(draft.bundle)
    if (brokenRefs.length > 0) {
      await archivesTable.update(recordId, { brokenRefs })
      throw new ArchiveValidationError(brokenRefs)
    }

    const seq = nextSeq(draft.hallId)
    const now = Date.now()
    const archived: ArchiveRecord = {
      ...draft,
      bundle: cloneBundle(draft.bundle),
      kind: 'snapshot',
      seq,
      title: params.title?.trim() || `第 ${seq} 次会审`,
      note: params.note?.trim() ?? draft.note,
      brokenRefs: [],
      archivedAt: now,
      updatedAt: now
    }

    await db.transaction('rw', [db.archives, db.halls], async () => {
      await db.archives.put(archived)
      await db.halls.update(draft.hallId, { currentVersionId: archived.id, updatedAt: now })
    })
    return archived
  }

  /**
   * 把历史快照恢复成当前工作版本：
   * 单事务删除该殿宇现有工作数据后写回快照内容，殿宇版本指针指向该快照；
   * 档案表不删不改 —— 原快照与其后产生的档案全部保留。
   * 可选再派生一份「恢复后会审」草稿，内容与快照一致。
   */
  async function restoreSnapshot(
    recordId: string,
    options: { withDraft?: boolean; draftTitle?: string } = {}
  ): Promise<ArchiveRecord | null> {
    const snapshot = await archivesTable.getById(recordId)
    if (!snapshot) throw new Error('档案记录不存在')
    if (snapshot.kind !== 'snapshot') throw new Error('只有历史快照可以恢复')
    const { hall } = snapshot.bundle
    if (!hall) throw new Error('该快照的父级殿宇缺失，无法恢复')

    const { elements, layers, decays, repairSteps } = snapshot.bundle
    const now = Date.now()

    await db.transaction(
      'rw',
      [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
      async () => {
        // 沿 殿宇→构件→层位→病害 链查出当前工作数据，连快照归档后新增的部分一起清掉；
        // 档案表不动，原快照与其后的档案全部保留。
        const liveElements = await db.elements.where('hallId').equals(hall.id).toArray()
        const liveElementIds = liveElements.map((row) => row.id)
        const liveLayers =
          liveElementIds.length > 0
            ? await db.layers.where('elementId').anyOf(liveElementIds).toArray()
            : []
        const liveLayerIds = liveLayers.map((row) => row.id)
        const liveDecays =
          liveLayerIds.length > 0
            ? await db.decays.where('layerId').anyOf(liveLayerIds).toArray()
            : []
        const liveDecayIds = liveDecays.map((row) => row.id)

        if (liveDecayIds.length > 0) {
          await db.repairSteps.where('decayId').anyOf(liveDecayIds).delete()
        }
        if (liveLayerIds.length > 0) {
          await db.decays.where('layerId').anyOf(liveLayerIds).delete()
        }
        if (liveElementIds.length > 0) {
          await db.layers.where('elementId').anyOf(liveElementIds).delete()
        }
        await db.elements.where('hallId').equals(hall.id).delete()

        // 整包写回快照内容，并把殿宇当前版本指针指向该快照
        await db.halls.put({ ...hall, currentVersionId: snapshot.id, updatedAt: now })
        await db.elements.bulkPut(elements.map((row) => ({ ...row })))
        await db.layers.bulkPut(layers.map((row) => ({ ...row })))
        await db.decays.bulkPut(decays.map((row) => ({ ...row })))
        await db.repairSteps.bulkPut(repairSteps.map((row) => ({ ...row })))
      }
    )

    hallStore.setCurrentHall(hall.id)

    if (!options.withDraft) return null
    // 恢复后基于该快照派生一份继续会审的草稿；该殿宇若已有草稿（其内容属于被回退的
    // 工作版本），先删除再以快照内容另起新草稿，避免静默复用旧草稿。
    return db.transaction('rw', db.archives, async () => {
      const stale = await db.archives.where('hallId').equals(hall.id).toArray()
      const staleDrafts = stale.filter((record) => record.kind === 'draft')
      if (staleDrafts.length > 0) {
        await db.archives.bulkDelete(staleDrafts.map((record) => record.id))
      }
      const draft: ArchiveRecord = {
        id: createId('arch'),
        hallId: hall.id,
        hallName: hall.name,
        kind: 'draft',
        origin: 'restore',
        title: options.draftTitle?.trim() || '恢复后会审草稿',
        note: `由「${snapshot.title}」恢复后继续会审`,
        seq: null,
        parentId: snapshot.id,
        restoredFromId: snapshot.id,
        sourceExportedAt: null,
        bundle: cloneBundle(snapshot.bundle),
        brokenRefs: [],
        createdAt: now,
        updatedAt: now,
        archivedAt: null
      }
      await db.archives.put(draft)
      return draft
    })
  }

  return {
    archives,
    loading,
    ready,
    byHall,
    orphanArchives,
    recordsOfHall,
    draftOfHall,
    snapshotsOfHall,
    archiveById,
    currentVersionOfHall,
    liveBundleOfHall,
    createDraft,
    refreshDraft,
    validateDraft,
    saveDraftMeta,
    removeDraft,
    nextSeq,
    archiveDraft,
    restoreSnapshot
  }
})
