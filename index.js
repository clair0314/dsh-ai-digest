/**
 * dsh-ai-digest —— host 半端
 * ============================================================================
 * 它是什么：把「每天扫一遍 B站 / 小红书 / 抖音 的 AI 内容，挑出值得看的，写成日报，
 * 推到飞书」这套手工流程做成插件。三件事都在插件里：
 *
 *   1. **采集**（`scripts/collect.py`）：24 个关键词 × 最新/最热 + 一串 AI/科技 UP 主的新片，
 *      打分排序（播放速度 × 互动率），写 `data/candidates.json`。
 *   2. **补料**（`scripts/enrich.py`）：按 BV 号补播放/点赞/收藏/评论，**评论是判断标题党
 *      的唯一可靠信号** —— 所以这一步不是可选的。
 *   3. **推送**（`scripts/push_feishu.py`）：日报 markdown → 飞书卡片。
 *
 * 家目录（`$DSH_HOME/ai-digest/`）：`data/` 原始数据、`reports/` 日报、`profile.md` 兴趣画像。
 * 脚本留在插件包里不放家里 —— 这样插件升级时代码是新的，数据还是用户的。
 * ============================================================================
 */
import { loadHostDeps } from './lib/hostdeps.mjs'

const host = await loadHostDeps()
const z = host.z
const defineTool = host.defineTool

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))

export const name = 'ai-digest'
export const inject = ['tools']

export const Config = !z ? undefined : z.object({
  /** 用哪个 Python 跑采集（留空 = 自动找：先看插件自己的 venv，再看 bili-duty 的，最后 python3） */
  pythonPath: z.string().default('').extra('volatile', true),
  /** 飞书自定义机器人 webhook；留空则复用 ~/.qq-digest/config.json 里那个 */
  feishuWebhook: z.string().default('').extra('volatile', true),
  /** 飞书机器人开了「签名校验」才需要填 */
  feishuSecret: z.string().default('').extra('volatile', true),
  /** 每天最多挑几条进日报 */
  perDay: z.natural().default(15).extra('volatile', true),
})

const textOutput = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, value) => [{
    type: 'text',
    text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  }],
}

