/**
 * lib/hostdeps.mjs —— 从宿主那棵树里取 `@deepseek-ai/*`
 * ============================================================================
 * 起因：`@deepseek-ai/dsh-tools` / `@deepseek-ai/schemastery` 在桌面版 profile 里
 * 常常是 **optional peer**（`autoInstallPeers: false`），裸 import 会让整条插件不激活，
 * DSH 只留一句 `warning: 1 entry did not activate … failed to import`。
 *
 * 策略：
 *   ① 先找宿主自己的 node_modules（跟宿主用同一份，行为最一致）；
 *   ② 再试插件自己那份 `dependencies`；
 *   ③ 都拿不到 —— **插件照常加载**：`defineTool` 退化成恒等函数，`z` 返回 null（没有 Config）。
 *      宁可少一个设置项，也不能让整条插件不激活。
 * ============================================================================
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SELF = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@deepseek-ai')

function candidateRoots() {
  const out = []
  const push = (p) => { if (p && !out.includes(p)) out.push(p) }
  push(process.env.DSH_HOST_MODULES)

  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  try {
    for (const prof of readdirSync(join(dshHome, 'profiles'))) {
      push(join(dshHome, 'profiles', prof, 'node_modules', '@deepseek-ai'))
    }
  } catch { /* 没有就算了 */ }

  push('/usr/local/lib/node_modules/@deepseek-ai')
  push('/usr/lib/node_modules/@deepseek-ai')
  push(SELF)
  return out
}

function entryOf(dir) {
  const pj = join(dir, 'package.json')
  if (!existsSync(pj)) return null
  try {
    const meta = JSON.parse(readFileSync(pj, 'utf8'))
    const main = meta.main || 'index.js'
    return join(dir, main)
  } catch { return join(dir, 'index.js') }
}

async function tryImport(pkg) {
  for (const root of candidateRoots()) {
    const dir = join(root, pkg)
    if (!existsSync(dir)) continue
    const entry = entryOf(dir)
    if (!entry || !existsSync(entry)) continue
    try { return await import(pathToFileURL(entry).href) } catch { /* 换下一个 */ }
  }
  try { return await import(pkg) } catch { return null }
}

let cached
export async function loadHostDeps() {
  if (cached) return cached
  const tools = await tryImport('dsh-tools')
  const schema = await tryImport('schemastery')
  cached = {
    defineTool: tools?.defineTool || ((spec) => spec),
    z: schema?.default || schema || null,
  }
  return cached
}
