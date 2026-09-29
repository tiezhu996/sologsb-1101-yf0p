// 临时端到端校验脚本：用 esbuild 打包纯逻辑（db 层用内存桩替换），在 Node 内跑通
// 引用完整性校验、初始版本、旧备份识别/归并、追加导入的版本链 remap。
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'

const virtualStub = `
export function createId(prefix) {
  createId._n = (createId._n ?? 0) + 1
  return prefix + '_' + createId._n.toString(36)
}
export const DB_VERSION = 3
export const db = {}
export async function clearAllTables() {}
export function stampBackupTime() {}
`

const result = await build({
  entryPoints: ['scripts/archive-logic.entry.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': new URL('../src', import.meta.url).pathname },
  plugins: [
    {
      name: 'stub-db',
      setup(b) {
        b.onResolve({ filter: /^@\/utils\/db$/ }, () => ({ path: 'db-stub', namespace: 'stub' }))
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: virtualStub, resolveDir: '.' }))
      }
    }
  ]
})

const bundleUrl = new URL('./_archive_bundle.mjs', import.meta.url)
writeFileSync(bundleUrl, result.outputFiles[0].text)
process.on('exit', () => rmSync(bundleUrl, { force: true }))
const mod = await import(bundleUrl.href)
const failures = []
function check(name, cond, detail = '') {
  if (cond) console.log('  ✓', name)
  else {
    failures.push(name)
    console.error('  ✗', name, detail)
  }
}

const {
  validateBundle,
  collectHallBundle,
  buildInitialArchive,
  validateBackup,
  attachInitialVersions,
  remapIds
} = mod

const now = 1
const hall = { id: 'h1', name: '大雄宝殿', era: '明', structureType: '大木', roofType: '庑殿', currentVersionId: null, createdAt: now, updatedAt: now }
const element = { id: 'e1', hallId: 'h1', position: '檐下', name: '额枋', layerCount: 1, baseLayer: '一麻五灰', status: '待修', createdAt: now, updatedAt: now }
const layer = { id: 'l1', elementId: 'e1', level: 1, patternName: '旋子', pigment: '石青', thicknessMm: 1.5, createdAt: now, updatedAt: now }
const decay = { id: 'd1', layerId: 'l1', type: '起甲', severity: '重度', areaCm2: 10, causeGuess: '', repaired: false, repairedAt: null, createdAt: now, updatedAt: now }
const step = { id: 's1', decayId: 'd1', seq: 1, name: '除尘', material: '', operator: '', state: '未开始', createdAt: now, updatedAt: now }

console.log('1) 完整数据包校验通过')
{
  const bundle = { hall, elements: [element], layers: [layer], decays: [decay], repairSteps: [step] }
  const broken = validateBundle(bundle)
  check('完整包无断链', broken.length === 0, JSON.stringify(broken))
}

console.log('2) 各级父级缺失 / 悬空引用都能检出')
{
  const bundle = {
    hall,
    elements: [{ ...element, hallId: 'ghost' }],
    layers: [{ ...layer, elementId: 'ghost' }],
    decays: [{ ...decay, layerId: 'ghost' }],
    repairSteps: [{ ...step, decayId: 'ghost' }]
  }
  const broken = validateBundle(bundle)
  check('四类外键断链全部检出', broken.length === 4, broken.map((b) => b.entity).join(','))
  check('断链带 field 与定位信息', broken.every((b) => b.field && b.message && b.label))
}

console.log('3) 殿宇主记录缺失被拦截')
{
  const bundle = { hall: null, elements: [element], layers: [], decays: [], repairSteps: [] }
  const broken = validateBundle(bundle)
  check('hall 缺失排在首位', broken[0]?.entity === 'hall' && broken.length >= 1)
}

console.log('4) 同表 id 重复检出')
{
  const bundle = { hall, elements: [element, element], layers: [], decays: [], repairSteps: [] }
  const broken = validateBundle(bundle)
  check('重复 element id 被标记', broken.some((b) => b.entity === 'element' && b.field === 'id'))
}

console.log('5) collectHallBundle 沿层级精确归属（不串殿宇）')
{
  const other = { ...hall, id: 'h2', name: '后殿' }
  const e2 = { ...element, id: 'e2', hallId: 'h2' }
  const l2 = { ...layer, id: 'l2', elementId: 'e2' }
  const d2 = { ...decay, id: 'd2', layerId: 'l2' }
  const s2 = { ...step, id: 's2', decayId: 'd2' }
  const b1 = collectHallBundle('h1', [hall, other], [element, e2], [layer, l2], [decay, d2], [step, s2])
  check('只收集本殿宇一条链', b1.elements.length === 1 && b1.layers.length === 1 && b1.decays.length === 1 && b1.repairSteps.length === 1)
}

console.log('6) 旧备份识别：无 archives 字段 -> legacy；有字段 -> 非 legacy')
{
  const legacyPayload = { app: 'gbmuralarch', halls: [], elements: [], layers: [], decays: [], repairSteps: [] }
  const r1 = validateBackup(legacyPayload)
  check('无 archives 判定为旧备份', r1.ok && r1.legacy === true)

  const fresh = { ...legacyPayload, archives: [] }
  const r2 = validateBackup(fresh)
  check('带空 archives 判定为新版本', r2.ok && r2.legacy === false)

  const broken = { ...legacyPayload, archives: {} }
  const r3 = validateBackup(broken)
  check('archives 类型错误判为损坏而非旧备份', !r3.ok && r3.errors.some((e) => e.includes('archives')))
}

