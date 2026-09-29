import {
  db,
  DB_VERSION,
  createId,
  clearAllTables,
  stampBackupTime,
  type BackupPayload
} from '@/utils/db'
import type { ArchiveRecord } from '@/types/archive'
import { buildInitialArchive, cloneBundle, collectHallBundle } from '@/utils/archive'

export interface ValidateResult {
  ok: boolean
  errors: string[]
  payload: BackupPayload | null
  /** 旧备份：不含 archives 版本信息，导入后每座殿宇归为「初始版本」 */
  legacy: boolean
}

/** 校验备份对象的必备字段，返回错误信息数组（为空表示通过） */
export function validateBackup(input: unknown): ValidateResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null) {
    return { ok: false, errors: ['文件内容不是合法的 JSON 对象'], payload: null, legacy: false }
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
  // 没有 archives 字段的备份来自版本化改造之前，按旧备份处理；字段存在但类型错误则判为损坏
  const hasArchivesField = Object.prototype.hasOwnProperty.call(obj, 'archives')
  const legacy = !hasArchivesField
  if (hasArchivesField && !Array.isArray(obj.archives)) {
    errors.push('archives 字段不是数组')
  }
  if (errors.length > 0) return { ok: false, errors, payload: null, legacy: false }
  const payload: BackupPayload = {
    app: 'gbmuralarch',
    dbVersion: typeof obj.dbVersion === 'number' ? obj.dbVersion : DB_VERSION,
    exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : new Date().toISOString(),
    halls: obj.halls ?? [],
    elements: obj.elements ?? [],
    layers: obj.layers ?? [],
    decays: obj.decays ?? [],
    repairSteps: obj.repairSteps ?? [],
    archives: legacy ? [] : (obj.archives as ArchiveRecord[])
  }
  return { ok: true, errors, payload, legacy }
}

