import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { ArchiveVersion } from '@/types/version'

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): { ok: boolean; errors: string[]; payload: BackupPayload | null } {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null }
  }
  const obj = input as Partial<BackupPayload>
  if (obj.app !== 'gbmuralarch') errors.push('app 字段应为 gbmuralarch，文件来源不明')
  const collections: Array<keyof Pick<BackupPayload, 'halls' | 'elements' | 'layers' | 'decays' | 'repairSteps'>> = [
    'halls',
    'elements',
    'layers',
    'decays',
    'repairSteps'
  ]
  for (const key of collections) {
    if (!Array.isArray(obj[key])) errors.push(`${key} 字段缺失或不是数组`)
  }
  if (errors.length > 0) return { ok: false, errors, payload: null }
  const payload: BackupPayload = {
    app: 'gbmuralarch',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    halls: obj.halls ?? [],
    elements: obj.elements ?? [],
    layers: obj.layers ?? [],
    decays: obj.decays ?? [],
    repairSteps: obj.repairSteps ?? [],
    versions: Array.isArray(obj.versions) ? obj.versions : undefined
  }
  return { ok: true, errors, payload }
}

/** 组装当前本地数据的备份对象（含档案版本） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [halls, elements, layers, decays, repairSteps, versions] = await Promise.all([
    db.halls.toArray(),
    db.elements.toArray(),
    db.layers.toArray(),
    db.decays.toArray(),
    db.repairSteps.toArray(),
    db.archiveVersions.toArray()
  ])
  return {
    app: 'gbmuralarch',
    dbVersion: DB_VERSION,
    exportedAt: new Date().toISOString(),
    halls,
    elements,
    layers,
    decays,
    repairSteps,
    versions
  }
}

/** 导出 JSON 文件到浏览器下载目录 */
export async function exportBackupJson(): Promise<{ fileName: string; counts: Record<string, number> }> {
  const payload = await buildBackupPayload()
  const fileName = `gbmuralarch-backup-v${payload.dbVersion}-${payload.exportedAt.slice(0, 19).replace(/[:T]/g, '')}.json`
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  stampBackupTime(payload.exportedAt)
  return {
    fileName,
    counts: {
      halls: payload.halls.length,
      elements: payload.elements.length,
      layers: payload.layers.length,
      decays: payload.decays.length,
      repairSteps: payload.repairSteps.length,
      versions: payload.versions?.length ?? 0
    }
  }
}

/** 读取用户选择的备份文件文本 */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result ?? ''))
    reader.onerror = () => reject(new Error('文件读取失败'))
    reader.readAsText(file, 'utf-8')
  })
}

/** 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖） */
export async function importBackup(
  payload: BackupPayload,
  overwrite: boolean
): Promise<Record<string, number>> {
  if (overwrite) await clearAllTables()

  // 旧版备份没有版本信息：为每座殿宇创建「初始版本」归档快照
  const hasVersions = Array.isArray(payload.versions) && payload.versions.length > 0
  const versionsToImport: ArchiveVersion[] = hasVersions
    ? (payload.versions as ArchiveVersion[])
    : buildInitialVersions(payload)

  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps, db.archiveVersions],
    async () => {
      await db.halls.bulkPut(payload.halls)
      await db.elements.bulkPut(payload.elements)
      await db.layers.bulkPut(payload.layers)
      await db.decays.bulkPut(payload.decays)
      await db.repairSteps.bulkPut(payload.repairSteps)
      if (versionsToImport.length > 0) await db.archiveVersions.bulkPut(versionsToImport)
    }
  )
  return {
    halls: payload.halls.length,
    elements: payload.elements.length,
    layers: payload.layers.length,
    decays: payload.decays.length,
    repairSteps: payload.repairSteps.length,
    versions: versionsToImport.length
  }
}

/**
 * 旧版备份（无版本信息）导入后，为每座殿宇生成「初始版本」归档快照。
 * 快照内容从备份数据中按殿宇筛选组装。
 */
function buildInitialVersions(payload: BackupPayload): ArchiveVersion[] {
  const now = Date.now()
  return payload.halls.map((hall) => {
    const hallElementIds = new Set(
      payload.elements.filter((el) => el.hallId === hall.id).map((el) => el.id)
    )
    const hallLayers = payload.layers.filter((layer) => hallElementIds.has(layer.elementId))
    const hallLayerIds = new Set(hallLayers.map((layer) => layer.id))
    const hallDecays = payload.decays.filter((decay) => hallLayerIds.has(decay.layerId))
    const hallDecayIds = new Set(hallDecays.map((decay) => decay.id))
    const hallSteps = payload.repairSteps.filter((step) => hallDecayIds.has(step.decayId))

    return {
      id: createId('ver'),
      versionNo: 1,
      hallId: hall.id,
      status: 'archived' as const,
      note: '初始版本（旧备份导入）',
      archivedAt: now,
      createdAt: now,
      updatedAt: now,
      snapshot: {
        hall,
        elements: payload.elements.filter((el) => el.hallId === hall.id),
        layers: hallLayers,
        decays: hallDecays,
        repairSteps: hallSteps
      }
    }
  })
}

