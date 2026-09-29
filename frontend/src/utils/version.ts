import type { Hall } from '@/types/hall'
import type { Element } from '@/types/element'
import type { PaintLayer } from '@/types/layer'
import type { Decay } from '@/types/decay'
import type { RepairStep } from '@/types/repair'
import type { BrokenRef, SnapshotValidation, VersionSnapshot } from '@/types/version'

/**
 * 校验快照的引用完整性：
 * - 每个构件的 hallId 必须指向快照内的殿宇
 * - 每个层位的 elementId 必须指向快照内的构件
 * - 每条病害的 layerId 必须指向快照内的层位
 * - 每道工序的 decayId 必须指向快照内的病害
 *
 * 返回的 broken 列表描述所有断开的引用；valid 为 true 表示全部完整。
 */
export function validateSnapshot(snapshot: VersionSnapshot): SnapshotValidation {
  const broken: BrokenRef[] = []
  const hallIds = new Set(snapshot.hall ? [snapshot.hall.id] : [])
  const elementIds = new Set(snapshot.elements.map((el) => el.id))
  const layerIds = new Set(snapshot.layers.map((layer) => layer.id))
  const decayIds = new Set(snapshot.decays.map((decay) => decay.id))

  if (!snapshot.hall) {
    broken.push({
      childTable: 'elements',
      childId: '-',
      childName: '-',
      parentTable: 'halls',
      parentId: '-',
      message: '快照缺少殿宇信息'
    })
  }

  for (const element of snapshot.elements) {
    if (!hallIds.has(element.hallId)) {
      broken.push({
        childTable: 'elements',
        childId: element.id,
        childName: element.name,
        parentTable: 'halls',
        parentId: element.hallId,
        message: `构件「${element.name}」的殿宇引用缺失（hallId: ${element.hallId}）`
      })
    }
  }

  for (const layer of snapshot.layers) {
    if (!elementIds.has(layer.elementId)) {
      broken.push({
        childTable: 'layers',
        childId: layer.id,
        childName: `第${layer.level}层 · ${layer.patternName}`,
        parentTable: 'elements',
        parentId: layer.elementId,
        message: `层位「第${layer.level}层 · ${layer.patternName}」的构件引用缺失（elementId: ${layer.elementId}）`
      })
    }
  }

  for (const decay of snapshot.decays) {
    if (!layerIds.has(decay.layerId)) {
      broken.push({
        childTable: 'decays',
        childId: decay.id,
        childName: `${decay.type} · ${decay.severity}`,
        parentTable: 'layers',
        parentId: decay.layerId,
        message: `病害「${decay.type} · ${decay.severity}」的层位引用缺失（layerId: ${decay.layerId}）`
      })
    }
  }

  for (const step of snapshot.repairSteps) {
    if (!decayIds.has(step.decayId)) {
      broken.push({
        childTable: 'repairSteps',
        childId: step.id,
        childName: `${step.name}（第${step.seq}道）`,
        parentTable: 'decays',
        parentId: step.decayId,
        message: `工序「${step.name}（第${step.seq}道）」的病害引用缺失（decayId: ${step.decayId}）`
      })
    }
  }

  return { valid: broken.length === 0, broken }
}

/**
 * 检测当前主数据表中的断开引用（用于档案页提示）。
 * 与 validateSnapshot 的区别：这里的父级集合是全量主表数据，不限于某座殿宇。
 */
export function detectBrokenRefs(
  halls: Hall[],
  elements: Element[],
  layers: PaintLayer[],
  decays: Decay[],
  repairSteps: RepairStep[]
): BrokenRef[] {
  const broken: BrokenRef[] = []
  const hallIds = new Set(halls.map((hall) => hall.id))
  const elementIds = new Set(elements.map((el) => el.id))
  const layerIds = new Set(layers.map((layer) => layer.id))
  const decayIds = new Set(decays.map((decay) => decay.id))

  for (const element of elements) {
    if (!hallIds.has(element.hallId)) {
      broken.push({
        childTable: 'elements',
        childId: element.id,
        childName: element.name,
        parentTable: 'halls',
        parentId: element.hallId,
        message: `构件「${element.name}」的殿宇引用缺失（hallId: ${element.hallId}）`
      })
    }
  }

  for (const layer of layers) {
    if (!elementIds.has(layer.elementId)) {
      broken.push({
        childTable: 'layers',
        childId: layer.id,
        childName: `第${layer.level}层 · ${layer.patternName}`,
        parentTable: 'elements',
        parentId: layer.elementId,
        message: `层位「第${layer.level}层 · ${layer.patternName}」的构件引用缺失（elementId: ${layer.elementId}）`
      })
    }
  }

  for (const decay of decays) {
    if (!layerIds.has(decay.layerId)) {
      broken.push({
        childTable: 'decays',
        childId: decay.id,
        childName: `${decay.type} · ${decay.severity}`,
        parentTable: 'layers',
        parentId: decay.layerId,
        message: `病害「${decay.type} · ${decay.severity}」的层位引用缺失（layerId: ${decay.layerId}）`
      })
    }
  }

  for (const step of repairSteps) {
    if (!decayIds.has(step.decayId)) {
      broken.push({
        childTable: 'repairSteps',
        childId: step.id,
        childName: `${step.name}（第${step.seq}道）`,
        parentTable: 'decays',
        parentId: step.decayId,
        message: `工序「${step.name}（第${step.seq}道）」的病害引用缺失（decayId: ${step.decayId}）`
      })
    }
  }

  return broken
}

/** 从当前主表数据组装某座殿宇的快照 */
export function buildSnapshot(
  hall: Hall,
  elements: Element[],
  layers: PaintLayer[],
  decays: Decay[],
  repairSteps: RepairStep[]
): VersionSnapshot {
  const hallElementIds = new Set(elements.filter((el) => el.hallId === hall.id).map((el) => el.id))
  const hallLayers = layers.filter((layer) => hallElementIds.has(layer.elementId))
  const hallLayerIds = new Set(hallLayers.map((layer) => layer.id))
  const hallDecays = decays.filter((decay) => hallLayerIds.has(decay.layerId))
  const hallDecayIds = new Set(hallDecays.map((decay) => decay.id))
  const hallSteps = repairSteps.filter((step) => hallDecayIds.has(step.decayId))

  return {
    hall,
    elements: elements.filter((el) => el.hallId === hall.id),
    layers: hallLayers,
    decays: hallDecays,
    repairSteps: hallSteps
  }
}
