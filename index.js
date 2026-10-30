/**
 * dsh-default-model — Host 半边。
 *
 * 目标：让「默认模型」真的定住。用户在这个插件里选一次，之后新建对话、重启
 * Harness 都还是它。
 *
 * 为什么不是「调 saveSelection 写组合条目」那么简单：
 * `sessionController.selectModel()` 在每次「这个对话换个模型」之后都会在后台
 * `agentDefaultModel.saveSelection(selected)`（见 dsh-api-session-controller
 * 的 selectModel），也就是说「任何一个对话里换过模型」都会顺手改写默认模型。
 * 于是默认值永远等于「最后一次在任意对话里点过的模型」，插件写进去的值会被
 * 下一次换模型覆盖 —— 这就是「保存了但新建对话/重启又变回去」的根因。
 *
 * 所以这里的做法是：
 *   1. 选择持久化在插件自己的状态文件里（宿主进程的 DSH_HOME），谁也覆盖不了；
 *   2. 给 `agentDefaultModel.currentSelection()` 装一个只读覆盖，让它永远返回
 *      用户固定的那一份 —— 新会话创建时 `agentOptions()` 读的就是它；
 *   3. 顺手把同一份值镜像写回 profile 组合条目（configEditor），让原生界面、
 *      配置文件、"最后一次选择" 这些旁路看到的值保持一致（失败不影响第 2 步）；
 *   4. 提供一个「解除固定」的出口：解除后立刻回到 Harness 原生行为。
 *
 * 覆盖 `currentSelection` 而不是覆盖 `saveSelection`：前者只改「读默认」这一件事，
 * 不拦任何写入，副作用最小；dsh-model-override 也是同样的猴补丁手法。
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API_PATH = '/dsh-default-model/api'

/** 状态文件名：放在 DSH_HOME 下，跟着用户走，不写进 profile 组合。 */
const STATE_FILE = 'default-model.json'

/** 组合条目 id：Harness 自己那份「默认模型」配置的 id。 */
const NATIVE_ENTRY_ID = 'agent-default-model'

/** 推理档位阶梯，仅作为下拉候选；真值由适配器决定，超出的 id 照样能存。 */
const EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export const name = 'default-model'

export const inject = ['webServer']

/* ------------------------------------------------------------------ 固定状态 */

/** 当前固定下来的选择；null 表示「跟随 Harness 原生默认」。 */
let pinned = null

/** 已安装的覆盖，用于精确卸载（只删自己加的那个属性）。 */
let installed = null

/** 启动阶段的事件序列，落盘成 default-model.boot.json（排障「改了没生效」）。 */
const bootEvents = []

/** 最近一次装覆盖失败的原因，只在排障时给 /state 看。 */
let lastAttachError = ''

/**
 * 读「别处真正会读到的默认值」的探针：每装一次覆盖都用它复核，
 * 而不是在被改的那个对象上自证（宿主可能给 ctx.get() 返回不同包装对象）。
 */
let probeSelection = null

/** 全局唯一的插件日志口；宿主没有 logger 时退化成 console。 */
function loggerOf(ctx) {
  try {
    if (typeof ctx.logger === 'function') return ctx.logger('dsh-default-model')
  } catch { /* logger 不可用 */ }
  return console
}

function stateDir() {
  const home = firstString(process.env.DSH_HOME)
  return home === '' ? join(homedir(), '.dsh') : home
}

function statePath() {
  return join(stateDir(), STATE_FILE)
}

/** 把存盘的记录收敛成一份干净的选择；坏数据当作「没有固定」。 */
function selectionOf(value) {
  if (value === null || typeof value !== 'object') return null
  const provider = firstString(value.provider)
  const model = firstString(value.model)
  if (provider === '' || model === '') return null
  const effort = firstString(value.reasoningEffort)
  return { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }
}

function readPinned() {
  try {
    const path = statePath()
    if (!existsSync(path)) return null
    // 必须先剥 BOM：Windows 上的编辑器、PowerShell 的 Set-Content 都爱写 UTF-8 BOM，
    // 而 JSON.parse 一见到开头的 U+FEFF 就抛错 —— 现象就是「文件明明有内容，却当成没固定」。
    const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
    if (text === '') return null
    return selectionOf(JSON.parse(text))
  } catch {
    return null
  }
}

function writePinned(selection) {
  const path = statePath()
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...selection, savedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8')
}

