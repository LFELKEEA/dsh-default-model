/**
 * 冒烟测试：不启动 Harness，直接给 Host 半边喂一个假的 ctx 与假的 http req/res。
 *
 *   node scripts/smoke.mjs
 *
 * 重点验证「固定」语义（这是这个插件唯一的存在理由）：
 *   1. /save 之后 `agentDefaultModel.currentSelection()` 立刻返回固定值；
 *   2. 模拟 `sessionController.selectModel()` 在后台调的 `saveSelection(别的模型)`，
 *      固定值不被带走（这正是用户报的「新建对话就变回去」的机制）；
 *   3. /reset 之后回落到原生方法，且没在实例上留自有属性。
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 状态文件写在 DSH_HOME 下；测试必须指到临时目录，绝不能碰用户真实的 ~/.dsh。
const home = mkdtempSync(join(tmpdir(), 'dsh-default-model-'))
process.env.DSH_HOME = home
const statePath = join(home, 'default-model.json')

const { apply } = await import('../index.js')

const saved = []
const edits = []
const routes = []
const disposers = []

/** 原型上带 currentSelection 的服务：用来验证卸载时是 delete 而不是留副本。 */
class FakeDefaultModel {
  constructor() {
    this.value = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }
  }

  currentSelection() {
    return this.value
  }

  async saveSelection(next) {
    saved.push(next)
    this.value = next
  }
}

function makeCtx(overrides = {}) {
  const service = new FakeDefaultModel()
  // 服务实例可能被宿主换掉（组合条目热重载）：让 get() 每次读当前实例，
  // 测试才能模拟「换了个新的 agentDefaultModel」。
  let liveService = service
  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: () => ({ warn: (...args) => console.log('[warn]', ...args) }),
    get(name) {
      if (name === 'webServer') {
        return {
          register(route) {
            routes.push(route)
            return () => {}
          },
        }
      }
      if (name === 'connection') {
        // 用测试头决定连接层返回什么，模拟宿主的 Host/Origin/凭证校验。
        return {
          requestRejection: req => {
            const code = req.headers['x-test-conn']
            return code ? Number(code) : undefined
          },
        }
      }
      if (name === 'llm') {
        return {
          listProviders: () => [
            { provider: 'deepseek-account', name: 'DeepSeek 账号' },
            { id: 'our-free-model', displayName: 'Our Free Model' },
            { route: '' },
          ],
          listModels: provider => {
            if (provider === 'deepseek-account') {
              return Promise.resolve([
                { id: 'deepseek-flash', name: 'DeepSeek Flash' },
                { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
              ])
            }
            throw new Error('没有可用凭据')
          },
        }
      }
      if (name === 'agentDefaultModel') {
        return overrides.agentDefaultModel === null ? undefined : liveService
      }
      if (name === 'configEditor') {
        if (overrides.configEditor === null) return undefined
        return {
          entries: () => [
            { options: { id: 'agent-default-model', config: {} } },
            { options: { id: 'llm-deepseek' } },
          ],
          edit: async (entry, change) => {
            if (overrides.configEditorEditThrows) throw new Error('patch 被锁住了')
            edits.push({ id: entry.options.id, config: change(entry.options.config ?? {}) })
          },
        }
      }
      return undefined
    },
  }
  ctx.__service = service
  ctx.__swapService = next => { liveService = next }
  return ctx
}

const ctx = makeCtx()
apply(ctx)
const service = ctx.__service

function makeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = { host: '127.0.0.1:54966', ...headers }
  if (body !== undefined) {
    setImmediate(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

let route = routes[0]

function call(req, target = route) {
  return new Promise(resolve => {
    const res = {
      statusCode: 0,
      headers: {},
      writeHead(code, headers) {
        this.statusCode = code
        this.headers = headers ?? {}
      },
      end(payload) {
        let json
        try {
          json = payload ? JSON.parse(payload) : undefined
        } catch {
          json = payload
        }
        resolve({ status: this.statusCode, json })
      },
    }
    target.handler(req, res)
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
}

if (!route || route.kind !== 'prefix' || route.path !== '/dsh-default-model/api') {
  throw new Error(`路由注册不符合预期：${JSON.stringify(routes)}`)
}

// 1. 未固定时的 /state
{
  const { status, json } = await call(makeReq({ url: '/dsh-default-model/api/state' }))
  check('GET /state 200', status === 200, `status=${status}`)
  check('初始未固定', json?.pinned === false, JSON.stringify(json?.pinned))
  check('current 带回原生选择', json?.current?.model === 'deepseek-flash', JSON.stringify(json?.current))
  check('两个 provider 都解析出来', json?.providers?.length === 2, JSON.stringify(json?.providers?.map(p => p.provider)))
  const ofm = json?.providers?.find(p => p.provider === 'our-free-model')
  check('单个 provider 抛错不影响其它（models 空 + error）', ofm?.models?.length === 0 && ofm?.error.includes('凭据'), JSON.stringify(ofm))
  check('模型按名字排序', json?.providers?.[0]?.models?.[0]?.name === 'DeepSeek Flash', JSON.stringify(json?.providers?.[0]?.models))
  check('canSave 为 true', json?.canSave === true, String(json?.canSave))
  check('statePath 指向临时 DSH_HOME', json?.statePath === statePath, String(json?.statePath))
}

// 2. /save 固定：立刻生效 + 写状态文件 + 镜像组合条目
{
  const body = JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' })
  const { status, json } = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json', origin: 'dsh-app://app' },
    body,
  }))
  check('POST /save 200（dsh-app 来源放行）', status === 200, `status=${status} ${JSON.stringify(json)}`)
  check('保存后 pinned=true', json?.pinned === true, JSON.stringify(json?.pinned))
  check('覆盖挂在活的服务实例上', json?.attached === true, JSON.stringify(json?.attached))
  check('镜像到组合条目 ok', json?.mirrored === 'ok', String(json?.mirrored))
  check('状态文件落盘', existsSync(statePath), statePath)
  const stored = JSON.parse(readFileSync(statePath, 'utf8'))
  check('状态文件内容正确', stored.provider === 'deepseek-account' && stored.model === 'deepseek-v4.1-flash-1017' && stored.reasoningEffort === 'high', JSON.stringify(stored))
  check('saveSelection 未被调用（不靠它写默认）', saved.length === 0, JSON.stringify(saved))
  const now = service.currentSelection()
  check('currentSelection() 直接返回固定值', now.provider === 'deepseek-account' && now.model === 'deepseek-v4.1-flash-1017' && now.reasoningEffort === 'high', JSON.stringify(now))
  check('镜像写入 agent-default-model 条目', edits.length === 1 && edits[0]?.id === 'agent-default-model', JSON.stringify(edits))
  check('镜像 config 只含三字段', JSON.stringify(edits[0]?.config) === JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash-1017', reasoningEffort: 'high' }), JSON.stringify(edits[0]?.config))
}

// 3. 关键回归：模拟「在任意对话里换了模型」——selectModel 会后台 saveSelection
{
  await service.saveSelection({ provider: 'dafeiyu', model: 'deepseek-v4.1-flash-1017' })
  const now = service.currentSelection()
  check('原生选择被改后，固定值纹丝不动', now.provider === 'deepseek-account' && now.model === 'deepseek-v4.1-flash-1017', JSON.stringify(now))
  const { json } = await call(makeReq({ url: '/dsh-default-model/api/state' }))
  check('/state 仍报 pinned 且 current 不变', json?.pinned === true && json?.current?.model === 'deepseek-v4.1-flash-1017', JSON.stringify(json?.current))
  check('/state 的 native 反映原生值（供 UI 显示差异）', json?.native?.provider === 'dafeiyu', JSON.stringify(json?.native))
}

// 4. /reset 解除固定，回到原生
{
  const { status, json } = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/reset',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }))
  check('POST /reset 200', status === 200, `status=${status} ${JSON.stringify(json)}`)
  check('解除后 pinned=false', json?.pinned === false, JSON.stringify(json?.pinned))
  check('解除后覆盖已摘除', json?.attached === false, JSON.stringify(json?.attached))
  check('解除后 current 回到原生值', json?.current?.provider === 'dafeiyu', JSON.stringify(json?.current))
  check('状态文件已删除', !existsSync(statePath), statePath)
  check('实例上没留自有 currentSelection', Object.prototype.hasOwnProperty.call(service, 'currentSelection') === false, 'still own property')
  check('原型方法恢复（读到原生值）', service.currentSelection().provider === 'dafeiyu', JSON.stringify(service.currentSelection()))
}

// 5. 拒绝分支
{
  const noJson = await call(makeReq({ method: 'POST', url: '/dsh-default-model/api/save', body: '{}' }))
  check('非 JSON 415', noJson.status === 415, `status=${noJson.status}`)

  const foreign = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ provider: 'a', model: 'b' }),
  }))
  check('跨站 origin 403', foreign.status === 403, `status=${foreign.status} ${JSON.stringify(foreign.json)}`)

  const notLocal = await call(makeReq({
    url: '/dsh-default-model/api/state',
    headers: { host: 'evil.example' },
  }))
  check('非回环 Host 403', notLocal.status === 403, `status=${notLocal.status}`)

  const missing = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'a' }),
  }))
  check('缺 model 400', missing.status === 400, `status=${missing.status}`)

  const unknownModel = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek-account', model: '不存在的模型' }),
  }))
  check('模型不在非空目录里 400', unknownModel.status === 400, `status=${unknownModel.status} ${JSON.stringify(unknownModel.json)}`)

  const unknown = await call(makeReq({ url: '/dsh-default-model/api/nope' }))
  check('未知路径 404', unknown.status === 404, `status=${unknown.status}`)

  const wrongMethod = await call(makeReq({ method: 'GET', url: '/dsh-default-model/api/save' }))
  check('GET /save 405', wrongMethod.status === 405, `status=${wrongMethod.status}`)

  // 连接层：403 硬拦；401（缺浏览器凭证，桌面壳转发时不带 cookie）放行。
  const connDenied = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json', 'x-test-conn': '403' },
    body: JSON.stringify({ provider: 'a', model: 'b' }),
  }))
  check('连接层 403 硬拦', connDenied.status === 403, `status=${connDenied.status} ${JSON.stringify(connDenied.json)}`)

  const connNoToken = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json', 'x-test-conn': '401' },
    body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  }))
  check('连接层 401 仍放行（壳内请求无 cookie）', connNoToken.status === 200, `status=${connNoToken.status} ${JSON.stringify(connNoToken.json)}`)
}