export function apply(ctx, config) {
  const home = process.env.DIGEST_HOME
    || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'ai-digest')

  const dirs = {
    home,
    data: join(home, 'data'),
    reports: join(home, 'reports'),
    venv: join(home, 'venv'),
    profile: join(home, 'profile.md'),
    scripts: join(PLUGIN_DIR, 'scripts'),
  }

  const ensureHome = () => {
    for (const d of [dirs.home, dirs.data, dirs.reports]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
    }
    // 兴趣画像：第一次跑时从插件里铺一份出去，之后是用户的文件，升级不覆盖
    if (!existsSync(dirs.profile)) {
      try { writeFileSync(dirs.profile, readFileSync(join(PLUGIN_DIR, 'profile.md'), 'utf8')) } catch { /* 没有就算了 */ }
    }
  }
  ensureHome()

  /** 三个候选 python，按「真的能 import bilibili_api」的顺序挑 */
  const pythonCandidates = () => {
    const out = []
    const push = (p) => { if (p && !out.includes(p)) out.push(p) }
    push(config?.pythonPath)
    push(process.env.AI_DIGEST_PYTHON)
    push(join(dirs.venv, 'bin', 'python'))
    push(join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-duty', '.venv', 'bin', 'python'))
    push('python3')
    return out
  }

  let pythonCache = ''
  const whichPython = () => pythonCache || pythonCandidates()[0]

  /** 跑一段 python / shell，带回 stdout+stderr，超时 kill */
  const run = (cmd, args, { cwd = dirs.home, timeout = 300000, env = {} } = {}) => new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, DIGEST_HOME: dirs.home, PYTHONIOENCODING: 'utf-8', ...env },
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const timer = setTimeout(() => {
      if (!done) { done = true; try { child.kill('SIGKILL') } catch { /* 已经没了 */ } resolve({ ok: false, code: -1, stdout, stderr: `${stderr}\n超时（${timeout / 1000}s）` }) }
    }, timeout)
    child.stdout.on('data', (b) => { stdout += b.toString() })
    child.stderr.on('data', (b) => { stderr += b.toString() })
    child.on('error', (e) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ ok: false, code: -2, stdout, stderr: `${stderr}\n${e.message}` })
    })
    child.on('close', (code) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve({ ok: code === 0, code, stdout, stderr })
    })
  })

  const py = (script, args = [], opts = {}) => run(whichPython(), [join(dirs.scripts, script), ...args], opts)

  /** 挑一个能用的 python（第一次调用时探一下，探不到就把 fail 原因留着） */
  let probeMemo = null
  const probe = async () => {
    if (probeMemo) return probeMemo
    for (const candidate of pythonCandidates()) {
      const r = await run(candidate, ['-c', 'import bilibili_api, sys; print(sys.executable)'], { timeout: 20000 })
      if (r.ok) {
        pythonCache = candidate
        probeMemo = { ok: true, python: candidate.trim(), version: r.stdout.trim() }
        return probeMemo
      }
    }
    probeMemo = { ok: false, hint: '没找到装了 bilibili_api 的 Python。跑一次 digest_setup 让插件自己建 venv 并装依赖。' }
    return probeMemo
  }

  const latestReport = () => {
    try {
      const files = readdirSync(dirs.reports).filter((f) => f.endsWith('.md')).sort()
      return files.length ? join(dirs.reports, files[files.length - 1]) : ''
    } catch { return '' }
  }

  const tool = (spec) => ctx.tools.register(defineTool({
    ...spec,
    output: spec.output || textOutput,
    async execute(args, exec) {
      const v = await spec.execute(args, exec)
      try { return JSON.parse(JSON.stringify(v)) } catch { return String(v) }
    },
  }))

  /* ───────────────────────── 工具 ───────────────────────── */

  tool({
    name: 'digest_status',
    description: '看这个「AI 情报日报」插件现在是什么状态：家目录在哪、Python 能不能用、最新一份日报是哪天、飞书通道配好没有。第一次用先看这个。',
    parameters: {},
    async execute() {
      const p = await probe()
      const report = latestReport()
      return {
        home: dirs.home,
        python: p.ok ? p.python : '未就绪',
        pythonHint: p.ok ? undefined : p.hint,
        pythonTried: pythonCandidates(),
        latestReport: report || '还没有',
        profile: existsSync(dirs.profile) ? dirs.profile : '（下次采集时自动生成）',
        feishu: config?.feishuWebhook ? '已配置（插件设置）' : (existsSync(join(homedir(), '.qq-digest', 'config.json')) ? '复用 ~/.qq-digest 里的 webhook' : '未配置'),
      }
    },
  })

  tool({
    name: 'digest_setup',
    description: '建一个插件自己的 Python venv 并把采集依赖（bilibili-api-python）装上。第一次用或换机器时跑一次；要下几十 MB，约 1-2 分钟。',
    parameters: {},
    async execute() {
      if (!existsSync(join(dirs.venv, 'bin', 'python'))) {
        const mk = await run('python3', ['-m', 'venv', dirs.venv], { timeout: 120000 })
        if (!mk.ok) return { ok: false, step: 'venv', stderr: mk.stderr.slice(-800) }
      }
      const pip = join(dirs.venv, 'bin', 'pip')
      const inst = await run(pip, ['install', '--upgrade', 'pip', 'bilibili-api-python'], { timeout: 420000 })
      pythonCache = ''
      probeMemo = null
      const p = await probe()
      return {
        ok: inst.ok && p.ok,
        venv: dirs.venv,
        python: p.ok ? p.python : '',
        tail: (inst.stdout + inst.stderr).split('\n').filter(Boolean).slice(-6).join('\n'),
      }
    },
  })

  tool({
    name: 'digest_collect',
    description: '扫一轮 B站：关键词搜索（最新 + 最热）+ 关注 UP 主的新片，按「播放速度 × 互动率」打分，写进 data/candidates.json 并返回排名靠前的若干条。\n'
      + '⚠️ 这只是候选池，**不代表值得看** —— 下一步要用 digest_enrich 补评论，再人工（或模型）判断。',
    parameters: {
      top: { type: 'number', description: '返回前几条（默认 20）' },
    },
    async execute(args) {
      const p = await probe()
      if (!p.ok) return { ok: false, hint: p.hint }
      const r = await py('collect.py', [], { timeout: 600000 })
      if (!r.ok) return { ok: false, code: r.code, tail: (r.stdout + r.stderr).slice(-1200) }
      let total = 0
      let d1 = 0
      try {
        const data = JSON.parse(readFileSync(join(dirs.data, 'candidates.json'), 'utf8'))
        total = data.videos?.length || 0
        d1 = (data.videos || []).filter((v) => v.age_days <= 1).length
      } catch { /* 文件没写出来就只回 stdout */ }
      const topN = Math.max(1, Math.min(Number(args.top) || 20, 60))
      const top = (r.stdout || '').split('\n').filter((l) => l.trim()).slice(-topN)
      return {
        ok: true,
        total,
        within24h: d1,
        file: join(dirs.data, 'candidates.json'),
        top: top.join('\n'),
      }
    },
  })

  tool({
    name: 'digest_enrich',
    description: '给选中的视频补料：播放/点赞/收藏/评论数、时长、简介前 300 字、前 4 条高赞评论。**读评论是判断标题党的唯一可靠办法**，别跳过这步。',
    parameters: {
      bvids: { type: 'array', items: { type: 'string' }, description: 'BV 号列表，一次别超过 15 个' },
    },
    async execute(args) {
      const p = await probe()
      if (!p.ok) return { ok: false, hint: p.hint }
      const list = (args.bvids || []).map(String).filter(Boolean).slice(0, 15)
      if (!list.length) return { ok: false, hint: '给几个 BV 号，例如 ["BV1cVW86JE2e"]' }
      const r = await py('enrich.py', list, { timeout: 300000 })
      return { ok: r.ok, count: list.length, text: (r.stdout || r.stderr).slice(0, 12000) }
    },
  })

  tool({
    name: 'digest_push',
    description: '把一份日报 markdown 推到飞书（自定义机器人卡片）。不传 path 就推最新那份。表格会自动转成列表，因为飞书卡片不渲染 markdown 表格。',
    parameters: {
      path: { type: 'string', description: 'markdown 文件路径；留空 = reports/ 里最新的那份' },
    },
    async execute(args) {
      const file = args.path ? String(args.path) : latestReport()
      if (!file || !existsSync(file)) return { ok: false, hint: '没有可推的日报：先写一份到 reports/ 或传 path' }
      const r = await run(whichPython(), [join(dirs.scripts, 'push_feishu.py'), file], {
        timeout: 60000,
        env: {
          ...(config?.feishuWebhook ? { FEISHU_WEBHOOK: config.feishuWebhook } : {}),
          ...(config?.feishuSecret ? { FEISHU_SECRET: config.feishuSecret } : {}),
        },
      })
      let res = ''
      try { res = JSON.parse((r.stdout.match(/结果: (\{.*\})/) || [])[1] || '{}') } catch { /* 保留原文 */ }
      return {
        ok: r.ok && (res.code === 0 || res.StatusCode === 0),
        file,
        sent: r.stdout.split('\n').filter((l) => l.startsWith('卡片:')).join(''),
        response: res.code ?? res.StatusCode ?? (r.stdout + r.stderr).slice(-400),
      }
    },
  })

  tool({
    name: 'digest_charter',
    description: '取「怎么写这份日报」的完整章程：筛选标准、报告结构、避坑清单、每天怎么跑。写日报前先读它，保证每天的口径一致。返回 markdown 全文。',
    parameters: {},
    async execute() {
      try { return readFileSync(join(PLUGIN_DIR, 'charter.md'), 'utf8') } catch { return 'charter.md 缺失' }
    },
  })
}