function clearPinned() {
  try {
    const path = statePath()
    if (existsSync(path)) rmSync(path, { force: true })
  } catch { /* 删不掉也不能影响解除固定 */ }
}

/**
 * 给服务装上只读覆盖。
 *
 * 用 `delete` 而不是「记下原方法再赋值回去」来卸载：原方法在原型上，删除自有
 * 属性就恢复原型查找，不会把原型方法的副本粘到实例上。
 */
function installOverride(service) {
  if (!service || typeof service.currentSelection !== 'function') {
    lastAttachError = service === undefined || service === null ? 'no service' : 'no currentSelection()'
    debugDump(service)
    return false
  }
  if (installed && installed.service === service && installed.applied) {
    debugDump(service)
    return true
  }
  uninstallOverride()
  const hasOwn = (object) => Object.prototype.hasOwnProperty.call(object, 'currentSelection')
  const original = service.currentSelection
  const proto = Object.getPrototypeOf(service)
  const state = {
    service,
    original,
    hadOwn: hasOwn(service),
    proto: null,
    protoOriginal: undefined,
    protoHadOwn: false,
    applied: false,
    via: '',
  }
  installed = state
  const patched = function currentSelection() {
    return pinned === null ? original.call(service) : { ...pinned }
  }

  // 覆盖的落点依次尝试：实例自有属性 → 实例上的不可写属性用 defineProperty →
  // 实例被冻结/封闭时退到原型。Cordis 服务实例通常是普通对象，前一种就够；
  // 后两种是「assign failed」时真正能救场的那一步。
  const attempts = [
    ['own-assign', () => { service.currentSelection = patched }],
    ['own-define', () => {
      Object.defineProperty(service, 'currentSelection', {
        configurable: true, enumerable: false, writable: true, value: patched,
      })
    }],
    ['proto-assign', () => {
      if (!proto) throw new Error('no prototype')
      state.proto = proto
      state.protoHadOwn = hasOwn(proto)
      state.protoOriginal = proto.currentSelection
      proto.currentSelection = patched
    }],
  ]

  const failures = []
  // 用「行为」验证而不是函数身份：服务的 `currentSelection` 可能经过代理包装，
  // 身份比较会误判成没装上。优先通过 ctx.get() 重新取一次服务再读 ——
  // 那才是别处真正调用到的路径（宿主可能每次返回不同包装对象）。
  const verify = () => {
    if (pinned === null) return true
    let value = null
    if (typeof probeSelection === 'function') {
      try { value = probeSelection() } catch { value = null }
    }
    if (!value) {
      try { value = service.currentSelection() } catch { value = null }
    }
    return Boolean(value) && value.provider === pinned.provider && value.model === pinned.model
  }

  for (const [via, attempt] of attempts) {
    try {
      attempt()
      if (!verify()) throw new Error('读回来的仍是旧值')
      state.applied = true
      state.via = via
      break
    } catch (error) {
      failures.push(`${via}: ${String(error?.message ?? error)}`)
      // 换下一种方式之前把上一次可能的残渣擦掉。
      try {
        if (state.proto && state.proto.currentSelection === patched) proto.currentSelection = state.protoOriginal
      } catch { /* 擦不掉就交给下面的统一处理 */ }
      state.proto = null
    }
  }

  if (!state.applied) {
    installed = null
    lastAttachError = failures.join(' | ')
    debugDump(service)
    return false
  }
  lastAttachError = ''
  debugDump(service)
  return true
}

function uninstallOverride() {
  if (!installed) return
  const { service, original, hadOwn, proto, protoOriginal, protoHadOwn } = installed
  installed = null
  try {
    if (proto && proto.currentSelection !== protoOriginal) {
      if (protoHadOwn) proto.currentSelection = protoOriginal
      else delete proto.currentSelection
    }
  } catch { /* 宿主已在拆除 */ }
  try {
    if (hadOwn) service.currentSelection = original
    else delete service.currentSelection
  } catch { /* 宿主已在拆除 */ }
}

