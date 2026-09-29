// 集成测试运行器：用 esbuild 把入口（含 Pinia / Dexie / fake-indexeddb）打包后在 Node 执行。
import { build } from 'esbuild'
import { writeFileSync, rmSync } from 'node:fs'

const srcRoot = new URL('../src', import.meta.url).pathname

const result = await build({
  entryPoints: ['scripts/archive-integration.entry.mjs'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  write: false,
  alias: { '@': srcRoot },
  logLevel: 'warning'
})

const outUrl = new URL('./_archive_integration_bundle.mjs', import.meta.url)
writeFileSync(outUrl, result.outputFiles[0].text)

try {
  const mod = await import(outUrl.href)
  await mod.run()
} finally {
  rmSync(outUrl, { force: true })
}
