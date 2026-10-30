/**
 * 浏览器半边的无头冒烟测试：不装 React、不开浏览器，用一个最小 hook 运行时
 * 把 client.js 真正渲染出来，再模拟「点模型 → 点保存」，验证它是活的。
 *
 *   node scripts/client-smoke.mjs
 *
 * 为什么不直接 SSR：环境里没有 react/react-dom（壳把它打进了自己的 bundle），
 * 而这里要验的恰好是 useEffect 拉数据 → setState → 重渲染这条链，SSR 不跑 effect。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// ── 最小 React ───────────────────────────────────────────────────────────────
const Fragment = Symbol('Fragment')

function createElement(type, props, ...children) {
  return { type, props: { ...(props ?? {}), children } }
}

const states = []
const memos = []
const effectSlots = []
let hookIndex = 0
let dirty = false
let pumping = false
let draw = () => {}

function depsChanged(prev, next) {
  if (!prev) return true
  if (!next) return true
  if (prev.length !== next.length) return true
  return prev.some((value, i) => !Object.is(value, next[i]))
}

function schedule() {
  dirty = true
  if (pumping) return
  pumping = true
  void (async () => {
    for (let guard = 0; guard < 50; guard += 1) {
      await Promise.resolve()
      if (!dirty) break
      dirty = false
      draw()
      flushEffects()
    }
    pumping = false
  })()
}

function flushEffects() {
  for (const slot of effectSlots) {
    if (!slot) continue
    if (!slot.pending) continue
    slot.pending = false
    try {
      const cleanup = slot.fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    } catch (error) {
      console.error('effect 抛错：', error)
    }
  }
}

const hooks = {
  useState(initial) {
    const i = hookIndex++
    if (!(i in states)) states[i] = typeof initial === 'function' ? initial() : initial
    return [states[i], next => {
      const value = typeof next === 'function' ? next(states[i]) : next
      if (Object.is(value, states[i])) return
      states[i] = value
      schedule()
    }]
  },
  useMemo(factory, deps) {
    const i = hookIndex++
    const prev = memos[i]
    if (!prev || depsChanged(prev.deps, deps)) memos[i] = { value: factory(), deps }
    return memos[i].value
  },
  useCallback(fn, deps) {
    const i = hookIndex++
    const prev = memos[i]
    if (!prev || depsChanged(prev.deps, deps)) memos[i] = { value: fn, deps }
    return memos[i].value
  },
  useEffect(fn, deps) {
    const i = hookIndex++
    const prev = effectSlots[i]
    if (!prev) effectSlots[i] = { fn, deps, pending: true }
    else if (depsChanged(prev.deps, deps)) {
      prev.fn = fn
      prev.deps = deps
      prev.pending = true
    }
  },
}

const React = { createElement, Fragment, ...hooks }

// ── 假宿主环境 ───────────────────────────────────────────────────────────────
const state = {
  ok: true,
  pinned: false,
  current: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  native: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
  canSave: true,
  efforts: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  providers: [
    {
      provider: 'deepseek-account',
      label: 'DeepSeek 账号',
      models: [
        { id: 'deepseek-flash', name: 'DeepSeek Flash' },
        { id: 'deepseek-v4.1-flash-1017', name: 'DeepSeek V4.1 Flash' },
      ],
      error: '',
    },
    { provider: 'our-free-model', label: 'Our Free Model', models: [], error: '没有可用凭据' },
  ],
}

const calls = []
function fakeFetch(url, options = {}) {
  calls.push({ url: String(url), method: options.method ?? 'GET', body: options.body })
  const target = String(url)
  if (target.endsWith('/save')) {
    const body = JSON.parse(options.body)
    state.pinned = true
    state.current = { ...body }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, pinned: true, current: state.current, native: state.native, mirrored: 'ok' }),
    })
  }
  if (target.endsWith('/reset')) {
    state.pinned = false
    state.current = { ...state.native }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, pinned: false, current: state.current, native: state.native }),
    })
  }
  return Promise.resolve({ ok: true, status: 200, json: async () => state })
}

let captured
const sandbox = {
  window: { __ModuleLoader__: { load: spec => { captured = spec.factory(name => (name === 'react' ? React : undefined)) } } },
  document: { baseURI: 'http://127.0.0.1:54966/', documentElement: { lang: 'zh' } },
  fetch: fakeFetch,
  URL,
  console,
  setTimeout,
  clearTimeout,
}
sandbox.globalThis = sandbox
vm.runInNewContext(readFileSync(new URL('../client.js', import.meta.url), 'utf8'), sandbox, { filename: 'client.js' })

// ── 挂载 ─────────────────────────────────────────────────────────────────────
const registrations = []
const ctx = {
  effect(fn) {
    fn()
    return () => {}
  },
  locale: {
    // 用插件自己导出的中文词典，断言才能落在真实文案上（而不是 key）。
    bind: () => key => captured.__test.DICT.zh[key] ?? key,
    register: () => () => {},
  },
  slots: {
    inject: (name, register) => register(),
    register: (spec, Component) => {
      registrations.push({ spec, Component })
      return () => {}
    },
  },
}

captured.apply(ctx)

const registered = registrations.find(item => item.spec.name === 'settings.section')
if (!registered) throw new Error('没有注册 settings.section')
if (registered.spec.id !== 'default-model') throw new Error(`section id 不对：${registered.spec.id}`)

draw = () => {
  hookIndex = 0
  return registered.Component({})
}

// ── 渲染树 → 文本 + 可点元素 ────────────────────────────────────────────────
function walk(node, out) {
  if (node === null || node === undefined || node === false || node === true) return
  if (typeof node === 'string' || typeof node === 'number') {
    out.text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out)
    return
  }
  if (typeof node !== 'object' || !('type' in node)) return
  if (typeof node.type === 'function') {
    // 每个函数组件拥有自己的 hook 槽位：进入时归零，离开时由下一个组件重新归零。
    const outer = hookIndex
    hookIndex = 0
    const rendered = node.type(node.props)
    hookIndex = outer
    walk(rendered, out)
    return
  }
  if (node.type === Fragment) {
    walk(node.props.children, out)
    return
  }
  const entry = { type: node.type, props: node.props, label: '' }
  const childOut = { text: [], items: [] }
  walk(node.props.children, childOut)
  entry.label = childOut.text.join(' ')
  out.items.push(entry)
  out.text.push(...childOut.text)
  out.items.push(...childOut.items)
}

function snapshot() {
  const out = { text: [], items: [] }
  walk(draw(), out)
  flushEffects()
  return { text: out.text.join(' '), items: out.items }
}

function clickLabel(view, label) {
  const target = view.items.find(item => item.type === 'button' && item.label.includes(label))
  if (!target) throw new Error(`找不到可点的按钮：${label}\n当前文本：${view.text}`)
  target.props.onClick({ target: { value: label } })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  ← ${detail}`}`)
}

// 1. 首屏
{
  snapshot() // 首帧：effect 在这里注册并在 flushEffects 里发出首次 /state 请求
  await new Promise(resolve => setTimeout(resolve, 20))
  const view = snapshot()
  check('挂载后拉到目录并渲染当前默认', view.text.includes('deepseek-flash'), view.text.slice(0, 300))
  check('列出 provider 标签', view.text.includes('DeepSeek 账号') && view.text.includes('Our Free Model'), view.text)
  check('列出模型名', view.text.includes('DeepSeek V4.1 Flash'), view.text)
  check('渲染推理档位下拉', view.items.some(item => item.type === 'select' && item.label.includes('max')), view.text)
  check('有保存按钮', view.items.some(item => item.type === 'button' && item.label.includes('保存为默认模型')), view.text)
  // 这一条是回归点：URL 拼错（多一层 /api）时页面只会显示「HTTP 404」，
  // 而假的 fetch 不校验地址就发现不了。
  const stateCall = calls[0]
  check('请求地址落在插件自己的路由上', stateCall?.url === 'http://127.0.0.1:54966/dsh-default-model/api/state', JSON.stringify(stateCall?.url))
  check('未固定时标题是「跟随 Harness」', view.text.includes('当前默认（跟随 Harness）'), view.text.slice(0, 300))
  check('未固定时解释「它为什么老是变」', view.text.includes('还没有固定'), view.text)
}

// 2. 选另一个模型 → 出现未保存提示 → 保存
{
  const view = snapshot()
  const option = view.items.find(item => item.type === 'button' && item.label.includes('DeepSeek V4.1 Flash'))
  if (!option) throw new Error('找不到模型条目按钮')
  option.props.onClick({ target: { value: 'x' } })
  const dirtyView = snapshot()
  check('选新模型后提示未保存', dirtyView.text.includes('有未保存的改动'), dirtyView.text)

  clickLabel(dirtyView, '保存为默认模型')
  await new Promise(resolve => setTimeout(resolve, 20))
  const savedView = snapshot()
  const post = calls.find(call => call.method === 'POST')
  check('发出 POST /save 且带上新模型', Boolean(post) && String(post.body).includes('deepseek-v4.1-flash-1017'), JSON.stringify(post))
  check('保存后显示已固定', savedView.text.includes('已固定：新建对话和重启后都用这个模型'), savedView.text)
  check('当前默认变成新模型', savedView.text.includes('deepseek-v4.1-flash-1017'), savedView.text)
  check('固定后显示「已固定」标记', savedView.text.includes('已固定'), savedView.text)
  check('固定后出现「解除固定」按钮', savedView.items.some(item => item.type === 'button' && item.label.includes('解除固定')), savedView.text)
  check('固定值与原生值不同时显示原生默认', savedView.text.includes('原生默认'), savedView.text)
}

// 2b. 解除固定
{
  const view = snapshot()
  clickLabel(view, '解除固定')
  await new Promise(resolve => setTimeout(resolve, 20))
  const after = snapshot()
  const reset = calls.find(call => call.method === 'POST' && call.url.endsWith('/reset'))
  check('发出 POST /reset', Boolean(reset), JSON.stringify(calls.map(c => c.url)))
  check('解除后回到「跟随 Harness」', after.text.includes('当前默认（跟随 Harness）'), after.text)
  check('解除后提示已解除', after.text.includes('已解除固定'), after.text)
}

// 3. 保存失败的提示
{
  const failing = snapshot()
  const original = sandbox.fetch
  sandbox.fetch = () => Promise.resolve({ ok: false, status: 500, json: async () => ({ ok: false, error: '写入被拒绝', hint: '检查 profile 权限' }) })
  const option = failing.items.find(item => item.type === 'button' && item.label.includes('DeepSeek Flash'))
  option.props.onClick({ target: { value: 'y' } })
  clickLabel(snapshot(), '保存为默认模型')
  await new Promise(resolve => setTimeout(resolve, 20))
  const view = snapshot()
  sandbox.fetch = original
  check('保存失败显示原因与提示', view.text.includes('保存失败') && view.text.includes('写入被拒绝') && view.text.includes('检查 profile 权限'), view.text)
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exit(failed.length === 0 ? 0 : 1)
