import 'fake-indexeddb/auto'
import { effectScope, nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'

// Node 环境没有 localStorage，用内存 Map 桩满足 UI 偏好写入
const lsStore = new Map()
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => lsStore.set(k, String(v)),
  removeItem: (k) => lsStore.delete(k),
  clear: () => lsStore.clear()
}

import { db } from '@/utils/db'
import { useHallStore } from '@/stores/hallStore'
import { useDecayStore } from '@/stores/decayStore'
import { useRepairStore } from '@/stores/repairStore'
import { useArchiveStore, ArchiveValidationError } from '@/stores/archiveStore'
import { importBackup } from '@/utils/export'

export async function run() {
  const failures = []
  const scope = effectScope()
  function check(name, cond, detail = '') {
    if (cond) console.log('  ✓', name)
    else {
      failures.push(name)
      console.error('  ✗', name, detail)
    }
  }
  const waitFor = async (pred, msg, timeout = 4000) => {
    const start = Date.now()
    while (!(await pred())) {
      if (Date.now() - start > timeout) throw new Error('等待数据超时：' + msg)
      await nextTick()
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  await scope.run(async () => {
    setActivePinia(createPinia())
    const hallStore = useHallStore()
    const decayStore = useDecayStore()
    const repairStore = useRepairStore()
    const archiveStore = useArchiveStore()

    console.log('A) 建立一座殿宇的完整业务数据')
    const hall = await hallStore.createHall({
      name: '大雄宝殿', era: '明嘉靖', structureType: '大木', roofType: '庑殿'
    })
    const element = await hallStore.createElement({
      hallId: hall.id, position: '檐下', name: '前檐额枋', layerCount: 0, baseLayer: '一麻五灰', status: '待修'
    })
    const layer = await hallStore.createLayer({
      elementId: element.id, level: 1, patternName: '旋子', pigment: '石青', thicknessMm: 1.6
    })
    // 档案包按 elementId 收集层位，不依赖 layerCount；这里直接等层位落库
    await waitFor(async () => (await db.layers.toArray()).length === 1, '层位落库')
    const d = await decayStore.createDecay({
      layerId: layer.id, type: '起甲', severity: '重度', areaCm2: 12,
      causeGuess: '渗水', repaired: false, repairedAt: null
    })
    await repairStore.addStep({ decayId: d.id, name: '除尘', material: '毛刷', operator: '张三' })
    await waitFor(() => repairStore.steps.length === 1, '工序 liveQuery', 4000)

    console.log('B) 建草稿，整包打包四类记录')
    const draft = await archiveStore.createDraft({ hallId: hall.id, title: '会审草稿' })
    check('草稿 seq=null / kind=draft', draft.seq === null && draft.kind === 'draft')
    check('草稿 parentId 为 null（殿宇从未归档）', draft.parentId === null)
    check('整包含 构件/层位/病害/工序',
      draft.bundle.elements.length === 1 &&
      draft.bundle.layers.length === 1 &&
      draft.bundle.decays.length === 1 &&
      draft.bundle.repairSteps.length === 1)
    check('草稿无断链', draft.brokenRefs.length === 0, JSON.stringify(draft.brokenRefs))

    console.log('C) 归档为 V1，并回写殿宇当前版本指针')
    const v1 = await archiveStore.archiveDraft(draft.id, { title: '第一次会审' })
    check('归档后为 snapshot / seq=1', v1.kind === 'snapshot' && v1.seq === 1)
    const hallRow1 = await db.halls.get(hall.id)
    check('殿宇 currentVersionId 指向 V1', hallRow1.currentVersionId === v1.id)
    check('原草稿记录已转为快照（不残留重复草稿）',
      (await db.archives.where('hallId').equals(hall.id).toArray()).filter((r) => r.kind === 'draft').length === 0)

    console.log('D) 再建草稿并归档为 V2，版本链 parentId=V1')
    const draft2 = await archiveStore.createDraft({ hallId: hall.id })
    await waitFor(() => archiveStore.draftOfHall(hall.id)?.id === draft2.id, '草稿2 liveQuery')
    check('新草稿 parentId=V1', draft2.parentId === v1.id)
    const v2 = await archiveStore.archiveDraft(draft2.id, { title: '第二次会审' })
    check('V2 seq=2 且 parentId=V1', v2.seq === 2 && v2.parentId === v1.id)
    const hallRow2 = await db.halls.get(hall.id)
    check('当前版本指针更新为 V2', hallRow2.currentVersionId === v2.id)

    console.log('E) 断链草稿归档被拦截，整批不留半成品')
    const draft3 = await archiveStore.createDraft({ hallId: hall.id })
    const archiveCountBefore = (await db.archives.toArray()).length
    // 人为制造包内引用不完整：把病害的 layerId 改成不存在的层位
    await db.archives.update(draft3.id, {
      bundle: {
        ...draft3.bundle,
        decays: draft3.bundle.decays.map((x) => ({ ...x, layerId: 'layer_ghost' }))
      }
    })
    let blocked = null
    try {
      await archiveStore.archiveDraft(draft3.id, { title: '不应成功' })
    } catch (err) {
      blocked = err
    }
    check('抛出 ArchiveValidationError', blocked instanceof ArchiveValidationError)
    check('拦截原因含 decay 断链', !!blocked && blocked.brokenRefs.some((b) => b.entity === 'decay' && b.field === 'layerId'))
    const archiveCountAfter = (await db.archives.toArray()).length
    check('档案总数未增加（无半成品快照）', archiveCountAfter === archiveCountBefore)
    const draft3After = await db.archives.get(draft3.id)
    check('草稿仍是 draft（未被错误转为快照）', draft3After.kind === 'draft')
    check('断链明细已落盘到草稿，供档案页指出', draft3After.brokenRefs.some((b) => b.entity === 'decay'))
    const hallRow3 = await db.halls.get(hall.id)
    check('殿宇当前版本指针仍停在 V2', hallRow3.currentVersionId === v2.id)
    // 修复断链后刷新草稿即可再次归档
    await archiveStore.refreshDraft(draft3.id)
    check('刷新后断链清空', (await db.archives.get(draft3.id)).brokenRefs.length === 0)

    console.log('F) 恢复 V1 为当前版本：工作数据回退，V1/V2 档案都保留')
    // 在工作数据里新增一个 V1 之后才有的构件，验证恢复会清除它
    await hallStore.createElement({
      hallId: hall.id, position: '室内', name: '恢复后应消失的构件', layerCount: 0, baseLayer: '单披灰', status: '观察'
    })
    await waitFor(
      async () => (await db.elements.where('hallId').equals(hall.id).toArray()).length === 2,
      '新增构件落库'
    )
    const restoredDraft = await archiveStore.restoreSnapshot(v1.id, { withDraft: true })
    const liveElements = await db.elements.where('hallId').equals(hall.id).toArray()
    check('恢复后只剩 V1 包内的 1 个构件（新增构件已清除）', liveElements.length === 1 && liveElements[0].id === element.id)
    const liveDecays = await db.decays.toArray()
    const liveSteps = await db.repairSteps.toArray()
    check('病害 / 工序与 V1 包一致', liveDecays.length === v1.bundle.decays.length && liveSteps.length === v1.bundle.repairSteps.length)
    const hallRow4 = await db.halls.get(hall.id)
    check('恢复后当前版本指针回到 V1', hallRow4.currentVersionId === v1.id)
    const archivesAll = await db.archives.toArray()
    check('原 V1 快照仍保留', archivesAll.some((r) => r.id === v1.id && r.kind === 'snapshot'))
    check('其后归档的 V2 快照仍保留', archivesAll.some((r) => r.id === v2.id && r.kind === 'snapshot'))
    check('恢复派生草稿 origin=restore 且 parentId=V1',
      restoredDraft && restoredDraft.origin === 'restore' && restoredDraft.parentId === v1.id && restoredDraft.restoredFromId === v1.id)

    console.log('G) 删除殿宇工作数据后档案成为「断开档案」，恢复可重建殿宇')
    await hallStore.removeHall(hall.id)
    await waitFor(
      async () =>
        (await db.halls.get(hall.id)) === undefined &&
        (await db.elements.where('hallId').equals(hall.id).toArray()).length === 0,
      '殿宇工作数据已删'
    )
    check('档案未被级联删除', (await db.archives.where('hallId').equals(hall.id).toArray()).length >= 3)
    await waitFor(() => archiveStore.orphanArchives.some((r) => r.hallId === hall.id), 'orphan 计算属性更新')
    check('档案页可见断开档案', archiveStore.orphanArchives.some((r) => r.hallId === hall.id))
    await archiveStore.restoreSnapshot(v1.id, { withDraft: false })
    const rebuiltHall = await db.halls.get(hall.id)
    check('殿宇主记录已重建', !!rebuiltHall && rebuiltHall.name === '大雄宝殿')
    check('重建后构件链恢复', (await db.elements.where('hallId').equals(hall.id).toArray()).length === 1)

    console.log('H) 旧备份覆盖导入：每座殿宇归为初始版本（seq=0）')
    const legacy = {
      app: 'gbmuralarch',
      dbVersion: 1,
      exportedAt: '2024-06-01T00:00:00.000Z',
      halls: [{
        id: 'legacy_h', name: '旧殿', era: '清', structureType: '小式', roofType: '歇山',
        currentVersionId: undefined, createdAt: 1, updatedAt: 1
      }],
      elements: [{
        id: 'legacy_e', hallId: 'legacy_h', position: '天花', name: '旧构件', layerCount: 1,
        baseLayer: '单披灰', status: '完好', createdAt: 1, updatedAt: 1
      }],
      layers: [{
        id: 'legacy_l', elementId: 'legacy_e', level: 1, patternName: '苏式', pigment: '土黄',
        thicknessMm: 1, createdAt: 1, updatedAt: 1
      }],
      decays: [],
      repairSteps: []
    }
    const res = await importBackup(legacy, true, true)
    check('导入返回初始版本数=1', res.initials === 1)
    const legacyArch = await db.archives.where('hallId').equals('legacy_h').first()
    check('初始版本 seq=0 / origin=import-initial', legacyArch.seq === 0 && legacyArch.origin === 'import-initial')
    check('初始版本无父版本', legacyArch.parentId === null)
    check('记录旧备份导出时间', legacyArch.sourceExportedAt === '2024-06-01T00:00:00.000Z')
    const legacyHallRow = await db.halls.get('legacy_h')
    check('殿宇指针指向初始版本', legacyHallRow.currentVersionId === legacyArch.id)
    check('旧 Hall 缺失的 currentVersionId 字段已补', legacyHallRow.currentVersionId !== undefined)
    check('初始版本整包含构件与层位', legacyArch.bundle.elements.length === 1 && legacyArch.bundle.layers.length === 1)
  })

  if (failures.length > 0) {
    console.error('\n集成测试失败：', failures.length, failures.join('；'))
    process.exitCode = 1
  } else {
    console.log('\n全部集成测试通过')
  }
}