// 6. 镜像失败不影响固定（没有 configEditor 时也照样定住）
{
  clearAll()
  const second = makeCtx({ configEditor: null })
  apply(second)
  const target = routes[routes.length - 1]
  const { status, json } = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-flash' }),
  }), target)
  check('无 configEditor 仍能保存', status === 200 && json?.pinned === true, `status=${status} ${JSON.stringify(json)}`)
  check('镜像状态是 skipped', json?.mirrored === 'skipped', String(json?.mirrored))
  check('无 configEditor 时固定值依然生效', second.__service.currentSelection().model === 'deepseek-flash', JSON.stringify(second.__service.currentSelection()))
}

// 7. 没有 agentDefaultModel 服务时只读
{
  clearAll()
  const bare = makeCtx({ agentDefaultModel: null, configEditor: null })
  apply(bare)
  const target = routes[routes.length - 1]
  const readOnly = await call(makeReq({ url: '/dsh-default-model/api/state' }), target)
  check('无服务时 canSave=false（目录仍可读）', readOnly.json?.canSave === false && readOnly.json?.providers?.length === 2, JSON.stringify(readOnly.json))
  const reject = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'a', model: 'b' }),
  }), target)
  check('无服务时保存 400', reject.status === 400, `status=${reject.status} ${JSON.stringify(reject.json)}`)
}

// 8. 服务实例被冻结时退到原型（真实宿主上「assign failed」的救场路径）
{
  clearAll()
  let frozenValue = { provider: 'deepseek-account', model: 'deepseek-flash' }
  class FrozenDefaultModel {
    currentSelection() {
      return frozenValue
    }

    async saveSelection(next) {
      frozenValue = next
    }
  }
  const frozen = Object.freeze(new FrozenDefaultModel())
  const frozenCtx = makeCtx()
  const baseGet = frozenCtx.get.bind(frozenCtx)
  frozenCtx.get = (name) => (name === 'agentDefaultModel' ? frozen : baseGet(name))
  apply(frozenCtx)
  const target = routes[routes.length - 1]
  const save = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'our-free-model', model: 'gpt-5' }),
  }), target)
  check('实例被冻结时保存仍成功', save.status === 200 && save.json?.pinned === true && save.json?.attached === true,
    `status=${save.status} ${JSON.stringify(save.json)}`)
  check('冻结实例靠原型覆盖生效', frozen.currentSelection()?.provider === 'our-free-model',
    JSON.stringify(frozen.currentSelection()))
  await frozen.saveSelection({ provider: 'dfy', model: 'deepseek-v4.1-flash-1017' })
  check('冻结实例上固定值不被 saveSelection 带走', frozen.currentSelection().provider === 'our-free-model',
    JSON.stringify(frozen.currentSelection()))
  await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/reset',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }), target)
  check('解除固定后原型恢复原生值', frozen.currentSelection().provider === 'dfy', JSON.stringify(frozen.currentSelection()))
}

