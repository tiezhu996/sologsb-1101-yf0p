import { INITIAL_VERSION_SEQ, type ArchiveBundle, type ArchiveRecord, type BrokenRef } from '@/types/archive'
import type { Decay } from '@/types/decay'
import type { Element } from '@/types/element'
import type { Hall } from '@/types/hall'
import type { PaintLayer } from '@/types/layer'
import type { RepairStep } from '@/types/repair'

/** 从全集数据中按殿宇打包一整包（殿宇主记录 + 构件 + 层位 + 病害 + 工序） */
export function collectHallBundle(
  hallId: string,
  halls: Hall[],
  elements: Element[],
  layers: PaintLayer[],
  decays: Decay[],
  repairSteps: RepairStep[]
): ArchiveBundle {
  const hall = halls.find((item) => item.id === hallId) ?? null
  const bundleElements = elements.filter((element) => element.hallId === hallId)
  const elementIds = new Set(bundleElements.map((element) => element.id))
  const bundleLayers = layers.filter((layer) => elementIds.has(layer.elementId))
  const layerIds = new Set(bundleLayers.map((layer) => layer.id))
  const bundleDecays = decays.filter((decay) => layerIds.has(decay.layerId))
  const decayIds = new Set(bundleDecays.map((decay) => decay.id))
  const bundleSteps = repairSteps.filter((step) => decayIds.has(step.decayId))
  return {
    hall,
    elements: bundleElements,
    layers: bundleLayers,
    decays: bundleDecays,
    repairSteps: bundleSteps
  }
}

/**
 * 校验一整包档案的引用完整性。
 * - 父级缺失：构件无殿宇、层位无构件、病害无层位、工序无病害
 * - 引用不完整 / id 重复：同表主键重复、外键指向包外或已不存在的记录
 * 返回断开的记录明细，供归档拦截与档案页指出。
 */
export function validateBundle(bundle: ArchiveBundle): BrokenRef[] {
  const broken: BrokenRef[] = []
  const push = (ref: BrokenRef): void => {
    broken.push(ref)
  }

  const hall = bundle.hall
  const hallId = hall?.id ?? null
  if (!hall || hallId === null) {
    push({
      entity: 'hall',
      id: hallId ?? '',
      label: hall?.name ?? '未知殿宇',
      field: 'id',
      message: '父级殿宇缺失或殿宇主记录不完整，整包无法归档'
    })
  }

  const hallIds = new Set(hall ? [hall.id] : [])
  const elementIds = new Set<string>()
  const layerIds = new Set<string>()
  const decayIds = new Set<string>()

  // 同表主键重复检查
  const markUnique = (
    list: Array<{ id: string }>,
    seen: Set<string>,
    entity: BrokenRef['entity'],
    labelOf: (row: never) => string
  ): void => {
    list.forEach((row) => {
      if (seen.has(row.id)) {
        push({
          entity,
          id: row.id,
          label: labelOf(row as never),
          field: 'id',
          message: `${entity} 记录 id 重复，引用关系不明确`
        })
      } else {
        seen.add(row.id)
      }
    })
  }

  markUnique(bundle.elements, elementIds, 'element', (row: Element) => row.name)
  markUnique(bundle.layers, layerIds, 'layer', (row: PaintLayer) => `第 ${row.level} 层`)
  markUnique(bundle.decays, decayIds, 'decay', (row: Decay) => `${row.type}病害`)
  const stepIds = new Set<string>()
  markUnique(bundle.repairSteps, stepIds, 'repairStep', (row: RepairStep) => `${row.name}工序`)

  bundle.elements.forEach((element) => {
    if (!element.hallId || !hallIds.has(element.hallId)) {
      push({
        entity: 'element',
        id: element.id,
        label: element.name,
        field: 'hallId',
        message: `构件「${element.name}」的 hallId=${element.hallId || '（空）'} 找不到父级殿宇`
      })
    }
  })

  bundle.layers.forEach((layer) => {
    if (!layer.elementId || !elementIds.has(layer.elementId)) {
      push({
        entity: 'layer',
        id: layer.id,
        label: `第 ${layer.level} 层`,
        field: 'elementId',
        message: `第 ${layer.level} 层彩画的 elementId=${layer.elementId || '（空）'} 找不到父级构件`
      })
    }
  })

  bundle.decays.forEach((decay) => {
    if (!decay.layerId || !layerIds.has(decay.layerId)) {
      push({
        entity: 'decay',
        id: decay.id,
        label: `${decay.type}病害`,
        field: 'layerId',
        message: `${decay.type}病害记录的 layerId=${decay.layerId || '（空）'} 找不到所属层位`
      })
    }
  })

  bundle.repairSteps.forEach((step) => {
    if (!step.decayId || !decayIds.has(step.decayId)) {
      push({
        entity: 'repairStep',
        id: step.id,
        label: `${step.name}工序`,
        field: 'decayId',
        message: `${step.name}工序的 decayId=${step.decayId || '（空）'} 找不到对应病害记录`
      })
    }
  })

  return broken
}

/** 档案包记录条数摘要，供卡片回显 */
export function bundleCounts(bundle: ArchiveBundle): Record<'elements' | 'layers' | 'decays' | 'repairSteps', number> {
  return {
    elements: bundle.elements.length,
    layers: bundle.layers.length,
    decays: bundle.decays.length,
    repairSteps: bundle.repairSteps.length
  }
}

/**
 * 旧备份导入：为一座殿宇的数据包构造「初始版本」快照。
 * 初始版本 seq=0、无父版本；若该包本身存在断链则原样记录到 brokenRefs。
 */
export function buildInitialArchive(params: {
  id: string
  bundle: ArchiveBundle
  sourceExportedAt: string | null
  now: number
}): ArchiveRecord {
  const { id, bundle, sourceExportedAt, now } = params
  const brokenRefs = validateBundle(bundle)
  return {
    id,
    hallId: bundle.hall?.id ?? bundle.elements[0]?.hallId ?? '',
    hallName: bundle.hall?.name ?? '（殿宇主记录缺失）',
    kind: 'snapshot',
    origin: 'import-initial',
    title: '初始版本',
    note: '由无版本信息的旧备份导入时自动归档',
    seq: INITIAL_VERSION_SEQ,
    parentId: null,
    restoredFromId: null,
    sourceExportedAt,
    bundle: cloneBundle(bundle),
    brokenRefs,
    createdAt: now,
    updatedAt: now,
    archivedAt: now
  }
}

/** 深拷贝数据包，避免草稿包与 liveQuery 行对象共享引用 */
export function cloneBundle(bundle: ArchiveBundle): ArchiveBundle {
  return {
    hall: bundle.hall ? { ...bundle.hall } : null,
    elements: bundle.elements.map((row) => ({ ...row })),
    layers: bundle.layers.map((row) => ({ ...row })),
    decays: bundle.decays.map((row) => ({ ...row })),
    repairSteps: bundle.repairSteps.map((row) => ({ ...row }))
  }
}