/** 追加式导入：为导入数据重新分配 id，避免覆盖现有档案 */
export function remapIds(payload: BackupPayload): BackupPayload {
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()

  const halls = payload.halls.map((hall) => {
    const id = createId('hall')
    hallIdMap.set(hall.id, id)
    return { ...hall, id }
  })
  const elements = payload.elements.map((element) => {
    const id = createId('elem')
    elementIdMap.set(element.id, id)
    return { ...element, id, hallId: hallIdMap.get(element.hallId) ?? element.hallId }
  })
  const layers = payload.layers.map((layer) => {
    const id = createId('lay')
    layerIdMap.set(layer.id, id)
    return { ...layer, id, elementId: elementIdMap.get(layer.elementId) ?? layer.elementId }
  })
  const decays = payload.decays.map((decay) => {
    const id = createId('dec')
    decayIdMap.set(decay.id, id)
    return { ...decay, id, layerId: layerIdMap.get(decay.layerId) ?? decay.layerId }
  })
  const repairSteps = payload.repairSteps.map((step) => ({
    ...step,
    id: createId('step'),
    decayId: decayIdMap.get(step.decayId) ?? step.decayId
  }))

  // 版本档案：重新分配 id，并同步快照内的引用
  const versions = (payload.versions ?? []).map((version) => {
    const id = createId('ver')
    const snapshot = {
      hall: version.snapshot.hall
        ? { ...version.snapshot.hall, id: hallIdMap.get(version.snapshot.hall.id) ?? version.snapshot.hall.id }
        : version.snapshot.hall,
      elements: version.snapshot.elements.map((el) => ({
        ...el,
        id: elementIdMap.get(el.id) ?? el.id,
        hallId: hallIdMap.get(el.hallId) ?? el.hallId
      })),
      layers: version.snapshot.layers.map((layer) => ({
        ...layer,
        id: layerIdMap.get(layer.id) ?? layer.id,
        elementId: elementIdMap.get(layer.elementId) ?? layer.elementId
      })),
      decays: version.snapshot.decays.map((decay) => ({
        ...decay,
        id: decayIdMap.get(decay.id) ?? decay.id,
        layerId: layerIdMap.get(decay.layerId) ?? decay.layerId
      })),
      repairSteps: version.snapshot.repairSteps.map((step) => ({
        ...step,
        id: createId('step'),
        decayId: decayIdMap.get(step.decayId) ?? step.decayId
      }))
    }
    return {
      ...version,
      id,
      hallId: hallIdMap.get(version.hallId) ?? version.hallId,
      snapshot
    }
  })

  return { ...payload, halls, elements, layers, decays, repairSteps, versions }
}

/** 生成演示样例数据，便于首次打开即可看到完整链路 */
export async function seedDemoData(): Promise<void> {
  const now = Date.now()
  const hallId = createId('hall')
  const elementIds = [createId('elem'), createId('elem')]
  const layerIds = elementIds.map(() => createId('lay'))
  const decayIds = layerIds.map(() => createId('dec'))

  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps, db.archiveVersions],
    async () => {
      const hall = {
        id: hallId,
        name: '大雄宝殿',
        era: '明嘉靖',
        structureType: '大木' as const,
        roofType: '庑殿' as const,
        createdAt: now,
        updatedAt: now
      }
      await db.halls.put(hall)
      const elements = [
        {
          id: elementIds[0],
          hallId,
          position: '檐下' as const,
          name: '前檐明间额枋',
          layerCount: 2,
          baseLayer: '一麻五灰',
          status: '待修' as const,
          createdAt: now,
          updatedAt: now
        },
        {
          id: elementIds[1],
          hallId,
          position: '梁枋' as const,
          name: '七架梁',
          layerCount: 1,
          baseLayer: '单披灰',
          status: '观察' as const,
          createdAt: now,
          updatedAt: now
        }
      ]
      await db.elements.bulkPut(elements)
      const layers = [
        {
          id: layerIds[0],
          elementId: elementIds[0],
          level: 1,
          patternName: '旋子' as const,
          pigment: '石青' as const,
          thicknessMm: 1.8,
          createdAt: now,
          updatedAt: now
        },
        {
          id: layerIds[1],
          elementId: elementIds[1],
          level: 1,
          patternName: '苏式' as const,
          pigment: '土黄' as const,
          thicknessMm: 1.2,
          createdAt: now,
          updatedAt: now
        }
      ]
      await db.layers.bulkPut(layers)
      const decays = [
        {
          id: decayIds[0],
          layerId: layerIds[0],
          type: '起甲' as const,
          severity: '重度' as const,
          areaCm2: 320.5,
          causeGuess: '地仗层脱胶，受檐口渗水影响',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        },
        {
          id: decayIds[1],
          layerId: layerIds[1],
          type: '龟裂' as const,
          severity: '中度' as const,
          areaCm2: 158,
          causeGuess: '木构件干缩引起画面开裂',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ]
      await db.decays.bulkPut(decays)
      const repairSteps = [
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 1,
          name: '除尘' as const,
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成' as const,
          createdAt: now,
          updatedAt: now
        },
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 2,
          name: '回贴' as const,
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中' as const,
          createdAt: now,
          updatedAt: now
        }
      ]
      await db.repairSteps.bulkPut(repairSteps)

      // 为样例殿宇创建初始版本归档快照
      await db.archiveVersions.put({
        id: createId('ver'),
        versionNo: 1,
        hallId,
        status: 'archived',
        note: '初始版本（样例数据）',
        archivedAt: now,
        createdAt: now,
        updatedAt: now,
        snapshot: { hall, elements, layers, decays, repairSteps }
      })
    }
  )
}
