import { defineStore } from 'pinia'
import { computed } from 'vue'
import { db, createId } from '@/utils/db'
import { useIdbTable } from '@/hooks/useIdbTable'
import { useHallStore } from '@/stores/hallStore'
import { buildSnapshot, validateSnapshot } from '@/utils/version'
import type { ArchiveVersion, VersionStatus } from '@/types/version'

/**
 * 档案版本 store：维护每座殿宇的草稿版本与历史快照。
 * 草稿可编辑、可刷新；归档后成为不可变的历史快照；快照可恢复为当前版本。
 */
export const useVersionStore = defineStore('version', () => {
  const versionsTable = useIdbTable<ArchiveVersion>((database) => database.archiveVersions, {
    sortByUpdatedAt: false
  })
  const hallStore = useHallStore()

  const versions = computed<ArchiveVersion[]>(() => versionsTable.rows.value)
  const loading = computed(() => versionsTable.loading.value)

  /** 按殿宇分组的版本（按版本号升序） */
  const versionsByHall = computed<Record<string, ArchiveVersion[]>>(() => {
    const grouped: Record<string, ArchiveVersion[]> = {}
    versions.value.forEach((version) => {
      if (!grouped[version.hallId]) grouped[version.hallId] = []
      grouped[version.hallId].push(version)
    })
    Object.values(grouped).forEach((list) => list.sort((a, b) => a.versionNo - b.versionNo))
    return grouped
  })

  /** 某座殿宇的版本列表 */
  function versionsOfHall(hallId: string): ArchiveVersion[] {
    return versionsByHall.value[hallId] ?? []
  }

  /** 某座殿宇的草稿版本 */
  function draftsOfHall(hallId: string): ArchiveVersion[] {
    return versionsOfHall(hallId).filter((v) => v.status === 'draft')
  }

  /** 某座殿宇的已归档版本 */
  function archivedOfHall(hallId: string): ArchiveVersion[] {
    return versionsOfHall(hallId).filter((v) => v.status === 'archived')
  }

  /** 某座殿宇的下一个版本号 */
  function nextVersionNo(hallId: string): number {
    const list = versionsOfHall(hallId)
    if (list.length === 0) return 1
    return Math.max(...list.map((v) => v.versionNo)) + 1
  }

  function versionById(id: string): ArchiveVersion | undefined {
    return versions.value.find((v) => v.id === id)
  }

  /**
   * 新建草稿版本：捕获当前殿宇数据作为草稿。
   * 草稿可再次刷新，归档后才成为历史快照。
   */
  async function createDraft(hallId: string, note: string): Promise<ArchiveVersion> {
    const hall = hallStore.hallById(hallId)
    if (!hall) throw new Error('殿宇不存在，无法创建草稿版本')

    // 从主表读取全量数据组装快照
    const [allElements, allLayers, allDecays, allSteps] = await Promise.all([
      db.elements.toArray(),
      db.layers.toArray(),
      db.decays.toArray(),
      db.repairSteps.toArray()
    ])
    const snapshot = buildSnapshot(hall, allElements, allLayers, allDecays, allSteps)

    const now = Date.now()
    const version: ArchiveVersion = {
      id: createId('ver'),
      versionNo: nextVersionNo(hallId),
      hallId,
      status: 'draft',
      note: note.trim() || `第 ${nextVersionNo(hallId)} 次会审草稿`,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      snapshot
    }
    await versionsTable.create(version, 'ver')
    return version
  }

  /**
   * 归档版本：校验快照完整性，通过后固化为历史快照。
   * 校验失败时整批不写入任何数据（原子操作）。
   */
  async function archiveVersion(versionId: string): Promise<ArchiveVersion> {
    const version = versionById(versionId)
    if (!version) throw new Error('版本不存在')
    if (version.status === 'archived') throw new Error('该版本已归档')

    const validation = validateSnapshot(version.snapshot)
    if (!validation.valid) {
      const messages = validation.broken.map((b) => b.message).join('\n')
      throw new Error(`快照引用不完整，存在 ${validation.broken.length} 处断开记录：\n${messages}`)
    }

    const now = Date.now()
    const updated: ArchiveVersion = {
      ...version,
      status: 'archived' as VersionStatus,
      archivedAt: now,
      updatedAt: now
    }
    // 原子写入：校验已通过，直接更新状态
    await versionsTable.update(versionId, {
      status: 'archived',
      archivedAt: now,
      updatedAt: now
    })
    return updated
  }

  /**
   * 刷新草稿：用当前主表数据重新捕获快照。
   * 仅草稿可刷新，已归档版本不可变。
   */
  async function refreshDraft(versionId: string, note?: string): Promise<ArchiveVersion> {
    const version = versionById(versionId)
    if (!version) throw new Error('版本不存在')
    if (version.status !== 'draft') throw new Error('仅草稿版本可刷新快照')

    const hall = hallStore.hallById(version.hallId)
    if (!hall) throw new Error('殿宇不存在，无法刷新草稿')

    const [allElements, allLayers, allDecays, allSteps] = await Promise.all([
      db.elements.toArray(),
      db.layers.toArray(),
      db.decays.toArray(),
      db.repairSteps.toArray()
    ])
    const snapshot = buildSnapshot(hall, allElements, allLayers, allDecays, allSteps)

    const now = Date.now()
    const updated: ArchiveVersion = {
      ...version,
      snapshot,
      note: note?.trim() || version.note,
      updatedAt: now
    }
    await versionsTable.update(versionId, {
      snapshot,
      note: updated.note,
      updatedAt: now
    })
    return updated
  }

  /**
   * 恢复版本：将历史快照写回主表，成为当前工作版本。
   * 原快照与后续档案保留不变。
   */
  async function restoreVersion(versionId: string): Promise<void> {
    const version = versionById(versionId)
    if (!version) throw new Error('版本不存在')
    if (!version.snapshot.hall) throw new Error('快照缺少殿宇信息，无法恢复')

    const { snapshot } = version
    const targetHallId = snapshot.hall.id
    // 原子事务：先删除该殿宇的现有数据，再写入快照数据
    await db.transaction(
      'rw',
      [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
      async () => {
        // 删除该殿宇现有的构件 → 层位 → 病害 → 工序
        const hallElements = await db.elements.where('hallId').equals(targetHallId).toArray()
        const elementIds = hallElements.map((el) => el.id)
        const hallLayers = await db.layers.where('elementId').anyOf(elementIds).toArray()
        const layerIds = hallLayers.map((l) => l.id)
        const hallDecays = await db.decays.where('layerId').anyOf(layerIds).toArray()
        const decayIds = hallDecays.map((d) => d.id)

        await db.repairSteps.where('decayId').anyOf(decayIds).delete()
        await db.decays.where('layerId').anyOf(layerIds).delete()
        await db.layers.where('elementId').anyOf(elementIds).delete()
        await db.elements.where('hallId').equals(targetHallId).delete()
        await db.halls.delete(targetHallId)

        // 写入快照数据
        await db.halls.put(snapshot.hall)
        if (snapshot.elements.length > 0) await db.elements.bulkPut(snapshot.elements)
        if (snapshot.layers.length > 0) await db.layers.bulkPut(snapshot.layers)
        if (snapshot.decays.length > 0) await db.decays.bulkPut(snapshot.decays)
        if (snapshot.repairSteps.length > 0) await db.repairSteps.bulkPut(snapshot.repairSteps)
      }
    )
  }

  /** 删除版本（草稿可直接删除；已归档版本需确认） */
  async function deleteVersion(versionId: string): Promise<void> {
    await versionsTable.remove(versionId)
  }

  /** 更新版本说明 */
  async function updateNote(versionId: string, note: string): Promise<void> {
    await versionsTable.update(versionId, { note: note.trim() })
  }

  return {
    versions,
    loading,
    versionsByHall,
    versionsOfHall,
    draftsOfHall,
    archivedOfHall,
    nextVersionNo,
    versionById,
    createDraft,
    archiveVersion,
    refreshDraft,
    restoreVersion,
    deleteVersion,
    updateNote
  }
})