console.log('7) 旧备份归并：每座殿宇生成 seq=0 初始版本，指针回指')
{
  const payload = {
    app: 'gbmuralarch', dbVersion: 2, exportedAt: '2025-01-01T00:00:00.000Z',
    halls: [hall], elements: [element], layers: [layer], decays: [decay], repairSteps: [step], archives: []
  }
  const merged = attachInitialVersions(payload)
  check('生成 1 份初始版本', merged.archives.length === 1)
  const init = merged.archives[0]
  check('初始版本 seq=0 / snapshot / import-initial', init.seq === 0 && init.kind === 'snapshot' && init.origin === 'import-initial')
  check('parentId 为 null（版本起点）', init.parentId === null)
  check('整包内容完整', init.bundle.hall.id === 'h1' && init.bundle.decays[0].id === 'd1' && init.bundle.repairSteps[0].id === 's1')
  check('记录来源导出时间', init.sourceExportedAt === '2025-01-01T00:00:00.000Z')
  check('殿宇 currentVersionId 指向初始版本', merged.halls[0].currentVersionId === init.id)
}

console.log('8) 断链拦截针对「包内」引用不完整：闭合子树外的全局悬空记录不归入本殿宇')
{
  const payload = {
    app: 'gbmuralarch', dbVersion: 1, exportedAt: 'x',
    halls: [hall], elements: [], layers: [], decays: [], repairSteps: [], archives: []
  }
  const merged = attachInitialVersions(payload)
  check('空殿宇初始版本无断链', merged.archives[0].brokenRefs.length === 0)

  // 全局悬空工序（decayId 指向不存在的病害）无法沿链归属到任何殿宇，
  // 不会被收进殿宇闭合子树；但只要它出现在某个待归档的包内，validateBundle 必须拦截。
  const orphanStep = { ...step }
  const rawBundle = collectHallBundle('h1', [hall], [], [], [], [orphanStep])
  check('悬空工序不进入闭合子树（无法归属）', rawBundle.repairSteps.length === 0)

  const bundleWithOrphan = { hall, elements: [], layers: [], decays: [], repairSteps: [orphanStep] }
  const rec = buildInitialArchive({ id: 'arch_broken', bundle: bundleWithOrphan, sourceExportedAt: 'x', now: 1 })
  check('包内悬空工序被初始版本记入 brokenRefs', rec.brokenRefs.some((b) => b.entity === 'repairStep' && b.field === 'decayId'))
}

console.log('9) 追加导入 remap：业务 id 与版本链 id 全部重写且保持引用')
{
  const merged = attachInitialVersions({
    app: 'gbmuralarch', dbVersion: 2, exportedAt: 'x',
    halls: [hall], elements: [element], layers: [layer], decays: [decay], repairSteps: [step], archives: []
  })
  // 再模拟一份「会审归档」：初始版本之上有 V1 快照；V1 捕获时当前版本指针指向初始版本
  const init = merged.archives[0]
  const v1 = {
    ...init,
    id: 'arch_v1',
    kind: 'snapshot',
    seq: 1,
    parentId: init.id,
    restoredFromId: null,
    title: '第 1 次会审',
    archivedAt: 2,
    updatedAt: 2,
    brokenRefs: [],
    bundle: {
      ...init.bundle,
      hall: { ...init.bundle.hall, currentVersionId: init.id }
    }
  }
  const hallsV1 = [{ ...merged.halls[0], currentVersionId: 'arch_v1' }]
  const payload = { ...merged, halls: hallsV1, archives: [init, v1] }

  const remapped = remapIds(payload, false)
  const [newInit, newV1] = remapped.archives
  check('档案 id 已重写', newInit.id !== init.id && newV1.id !== 'arch_v1')
  check('版本链 parentId 指向重写后的初始版本', newV1.parentId === newInit.id)
  check('殿宇 currentVersionId 指向重写后的 V1', remapped.halls[0].currentVersionId === newV1.id)
  check('业务外键链保持一致',
    remapped.elements[0].hallId === remapped.halls[0].id &&
    remapped.layers[0].elementId === remapped.elements[0].id &&
    remapped.decays[0].layerId === remapped.layers[0].id &&
    remapped.repairSteps[0].decayId === remapped.decays[0].id)
  check('档案包内 id 与顶层一致', newV1.bundle.hall.id === remapped.halls[0].id && newV1.bundle.decays[0].id === remapped.decays[0].id)
  check('包内 hall 版本指针重写到重写后的父版本', newV1.bundle.hall.currentVersionId === newInit.id)
  check('初始版本包内历史指针（null）被保留', newInit.bundle.hall.currentVersionId === null)
}

console.log('10) buildInitialArchive 字段完整性')
{
  const bundle = { hall, elements: [element], layers: [layer], decays: [decay], repairSteps: [step] }
  const rec = buildInitialArchive({ id: 'arch_x', bundle, sourceExportedAt: 't', now })
  check('标题为初始版本', rec.title === '初始版本' && rec.seq === 0)
  check('bundle 为深拷贝（改原数据不影响档案）', (() => {
    element.name = '被改名了'
    return rec.bundle.elements[0].name === '额枋'
  })())
}

if (failures.length > 0) {
  console.error('\n失败用例：', failures.length)
  process.exit(1)
}
console.log('\n全部用例通过')