/** 读「原生」默认（绕过我们自己的覆盖），用于展示两边的差异。 */
function nativeSelectionOf(ctx) {
  const service = ctx.get('agentDefaultModel')
  if (!service) return undefined
  try {
    // 用「装覆盖时拿到的那个实例 + 它的原方法」读原生值：`ctx.get()` 每次
    // 返回的包装对象不一定同一个，靠身份比较会读错。
    const getter = installed && installed.applied ? installed.original : service.currentSelection
    const target = installed && installed.applied ? installed.service : service
    if (typeof getter !== 'function') return undefined
    const value = getter.call(target)
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 把「覆盖到底挂上没有」写成一份小报告。
 *
 * 桌面壳的浏览器访问默认是关的（503/403「Browser access is disabled」），
 * 所以不能指望从外部 curl 到 /state 排障；插件自己把诊断落到 DSH_HOME 下，
 * 用文件读就行。只写诊断信息，不含任何密钥。
 */
function debugDump(service) {
  try {
    const path = join(stateDir(), 'default-model.debug.json')
    mkdirSync(stateDir(), { recursive: true })
    const report = {
      at: new Date().toISOString(),
      pinned: pinned === null ? null : pinned,
      installed: installed === null ? false : { applied: installed.applied, hadOwn: installed.hadOwn, via: installed.via },
      attachError: lastAttachError,
      service: service === null ? 'null' : service === undefined ? 'undefined' : typeof service,
      ctor: service && typeof service === 'object' ? String(service.constructor?.name ?? '') : '',
      protoHasMethod: service && typeof service === 'object'
        ? typeof Object.getPrototypeOf(service)?.currentSelection
        : '',
      ownHasMethod: service && typeof service === 'object'
        ? Object.prototype.hasOwnProperty.call(service, 'currentSelection')
        : null,
      extensible: service && typeof service === 'object' ? Object.isExtensible(service) : null,
      frozen: service && typeof service === 'object' ? Object.isFrozen(service) : null,
      sealed: service && typeof service === 'object' ? Object.isSealed(service) : null,
      readBack: (() => {
        if (!service || typeof service !== 'object') return ''
        try {
          const value = service.currentSelection?.()
          return value && typeof value === 'object' ? `${String(value.provider)}/${String(value.model)}` : String(value)
        } catch (error) {
          return `throw: ${String(error?.message ?? error)}`
        }
      })(),
    }
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch { /* 诊断写不出来不能影响主流程 */ }
}

/* -------------------------------------------------------------- 基础小工具 */

/** 取第一个非空字符串：模型目录的结构由适配器决定，只能容错地读。 */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 一条 provider 记录 → `{ provider, label }`；读不出路由就丢弃，绝不猜。 */
function providerEntryOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const provider = firstString(entry.provider, entry.route, entry.id)
  if (provider === '') return undefined
  return {
    provider,
    label: firstString(entry.name, entry.displayName, entry.label, entry.title, provider),
  }
}

/** 一条 model 记录 → `{ id, name }`。 */
function modelEntryOf(entry) {
  if (entry === null || typeof entry !== 'object') return undefined
  const id = firstString(entry.id, entry.model, entry.name)
  if (id === '') return undefined
  return { id, name: firstString(entry.name, entry.displayName, entry.label, entry.title, id) }
}

function json(res, code, value) {
  try {
    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(JSON.stringify(value))
  } catch { /* 连接已断，交给上层 */ }
}

/** 只接受本机回环：判据是 Host 头，浏览器无法伪造，能挡住 DNS rebinding。 */
function isLoopbackReq(req) {
  const host = String(req.headers?.host ?? '').trim().toLowerCase()
  if (!host) return false
  const bare = host.startsWith('[')
    ? (host.includes(']') ? host.slice(0, host.indexOf(']') + 1) : '')
    : host.split(':')[0]
  return bare === '127.0.0.1' || bare === 'localhost' || bare === '[::1]' || host === '::1'
}

/**
 * 写操作的同源校验。
 *
 * 桌面壳的页面 origin 是 `dsh-app://app`，它把非静态路径转发给宿主，所以这条
 * 请求的 Origin 与宿主的 Host 天然不同源 —— 若照搬「Origin 必须等于 Host」，
 * 桌面端每次保存都会 403。这里额外放行 `dsh-app:` / `file:` 这类壳内协议，
 * 真实网页（http/https 跨站）仍然被挡住。
 */
function originAllowed(req) {
  const origin = req.headers?.origin
  if (!origin) return true
  let parsed
  try {
    parsed = new URL(String(origin))
  } catch {
    return false
  }
  if (parsed.protocol === 'dsh-app:' || parsed.protocol === 'file:') return true
  return parsed.host.toLowerCase() === String(req.headers?.host ?? '').toLowerCase()
}

/** 读 JSON 请求体（有上限，超限断开）。 */
function readJson(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

/** 带 HTTP 状态码的错误，供顶层统一转成 JSON 响应。 */
function httpError(status, message, hint) {
  const error = new Error(message)
  error.status = status
  if (hint) error.hint = hint
  return error
}

async function maybe(value) {
  return value && typeof value.then === 'function' ? await value : value
}

/* ------------------------------------------------------------------ 模型目录 */

/**
 * 真实的模型目录。
 *
 * 逐个 provider 取 `listModels` 并单独容错：某个适配器没配凭据、其目录请求抛错，
 * 只应该让那一行留空，不能让整页「加载失败」——用户要改的往往正是另一个 provider。
 */
async function readCatalog(ctx) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listProviders !== 'function') return []
  let providers = []
  try {
    providers = await maybe(llm.listProviders())
  } catch {
    providers = []
  }
  const rows = []
  for (const entry of Array.isArray(providers) ? providers : []) {
    const head = providerEntryOf(entry)
    if (!head) continue
    const row = { provider: head.provider, label: head.label, models: [], error: '' }
    if (typeof llm.listModels === 'function') {
      try {
        const models = await maybe(llm.listModels(head.provider))
        for (const item of Array.isArray(models) ? models : []) {
          const model = modelEntryOf(item)
          if (model) row.models.push(model)
        }
      } catch (error) {
        row.error = String(error?.message ?? error)
      }
    }
    row.models.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    rows.push(row)
  }
  rows.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return rows
}

/**
 * 选中的模型是否真的存在。
 *
 * 只有拿到非空目录时才较真：目录为空或取目录抛错，通常意味着这个适配器此刻
 * 没有凭据，不应该因此拒绝用户保存一个正确的 id。
 */
async function assertAvailable(ctx, provider, model) {
  const llm = ctx.get('llm')
  if (!llm || typeof llm.listModels !== 'function') return
  let models
  try {
    models = await maybe(llm.listModels(provider))
  } catch {
    return
  }
  const list = Array.isArray(models) ? models : []
  if (list.length === 0) return
  const found = list.some(item => {
    const entry = modelEntryOf(item)
    return entry !== undefined && entry.id === model
  })
  if (!found) {
    throw httpError(
      400,
      `provider「${provider}」下没有模型「${model}」`,
      '模型 id 必须和适配器目录里的一致。修好 provider 配置后刷新这一页，目录会自动重新拉取。',
    )
  }
}

/* -------------------------------------------------------------- 原生条目镜像 */

/**
 * 把同一份选择镜像写回 profile 的 `- id: agent-default-model` 条目。
 *
 * 这一步只是「让旁路看到一致的值」：真正的默认值由上面的覆盖提供。写失败（没有
 * configEditor、条目被挪进别的层、文件被锁）都不算保存失败，只回报一个状态。
 */
async function mirrorNative(ctx, selection) {
  const log = loggerOf(ctx)
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') return 'skipped'
  let entry
  try {
    entry = editor.entries().find(item => item?.options?.id === NATIVE_ENTRY_ID)
  } catch {
    entry = undefined
  }
  if (!entry) return 'missing'
  const config = {
    provider: selection.provider,
    model: selection.model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
  }
  try {
    await editor.edit(entry, () => config)
    return 'ok'
  } catch (error) {
    log.warn?.(`镜像到 ${NATIVE_ENTRY_ID} 失败（固定值仍然生效）：`, error?.message ?? error)
    return 'failed'
  }
}

/* -------------------------------------------------------------------- 状态 */

function stateOf(ctx) {
  const service = ctx.get('agentDefaultModel')
  // 先补装再读：`/state` 的调用者最在乎的正是「现在到底生效了没有」。
  if (pinned !== null) installOverride(service)
  const nativeValue = nativeSelectionOf(ctx)
  return {
    ok: true,
    pinned: pinned !== null,
    // 覆盖是否真的挂上了服务实例——固定值生效的前提。
    attached: installed !== null && installed.applied === true,
    attachError: lastAttachError,
    current: pinned ?? nativeValue ?? null,
    native: nativeValue ?? null,
    canSave: Boolean(service && typeof service.currentSelection === 'function'),
    efforts: EFFORTS,
    statePath: statePath(),
  }
}

/**
 * 固定一份默认模型。
 *
 * 顺序很关键：先校验（存在性）→ 再写状态文件 → 立即生效（改内存里的 pinned，
 * 覆盖已经装好，下一次 currentSelection() 就是新值）→ 最后做原生镜像。
 * 这样即使镜像那一步失败，用户的选择也已经定住了。
 */
async function pinDefaultModel(ctx, body) {
  const provider = firstString(body?.provider)
  const model = firstString(body?.model)
  if (provider === '' || model === '') throw httpError(400, '必须同时选中 provider 和 model')
  const service = ctx.get('agentDefaultModel')
  if (!service || typeof service.currentSelection !== 'function') {
    throw httpError(400, '当前组合里没有 agentDefaultModel 服务，改不了默认模型')
  }
  const effort = firstString(body?.reasoningEffort)
  const selection = { provider, model, ...(effort === '' ? {} : { reasoningEffort: effort }) }

  await assertAvailable(ctx, provider, model)

  writePinned(selection)
  pinned = selection
  installOverride(ctx.get('agentDefaultModel'))

  const mirrored = await mirrorNative(ctx, selection)
  // 镜像会热重载 `agent-default-model` 条目，服务实例可能已经换了一个新的；
  // 新的实例上没有我们的覆盖，这里补装一次，保证「刚保存就生效」。
  installOverride(ctx.get('agentDefaultModel'))

  return { ok: true, ...stateOf(ctx), mirrored }
}

/** 解除固定：删掉状态文件，撤掉覆盖，立刻回到 Harness 原生行为。 */
function unpinDefaultModel(ctx) {
  clearPinned()
  pinned = null
  uninstallOverride()
  return { ok: true, ...stateOf(ctx), mirrored: 'skipped' }
}

/* -------------------------------------------------------------------- 路由 */

async function handle(ctx, req, res) {
  const log = loggerOf(ctx)
  try {
    if (!isLoopbackReq(req)) {
      json(res, 403, { ok: false, error: '只接受本机回环访问' })
      return
    }
    const url = new URL(String(req.url ?? '/'), 'http://127.0.0.1')
    const raw = url.pathname.startsWith(API_PATH)
      ? url.pathname.slice(API_PATH.length)
      : url.pathname
    const route = ('/' + raw.replace(/^\/+/, '')).replace(/\/+$/, '') || '/'

    if (route === '/state') {
      if (req.method !== 'GET') throw httpError(405, '只支持 GET')
      // 服务可能在插件加载之后才起来（或刚被热重载），顺手补装一次覆盖。
      if (pinned !== null) installOverride(ctx.get('agentDefaultModel'))
      const [payload, providers] = await Promise.all([
        Promise.resolve(stateOf(ctx)),
        readCatalog(ctx),
      ])
      json(res, 200, { ...payload, providers })
      return
    }

    if (route === '/save' || route === '/reset') {
      if (req.method !== 'POST') throw httpError(405, '只支持 POST')
      if (!originAllowed(req)) throw httpError(403, '跨站请求被拒绝')
      const type = String(req.headers?.['content-type'] ?? '').toLowerCase()
      if (!type.includes('application/json')) throw httpError(415, '写操作必须是 application/json')
      const conn = ctx.get('connection')
      if (conn && typeof conn.requestRejection === 'function') {
        const code = conn.requestRejection(req)
        // 403 = Host/Origin 不可信：硬拦。
        // 401 = 缺少浏览器凭证。桌面壳把请求转发给宿主时不保证带上 cookie，而
        // 本机进程本来就能直接改写 settings.yaml，所以这里不硬拦，只记一笔：
        // 页面能打开就说明它持有凭证，跨站写入仍被上面的 Origin 校验挡住。
        if (code === 403) throw httpError(403, '本次请求被连接层拒绝')
        if (code === 401) log.warn?.(`${API_PATH} 写请求没有浏览器凭证，已按本机回环请求放行`)
      }
      if (route === '/reset') {
        await readJson(req)
        json(res, 200, unpinDefaultModel(ctx))
        return
      }
      const body = await readJson(req)
      json(res, 200, await pinDefaultModel(ctx, body))
      return
    }

    throw httpError(404, `未知接口：${route}`)
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : 500
    if (status >= 500) log.warn?.(`${API_PATH} 处理失败：`, error?.message ?? error)
    json(res, status, {
      ok: false,
      error: String(error?.message ?? error),
      ...(error?.hint ? { hint: String(error.hint) } : {}),
    })
  }
}

/**
 * 代码版本标记。每次加载都把它连同现场写进 `default-model.boot.json`，
 * 用来确认「宿主这次到底 import 的是哪一版代码」——排查「改了没生效」时，
 * 光看 toggle 返回 applied 是不够的（ESM 缓存会让旧模块继续跑）。
 */
export const CODE_REVISION = '2026-10-30-boot-dump'

function bootDump(service, phase) {
  try {
    mkdirSync(stateDir(), { recursive: true })
    bootEvents.push({
      phase: String(phase ?? ''),
      at: new Date().toISOString(),
      pinned,
      hasService: Boolean(service),
      hasCurrentSelection: typeof service?.currentSelection === 'function',
      attachError: lastAttachError,
      applied: installed === null ? false : installed.applied === true,
      via: installed === null ? '' : installed.via,
      ownCurrentSelection: Boolean(service) && Object.prototype.hasOwnProperty.call(service, 'currentSelection'),
      readBack: readBackOf(service),
    })
    writeFileSync(join(stateDir(), 'default-model.boot.json'), `${JSON.stringify({
      revision: CODE_REVISION,
      pid: process.pid,
      dshHome: stateDir(),
      events: bootEvents,
    }, null, 2)}\n`, 'utf8')
  } catch { /* 排障用，写不进去也不影响插件本身 */ }
}

function readBackOf(service) {
  if (!service || typeof service !== 'object') return ''
  try {
    // 走探针：那才是别处真正读到的值。
    const value = typeof probeSelection === 'function' ? probeSelection() : service.currentSelection?.()
    return value && typeof value === 'object' ? `${String(value.provider)}/${String(value.model)}` : String(value)
  } catch (error) {
    return `throw: ${String(error?.message ?? error)}`
  }
}

export function apply(ctx) {
  const log = loggerOf(ctx)

  pinned = readPinned()
  probeSelection = () => {
    const live = ctx.get('agentDefaultModel')
    if (!live || typeof live.currentSelection !== 'function') return null
    return live.currentSelection()
  }
  const service = ctx.get('agentDefaultModel')
  bootDump(service, 'after-pin-read')
  if (pinned !== null && !installOverride(ctx.get('agentDefaultModel'))) {
    // 服务还没起来：短轮询几次，装上就停。拆插件时一并清掉。
    log.warn?.('agentDefaultModel 尚未就绪，稍后重试安装默认模型覆盖')
    ctx.effect(() => {
      let left = 40
      const timer = setInterval(() => {
        left -= 1
        if (pinned === null || installOverride(ctx.get('agentDefaultModel')) || left <= 0) {
          clearInterval(timer)
          bootDump(ctx.get('agentDefaultModel'), 'after-late-attach')
        }
      }, 250)
      return () => clearInterval(timer)
    }, 'dsh-default-model: attach pin')
  }
  bootDump(service, 'after-attach')

  // 固定值必须「粘」在服务上，而不是只在启动时装一次：
  // 一次会话里换模型会触发 agentDefaultModel.saveSelection() → 写组合条目 → 该条目热重载，
  // 服务实例可能被换成新对象（新对象没有我们的覆盖）。这里每 2 秒对一次账，
  // 发现读出来的已经不是固定值就重新装 —— 否则用户会看到「固定了，但聊一次又变了」。
  // 不放在 `if (pinned !== null)` 里：常常是启动时还没固定、之后才在设置页保存的。
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (pinned === null) {
        if (installed !== null) uninstallOverride()
        return
      }
      const live = ctx.get('agentDefaultModel')
      if (!live || typeof live !== 'object') return
      // 用读出来的值判断，不做实例身份比较：ctx.get() 可能每次都给新的包装对象。
      let value = null
      try { value = live.currentSelection?.() } catch { value = null }
      const attached = Boolean(value) && value.provider === pinned.provider && value.model === pinned.model
      if (!attached) installOverride(live)
    }, 2000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'dsh-default-model: keep pin attached')

  ctx.effect(() => () => uninstallOverride(), 'dsh-default-model: detach pin')

  // `inject` 已经保证 webServer 存在；这里再从 ctx.get 取一次，是为了在没有
  // 服务时会话里抛出的错误能说清是「谁」缺了，而不是 undefined.register。
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    throw new Error('dsh-default-model 需要 webServer 服务，但当前组合里没有它')
  }
  ctx.effect(() => {
    const dispose = webServer.register({
      kind: 'prefix',
      path: API_PATH,
      handler: (req, res) => handle(ctx, req, res),
    })
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch { /* 宿主已在拆除 */ }
    }
  }, `dsh-default-model: http routes @ ${API_PATH}`)
}