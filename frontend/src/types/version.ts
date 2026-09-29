/** 档案版本：草稿（可编辑）或已归档（历史快照，不可变） */
export type VersionStatus = 'draft' | 'archived'

/** 归档时固化的一整份殿宇数据快照 */
export interface VersionSnapshot {
  hall: import('./hall').Hall
  elements: import('./element').Element[]
  layers: import('./layer').PaintLayer[]
  decays: import('./decay').Decay[]
  repairSteps: import('./repair').RepairStep[]
}

/** 档案版本记录：每座殿宇的每次会审留档 */
export interface ArchiveVersion {
  id: string
  /** 版本号，同一殿宇内从 1 递增 */
  versionNo: number
  /** 所属殿宇 id */
  hallId: string
  status: VersionStatus
  /** 版本说明（会审场次、复查事由等） */
  note: string
  /** 归档时间戳，草稿为 null */
  archivedAt: number | null
  createdAt: number
  updatedAt: number
  /** 固化的快照数据 */
  snapshot: VersionSnapshot
}

/** 断开的引用记录：子记录指向了不存在的父记录 */
export interface BrokenRef {
  /** 子记录所在表 */
  childTable: 'elements' | 'layers' | 'decays' | 'repairSteps'
  /** 子记录 id */
  childId: string
  /** 子记录名称（用于展示） */
  childName: string
  /** 缺失的父记录所在表 */
  parentTable: 'halls' | 'elements' | 'layers' | 'decays'
  /** 缺失的父记录 id */
  parentId: string
  /** 人类可读描述 */
  message: string
}

/** 快照校验结果 */
export interface SnapshotValidation {
  valid: boolean
  broken: BrokenRef[]
}