// 9. 状态文件带 UTF-8 BOM 也要能认出固定值
//    Windows 上 PowerShell 的 Set-Content、记事本、不少编辑器都会写 BOM，
//    而 JSON.parse 见到 U+FEFF 会直接抛 —— 真机上固定失效就是这么来的。
{
  clearAll()
  writeFileSync(statePath, `\uFEFF${JSON.stringify({ provider: 'dfy', model: 'deepseek-v4.1-flash-1017' }, null, 2)}`, 'utf8')
  check('测试文件确实写了 BOM', readFileSync(statePath, 'utf8').charCodeAt(0) === 0xfeff, 'no bom')

  const ctx = makeCtx()
  apply(ctx)
  const target = routes[routes.length - 1]
  const state = await call(makeReq({ method: 'GET', url: '/dsh-default-model/api/state' }), target)
  check('带 BOM 的状态文件仍被认作已固定', state.json?.pinned === true, JSON.stringify(state.json))
  check('带 BOM 时覆盖依然装上', state.json?.attached === true, JSON.stringify(state.json))
  check('带 BOM 时读到的是固定值', ctx.__service.currentSelection()?.provider === 'dfy', JSON.stringify(ctx.__service.currentSelection()))
  check('带 BOM 时生效后 readBack 正常', state.json?.current?.model === 'deepseek-v4.1-flash-1017', JSON.stringify(state.json?.current))
}

// 10. 服务实例被宿主换掉（组合条目热重载）后，固定值要自己粘回新实例
//     真机场景：在任意会话里换模型 → saveSelection 写条目 → 条目热重载 → 新实例没有我们的覆盖。
//     没有这条自愈，用户看到的就是「固定了，但聊一次又变回去了」。
{
  clearAll()
  const ctx2 = makeCtx()
  apply(ctx2)
  const target = routes[routes.length - 1]
  const save = await call(makeReq({
    method: 'POST',
    url: '/dsh-default-model/api/save',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: 'deepseek-account', model: 'deepseek-v4.1-flash-1017' }),
  }), target)
  check('换实例前：保存成功', save.json?.pinned === true, JSON.stringify(save.json))

  const replacement = new FakeDefaultModel()
  ctx2.__swapService(replacement)
  check('刚换上的新实例还是原生值', replacement.currentSelection().model === 'deepseek-flash', replacement.currentSelection().model)

  await new Promise(resolve => setTimeout(resolve, 2300))
  check('新实例在 2 秒内被重新粘上固定值', replacement.currentSelection().model === 'deepseek-v4.1-flash-1017', replacement.currentSelection().model)
  check('重新粘上后 provider 也一致', replacement.currentSelection().provider === 'deepseek-account', replacement.currentSelection().provider)

  await clearAll()
  const another = new FakeDefaultModel()
  ctx2.__swapService(another)
  await new Promise(resolve => setTimeout(resolve, 2300))
  check('解除固定后不再覆盖新实例', another.currentSelection().model === 'deepseek-flash', another.currentSelection().model)
}

function clearAll() {
  if (existsSync(statePath)) rmSync(statePath, { force: true })
  // 插件的 pinned 是模块级单例；用一次 /reset 把它清掉。
  return unpinQuietly()
}

function unpinQuietly() {
  // 直接调用导出的 apply 之前先把模块状态复位：发一个 /reset 给它自己。
  const target = routes[routes.length - 1]
  const req = new EventEmitter()
  req.method = 'POST'
  req.url = '/dsh-default-model/api/reset'
  req.headers = { host: '127.0.0.1:54966', 'content-type': 'application/json' }
  setImmediate(() => {
    req.emit('data', Buffer.from('{}'))
    req.emit('end')
  })
  return new Promise(resolve => {
    target.handler(req, { writeHead() {}, end() { resolve() } })
  })
}

for (const dispose of disposers) dispose()
rmSync(home, { recursive: true, force: true })

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)