/** 组装当前本地数据的备份对象（含全部会审档案与版本链） */
export async function buildBackupPayload(): Promise<BackupPayload> {
  const [halls, elements, layers, decays, repairSteps, archives] = await Promise.all([
    db.halls.toArray(),
    db.elements.toArray(),
    db.layers.toArray(),
    db.decays.toArray(),
    db.repairSteps.toArray(),
    db.archives.toArray()
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
    archives
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
      archives: payload.archives.length,
      snapshots: payload.archives.filter((record) => record.kind === 'snapshot').length,
      drafts: payload.archives.filter((record) => record.kind === 'draft').length
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

/**
 * 旧备份补全：没有版本信息时，为每座殿宇生成「初始版本」快照并把殿宇指针指向它，
 * 使导入后的档案页能看到完整的版本起点。导出供导入流程与测试复用。
 */
export function attachInitialVersions(payload: BackupPayload): BackupPayload {
  const now = Date.now()
  // 只按 halls 中存在的殿宇归档；无父殿宇的游离构件不造初始版本（档案页可发现断链）
  const initials: ArchiveRecord[] = payload.halls.map((hall) => {
    const bundle = collectHallBundle(
      hall.id,
      payload.halls,
      payload.elements,
      payload.layers,
      payload.decays,
      payload.repairSteps
    )
    return buildInitialArchive({
      id: createId('arch'),
      bundle,
      sourceExportedAt: payload.exportedAt,
      now
    })
  })
  const halls = payload.halls.map((hall) => {
    const initial = initials.find((record) => record.hallId === hall.id)
    return { ...hall, currentVersionId: initial?.id ?? hall.currentVersionId ?? null }
  })
  return { ...payload, halls, archives: initials }
}

/**
 * 导入备份：overwrite=true 时先清空全部表，否则按主键合并（同 id 覆盖）。
 * 旧备份先补「初始版本」再写入。整批在单事务内完成，失败不留半成品。
 */
export async function importBackup(
  payloadIn: BackupPayload,
  overwrite: boolean,
  legacy = false
): Promise<Record<string, number>> {
  const payload = legacy ? attachInitialVersions(payloadIn) : payloadIn
  if (overwrite) await clearAllTables()
  await db.transaction(
    'rw',
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps, db.archives],
    async () => {
      await db.halls.bulkPut(payload.halls)
      await db.elements.bulkPut(payload.elements)
      await db.layers.bulkPut(payload.layers)
      await db.decays.bulkPut(payload.decays)
      await db.repairSteps.bulkPut(payload.repairSteps)
      await db.archives.bulkPut(payload.archives)
    }
  )
  return {
    halls: payload.halls.length,
    elements: payload.elements.length,
    layers: payload.layers.length,
    decays: payload.decays.length,
    repairSteps: payload.repairSteps.length,
    archives: payload.archives.length,
    initials: legacy ? payload.archives.length : 0
  }
}

/**
 * 追加式导入：为导入数据（含会审档案的版本链）重新分配 id，避免覆盖现有档案。
 */
export function remapIds(payloadIn: BackupPayload, legacy = false): BackupPayload {
  const payload = legacy ? attachInitialVersions(payloadIn) : payloadIn
  const hallIdMap = new Map<string, string>()
  const elementIdMap = new Map<string, string>()
  const layerIdMap = new Map<string, string>()
  const decayIdMap = new Map<string, string>()
  const archiveIdMap = new Map<string, string>()

  // 档案自身 id 先建映射，才能改写 parentId / restoredFromId / currentVersionId
  payload.archives.forEach((record) => {
    archiveIdMap.set(record.id, createId('arch'))
  })

  const halls = payload.halls.map((hall) => {
    const id = createId('hall')
    hallIdMap.set(hall.id, id)
    return {
      ...hall,
      id,
      currentVersionId: hall.currentVersionId ? archiveIdMap.get(hall.currentVersionId) ?? null : null
    }
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

  const remapBundle = (record: ArchiveRecord) => {
    const bundle = cloneBundle(record.bundle)
    if (bundle.hall) {
      bundle.hall = {
        ...bundle.hall,
        id: hallIdMap.get(bundle.hall.id) ?? bundle.hall.id,
        currentVersionId: archiveIdMap.get(bundle.hall.currentVersionId ?? '') ?? null
      }
    }
    bundle.elements = bundle.elements.map((row) => ({
      ...row,
      id: elementIdMap.get(row.id) ?? row.id,
      hallId: hallIdMap.get(row.hallId) ?? row.hallId
    }))
    bundle.layers = bundle.layers.map((row) => ({
      ...row,
      id: layerIdMap.get(row.id) ?? row.id,
      elementId: elementIdMap.get(row.elementId) ?? row.elementId
    }))
    bundle.decays = bundle.decays.map((row) => ({
      ...row,
      id: decayIdMap.get(row.id) ?? row.id,
      layerId: layerIdMap.get(row.layerId) ?? row.layerId
    }))
    bundle.repairSteps = bundle.repairSteps.map((row) => ({
      ...row,
      id: createId('step'),
      decayId: decayIdMap.get(row.decayId) ?? row.decayId
    }))
    return bundle
  }

  const archives = payload.archives.map((record) => {
    const newHallId = hallIdMap.get(record.hallId) ?? record.hallId
    return {
      ...record,
      id: archiveIdMap.get(record.id) ?? createId('arch'),
      hallId: newHallId,
      parentId: record.parentId ? archiveIdMap.get(record.parentId) ?? null : null,
      restoredFromId: record.restoredFromId ? archiveIdMap.get(record.restoredFromId) ?? null : null,
      bundle: remapBundle(record)
    }
  })

  return { ...payload, halls, elements, layers, decays, repairSteps, archives }
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
    [db.halls, db.elements, db.layers, db.decays, db.repairSteps],
    async () => {
      await db.halls.put({
        id: hallId,
        name: '大雄宝殿',
        era: '明嘉靖',
        structureType: '大木',
        roofType: '庑殿',
        currentVersionId: null,
        createdAt: now,
        updatedAt: now
      })
      await db.elements.bulkPut([
        {
          id: elementIds[0],
          hallId,
          position: '檐下',
          name: '前檐明间额枋',
          layerCount: 2,
          baseLayer: '一麻五灰',
          status: '待修',
          createdAt: now,
          updatedAt: now
        },
        {
          id: elementIds[1],
          hallId,
          position: '梁枋',
          name: '七架梁',
          layerCount: 1,
          baseLayer: '单披灰',
          status: '观察',
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.layers.bulkPut([
        {
          id: layerIds[0],
          elementId: elementIds[0],
          level: 1,
          patternName: '旋子',
          pigment: '石青',
          thicknessMm: 1.8,
          createdAt: now,
          updatedAt: now
        },
        {
          id: layerIds[1],
          elementId: elementIds[1],
          level: 1,
          patternName: '苏式',
          pigment: '土黄',
          thicknessMm: 1.2,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.decays.bulkPut([
        {
          id: decayIds[0],
          layerId: layerIds[0],
          type: '起甲',
          severity: '重度',
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
          type: '龟裂',
          severity: '中度',
          areaCm2: 158,
          causeGuess: '木构件干缩引起画面开裂',
          repaired: false,
          repairedAt: null,
          createdAt: now,
          updatedAt: now
        }
      ])
      await db.repairSteps.bulkPut([
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 1,
          name: '除尘',
          material: '软毛刷 + 去离子水',
          operator: '李文博',
          state: '已完成',
          createdAt: now,
          updatedAt: now
        },
        {
          id: createId('step'),
          decayId: decayIds[0],
          seq: 2,
          name: '回贴',
          material: '鱼鳔胶（2% 明矾水调和）',
          operator: '李文博',
          state: '进行中',
          createdAt: now,
          updatedAt: now
        }
      ])
    }
  )
}
