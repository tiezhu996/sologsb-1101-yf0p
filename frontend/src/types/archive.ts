import type { Decay } from './decay'
import type { Element } from './element'
import type { Hall } from './hall'
import type { PaintLayer } from './layer'
import type { RepairStep } from './repair'

/** 档案形态：draft 会审草稿（可改），snapshot 历史快照（归档后不可变） */
export type ArchiveKind = 'draft' | 'snapshot'

/** 档案来源：会审手动归档 / 旧备份导入生成的初始版本 / 恢复后继续会审 */
export type ArchiveOrigin = 'manual' | 'import-initial' | 'restore'

/** 引用完整性校验涉及的实体类型 */
export type BrokenEntity = 'hall' | 'element' | 'layer' | 'decay' | 'repairStep'

/** 一次会审按殿宇打包的完整数据：构件、层位、病害、工序与殿宇主记录同批归档 */
export interface ArchiveBundle {
  /** 父级殿宇缺失时为 null，整批不得归档 */
  hall: Hall | null
  elements: Element[]
  layers: PaintLayer[]
  decays: Decay[]
  repairSteps: RepairStep[]
}

/** 断开的引用：归档被拦截时原样返回并在档案页逐条指出 */
export interface BrokenRef {
  entity: BrokenEntity
  /** 出问题的记录 id */
  id: string
  /** 可识别名称（构件名 / 病害类型等），便于勘察人员定位 */
  label: string
  /** 断链字段，如 hallId / elementId / layerId / decayId */
  field: string
  /** 人读描述 */
  message: string
}

/**
 * 会审档案记录。
 * 草稿（kind=draft, seq=null）经归档转为快照（kind=snapshot, seq 按殿宇递增）；
 * parentId 指向上一版快照，形成每座殿宇的版本链。
 */
export interface ArchiveRecord {
  id: string
  hallId: string
  /** 殿宇名冗余存储：殿宇主记录被删后档案页仍能列出断开的档案 */
  hallName: string
  kind: ArchiveKind
  origin: ArchiveOrigin
  title: string
  note: string
  /** 版本序号：草稿为 null；初始版本固定为 0，其后归档依次 1、2、3… */
  seq: number | null
  /** 上一版快照 id，初始版本为 null */
  parentId: string | null
  /** 本记录由哪个快照「恢复成当前版本」后产生 */
  restoredFromId: string | null
  /** 旧备份导入时来源文件的导出时间 */
  sourceExportedAt: string | null
  bundle: ArchiveBundle
  /** 最近一次整包校验发现的断链；成功归档的快照恒为空（初始版本可能保留导入时的断链） */
  brokenRefs: BrokenRef[]
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export const ARCHIVE_ORIGIN_LABELS: Record<ArchiveOrigin, string> = {
  manual: '会审归档',
  'import-initial': '旧备份导入',
  restore: '恢复后会审'
}

export const ARCHIVE_ENTITY_LABELS: Record<BrokenEntity, string> = {
  hall: '殿宇',
  element: '构件',
  layer: '彩画层位',
  decay: '病害',
  repairStep: '修复工序'
}

/** 初始版本固定占用的版本序号 */
export const INITIAL_VERSION_SEQ = 0

/** 版本显示名：草稿 / 初始版本 / V1、V2… */
export function versionLabel(record: Pick<ArchiveRecord, 'kind' | 'seq'>): string {
  if (record.kind === 'draft') return '草稿'
  if (record.seq === INITIAL_VERSION_SEQ) return '初始版本'
  return `V${record.seq}`
}
