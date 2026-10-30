/**
 * dsh-default-model — 浏览器半边。
 *
 * 在设置里加一个「默认模型」分页：读宿主那边真实的模型目录，让用户点选
 * provider / model / 推理档位，然后写回 Harness 的默认模型配置。
 *
 * 数据走插件自己的同源路由 `/dsh-default-model/api/*`（Host 半边注册），
 * 而不是 typed Remote —— `agentDefaultModel` 没有 `@Remote` 标注，浏览器拿不到它。
 *
 * 手写 ModuleLoader bundle：没有构建步骤，除 shell 已经提供的 `react` 之外零依赖。
 * 所有颜色都取自主题变量，深色/浅色切换不会把页面变成白底黑字。
 */
window.__ModuleLoader__.load({
  id: 'dsh-default-model',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useMemo, useState } = React

    const NS = 'settings.defaultModel'
    const inject = ['slots', 'locale']

    const DICT = {
      zh: {
        'meta.title': '默认模型',
        'meta.description': '把默认模型真正固定住：在这里选一次，新建对话和重启 Harness 之后都还是它。',
        nav: '默认模型',
        title: '默认模型',
        lead: '在这里保存的模型会被「固定」：新建对话、重启 Harness 都继续用它。已经打开的对话仍用它自己的模型，可以在输入框旁的模型选择器里单独切换 —— 那个切换不会再改掉这里的默认值。',
        'current.title': '当前默认（已固定）',
        'current.title.native': '当前默认（跟随 Harness）',
        'current.pinned': '已固定',
        'current.native': '原生默认',
        'current.none': '读不到当前默认模型',
        pinch: '已经被固定。Harness 原生的「在对话里换模型会顺手改默认」不会再覆盖它。',
        'pinch.native': '还没有固定，当前用的是 Harness 原生默认值 —— 它会被「任意对话里换过的模型」覆盖，这正是它老是变的原因。',
        unpin: '解除固定',
        'state.unpinned': '已解除固定，回到 Harness 原生行为。',
        'current.effort': '推理档位',
        'current.followDefault': '跟随模型默认',
        'catalog.title': '选择模型',
        'catalog.provider': 'Provider',
        'catalog.search': '筛选模型…',
        'catalog.empty': '这个 provider 没有可用的模型',
        'catalog.error': '读取该 provider 的模型目录失败',
        'catalog.manual': '或直接填写模型 id',
        'catalog.count': '{n} 个模型',
        'catalog.offline': '模型目录不可用：宿主的 llm 服务没有返回任何 provider',
        effort: '推理档位',
        'effort.default': '跟随模型默认',
        save: '保存为默认模型',
        saving: '保存中…',
        reload: '重新读取',
        'state.loading': '正在读取…',
        'state.saved': '已固定：新建对话和重启后都用这个模型。',
        'state.dirty': '有未保存的改动',
        'state.saveFailed': '保存失败',
        'state.readFailed': '读取失败',
        'state.notSavable': '这个 Harness 版本没有暴露默认模型服务，只能看不能改。',
        retry: '重试',
        'toast.newConv': '固定之后，在对话里换模型只影响那个对话，不会再改掉默认值。',
      },
      en: {
        'meta.title': 'Default Model',
        'meta.description': 'Pin the Harness default model: choose it once here and it survives new conversations and restarts.',
        nav: 'Default Model',
        title: 'Default Model',
        lead: 'The model saved here is PINNED: new conversations and restarts keep using it. An open conversation keeps its own model — switching it from the composer picker no longer rewrites this default.',
        'current.title': 'Current default (pinned)',
        'current.title.native': 'Current default (Harness)',
        'current.pinned': 'Pinned',
        'current.native': 'Native default',
        'current.none': 'The current default model is unknown',
        pinch: 'Pinned: the Harness rule "switching a model in any conversation also rewrites the default" can no longer override it.',
        'pinch.native': 'Not pinned yet: this is the Harness native default, which is overwritten by the model last picked in ANY conversation — that is why it kept changing.',
        unpin: 'Unpin',
        'state.unpinned': 'Unpinned: back to the Harness native behaviour.',
        'current.effort': 'Reasoning effort',
        'current.followDefault': 'Model default',
        'catalog.title': 'Choose a model',
        'catalog.provider': 'Provider',
        'catalog.search': 'Filter models…',
        'catalog.empty': 'This provider advertises no models',
        'catalog.error': 'Could not read this provider catalog',
        'catalog.manual': 'Or type the model id',
        'catalog.count': '{n} models',
        'catalog.offline': 'Catalog unavailable: the host llm service returned no providers',
        effort: 'Reasoning effort',
        'effort.default': 'Model default',
        save: 'Save as default',
        saving: 'Saving…',
        reload: 'Reload',
        'state.loading': 'Loading…',
        'state.saved': 'Pinned: new conversations and restarts use this model.',
        'state.dirty': 'Unsaved changes',
        'state.saveFailed': 'Save failed',
        'state.readFailed': 'Load failed',
        'state.notSavable': 'This Harness build exposes no default-model service, so the value is read-only.',
        retry: 'Retry',
        'toast.newConv': 'Once pinned, switching models inside a conversation only affects that conversation.',
      },
    }

    // ── transport ────────────────────────────────────────────────────────────
    // The desktop shell serves the page from `dsh-app://app/` and forwards every
    // non-static path to the Host, so a RELATIVE route keeps working under both
    // the shell and a reverse-proxy prefix; a leading slash would pin the
    // request to the origin root and 404 there.
    // Host 半边的路由前缀（与 index.js 的 API_PATH 一致）。
    const API_ROOT = 'dsh-default-model/api'

    function apiUrl(path) {
      const base = (typeof document !== 'undefined' && document.baseURI) || 'http://127.0.0.1/'
      const relative = `${API_ROOT}${String(path).startsWith('/') ? path : `/${path}`}`
      try {
        return new URL(relative, base).href
      } catch {
        return relative
      }
    }

    async function request(path, options) {
      const res = await fetch(apiUrl(path), {
        ...options,
        headers: {
          accept: 'application/json',
          ...(options?.body ? { 'content-type': 'application/json' } : {}),
          ...(options?.headers ?? {}),
        },
      })
      let data = {}
      try {
        data = await res.json()
      } catch { /* 非 JSON 响应按空对象处理 */ }
      if (!res.ok) {
        const error = new Error(data?.error || `HTTP ${res.status}`)
        error.status = res.status
        error.hint = data?.hint || ''
        throw error
      }
      return data
    }

    const fetchState = () => request('/state')
    const postSave = selection => request('/save', { method: 'POST', body: JSON.stringify(selection) })
    const postReset = () => request('/reset', { method: 'POST', body: JSON.stringify({}) })

    // ── styles ───────────────────────────────────────────────────────────────
    const C = {
      page: { display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: '760px' },
      h1: { fontSize: '16px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      lead: { margin: 0, fontSize: '13px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l2))',
        background: 'var(--dsw-alias-settings-card-fill, transparent)',
        borderRadius: '12px',
        padding: '14px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      cardTitle: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.02em', color: 'var(--dsw-alias-label-tertiary)' },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      chip: {
        fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, monospace)',
        fontSize: '12.5px',
        padding: '3px 8px',
        borderRadius: '6px',
        background: 'var(--dsw-alias-bg-l2, rgba(127,127,127,0.12))',
        color: 'var(--dsw-alias-label-primary)',
      },
      label: { fontSize: '12.5px', color: 'var(--dsw-alias-label-secondary)', minWidth: '64px' },
      select: {
        flex: '1 1 220px',
        minWidth: '180px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
      },
      input: {
        width: '100%',
        boxSizing: 'border-box',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '13px',
      },
      list: {
        maxHeight: '260px',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '4px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
      },
      option: selected => ({
        textAlign: 'left',
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '6px 9px',
        borderRadius: '6px',
        border: '1px solid ' + (selected ? 'var(--dsw-alias-accent)' : 'transparent'),
        background: selected ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,0.14))' : 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: '13px',
      }),
      optionMeta: { fontSize: '11.5px', color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, monospace)' },
      primary: disabled => ({
        padding: '8px 16px',
        borderRadius: '8px',
        border: 'none',
        background: disabled ? 'var(--dsw-alias-border-l3, rgba(127,127,127,0.3))' : 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-accent))',
        color: 'var(--dsw-alias-label-on-accent, #fff)',
        fontSize: '13px',
        fontWeight: 600,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }),
      ghost: {
        padding: '7px 12px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '13px',
        cursor: 'pointer',
      },
      hint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', margin: 0, lineHeight: 1.55 },
      error: { fontSize: '12.5px', color: 'var(--dsw-alias-state-error-primary)', margin: 0, lineHeight: 1.55 },
      ok: { fontSize: '12.5px', color: 'var(--dsw-alias-state-success-primary)', margin: 0, lineHeight: 1.55 },
    }

    /** `provider \u0000 model` —— 用来判断选中的模型是不是列表里那一条。 */
    const keyOf = (provider, model) => `${provider}\u0000${model}`

    function ModelOption({ item, selected, onSelect }) {
      return h('button', {
        type: 'button',
        style: C.option(selected),
        'aria-pressed': selected,
        onClick: () => onSelect(item.id),
      },
        h('span', null, item.name || item.id),
        item.name && item.name !== item.id ? h('span', { style: C.optionMeta }, item.id) : null)
    }

    function Section(props) {
      const ctx = props.ctx
      const t = useCallback(key => {
        try {
          return ctx.locale.bind(NS)(key)
        } catch {
          return DICT.zh[key] ?? key
        }
      }, [ctx])

      const [state, setState] = useState(null)
      const [loading, setLoading] = useState(true)
      const [loadError, setLoadError] = useState(null)
      const [provider, setProvider] = useState('')
      const [model, setModel] = useState('')
      const [effort, setEffort] = useState('')
      const [query, setQuery] = useState('')
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const [saved, setSaved] = useState(false)
      const [notice, setNotice] = useState('')

      const load = useCallback(async () => {
        setLoading(true)
        setLoadError(null)
        try {
          const data = await fetchState()
          setState(data)
          const current = data?.current ?? {}
          setProvider(String(current.provider ?? ''))
          setModel(String(current.model ?? ''))
          setEffort(String(current.reasoningEffort ?? ''))
          setSaved(false)
          setNotice('')
        } catch (error) {
          setLoadError(error)
          setState(null)
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const providers = useMemo(() => state?.providers ?? [], [state])
      const effortIds = useMemo(() => {
        const list = Array.isArray(state?.efforts) ? state.efforts.slice() : []
        const current = state?.current?.reasoningEffort
        if (typeof current === 'string' && current !== '' && !list.includes(current)) list.unshift(current)
        return list
      }, [state])

      const activeProvider = useMemo(
        () => providers.find(row => row.provider === provider) ?? null,
        [providers, provider],
      )
      const models = useMemo(() => {
        const rows = activeProvider?.models ?? []
        const needle = query.trim().toLowerCase()
        if (needle === '') return rows
        return rows.filter(item => `${item.id} ${item.name}`.toLowerCase().includes(needle))
      }, [activeProvider, query])

      const current = state?.current ?? null
      const dirty = Boolean(state) && (
        String(current?.provider ?? '') !== provider
        || String(current?.model ?? '') !== model
        || String(current?.reasoningEffort ?? '') !== effort
      )
      const canSave = Boolean(state?.canSave) && provider !== '' && model !== '' && !saving

      const pickProvider = value => {
        setProvider(value)
        setSaved(false)
        setSaveError(null)
        const row = providers.find(entry => entry.provider === value)
        // 切 provider 后旧 model 通常不属于它：先落到该 provider 的第一个模型，
        // 免得用户以为「选好了」却存了一条跨 provider 的路由。
        if (row && row.models.length > 0 && !row.models.some(item => item.id === model)) {
          setModel(row.models[0].id)
        }
        if (row && row.models.length === 0) setModel('')
      }

      const submit = async () => {
        if (!canSave) return
        setSaving(true)
        setSaveError(null)
        try {
          const payload = { provider, model }
          if (effort !== '') payload.reasoningEffort = effort
          const result = await postSave(payload)
          setState(prev => (prev
            ? {
              ...prev,
              pinned: result?.pinned ?? true,
              current: result?.current ?? payload,
              native: result?.native ?? prev.native,
            }
            : prev))
          setSaved(true)
        } catch (error) {
          setSaveError(error)
          setSaved(false)
        } finally {
          setSaving(false)
        }
      }

      const unpin = async () => {
        if (saving) return
        setSaving(true)
        setSaveError(null)
        try {
          const result = await postReset()
          setState(prev => (prev
            ? {
              ...prev,
              pinned: false,
              current: result?.current ?? prev.current,
              native: result?.native ?? prev.native,
            }
            : prev))
          const next = result?.current ?? {}
          setProvider(String(next.provider ?? ''))
          setModel(String(next.model ?? ''))
          setEffort(String(next.reasoningEffort ?? ''))
          setSaved(false)
          setNotice(t('state.unpinned'))
        } catch (error) {
          setSaveError(error)
        } finally {
          setSaving(false)
        }
      }

      if (loading && !state) {
        return h('div', { style: C.page }, h('h1', { style: C.h1 }, t('title')), h('p', { style: C.hint }, t('state.loading')))
      }

      if (loadError && !state) {
        return h('div', { style: C.page },
          h('h1', { style: C.h1 }, t('title')),
          h('p', { style: C.error }, `${t('state.readFailed')}：${loadError.message || loadError}`),
          h('p', { style: C.hint }, loadError.hint || ''),
          h('div', { style: C.row }, h('button', { type: 'button', style: C.ghost, onClick: () => void load() }, t('retry'))))
      }

      return h('div', { style: C.page },
        h('div', null,
          h('h1', { style: C.h1 }, t('title')),
          h('p', { style: C.lead }, t('lead'))),

        h('div', { style: C.card },
          h('div', { style: C.row },
            h('div', { style: { ...C.cardTitle, flex: 1 } }, state?.pinned ? t('current.title') : t('current.title.native')),
            state?.pinned
              ? h('button', { type: 'button', style: C.ghost, disabled: saving, onClick: () => void unpin() }, t('unpin'))
              : null),
          current
            ? h('div', { style: C.row },
              h('span', { style: C.chip }, String(current.provider ?? '?')),
              h('span', { style: C.chip }, String(current.model ?? '?')),
              h('span', { style: C.chip }, current.reasoningEffort ? `${t('current.effort')}: ${current.reasoningEffort}` : t('current.followDefault')),
              state?.pinned
                ? h('span', { style: { ...C.chip, color: 'var(--dsw-alias-state-success-primary)' } }, t('current.pinned'))
                : null)
            : h('p', { style: C.hint }, t('current.none')),
          // 固定时如果原生条目里还躺着别的值，说清楚「以哪个为准」。
          state?.pinned && state?.native
            && (String(state.native.provider) !== String(current?.provider) || String(state.native.model) !== String(current?.model))
            ? h('p', { style: C.hint }, `${t('current.native')}: ${state.native.provider}/${state.native.model}`)
            : null,
          h('p', { style: C.hint }, state?.pinned ? t('pinch') : t('pinch.native'))),

        h('div', { style: C.card },
          h('div', { style: C.row }, h('div', { style: C.cardTitle, flex: 1 }, t('catalog.title')),
            h('button', { type: 'button', style: C.ghost, onClick: () => void load() }, t('reload'))),

          providers.length === 0
            ? h('p', { style: C.hint }, t('catalog.offline'))
            : h(Fragment, null,
              h('div', { style: C.row },
                h('span', { style: C.label }, t('catalog.provider')),
                h('select', {
                  style: C.select,
                  value: provider,
                  onChange: event => pickProvider(event.target.value),
                },
                providers.map(row => h('option', { key: row.provider, value: row.provider }, row.label)),
                provider === '' ? h('option', { value: '' }, '—') : null)),

              activeProvider?.error
                ? h('p', { style: C.error }, `${t('catalog.error')}：${activeProvider.error}`)
                : null,

              h('input', {
                style: C.input,
                placeholder: t('catalog.search'),
                value: query,
                onChange: event => setQuery(event.target.value),
              }),

              models.length === 0
                ? h('p', { style: C.hint }, t('catalog.empty'))
                : h('div', { style: C.list, role: 'listbox', 'aria-label': t('catalog.title') },
                  models.slice(0, 300).map(item => h(ModelOption, {
                    key: `${provider}:${item.id}`,
                    item,
                    selected: keyOf(provider, item.id) === keyOf(provider, model),
                    onSelect: id => { setModel(id); setSaved(false); setSaveError(null) },
                  }))),

              h('div', { style: C.row },
                h('span', { style: C.label }, t('catalog.count').replace('{n}', String(models.length))),
                h('input', {
                  style: { ...C.input, flex: '1 1 240px', fontFamily: 'var(--dsw-alias-mono-font-family, ui-monospace, monospace)' },
                  placeholder: t('catalog.manual'),
                  value: model,
                  onChange: event => { setModel(event.target.value); setSaved(false); setSaveError(null) },
                })))),

        h('div', { style: C.card },
          h('div', { style: C.row },
            h('span', { style: C.label }, t('effort')),
            h('select', {
              style: C.select,
              value: effort,
              onChange: event => { setEffort(event.target.value); setSaved(false); setSaveError(null) },
            },
            h('option', { value: '' }, t('effort.default')),
            effortIds.map(id => h('option', { key: id, value: id }, id)))),
          h('p', { style: C.hint }, t('toast.newConv'))),

        h('div', { style: C.row },
          h('button', { type: 'button', style: C.primary(!canSave), disabled: !canSave, onClick: () => void submit() },
            saving ? t('saving') : t('save')),
          dirty ? h('span', { style: C.hint }, t('state.dirty')) : null,
          saved ? h('span', { style: C.ok }, t('state.saved')) : null,
          notice ? h('span', { style: C.hint }, notice) : null),

        saveError ? h('p', { style: C.error }, `${t('state.saveFailed')}：${saveError.message || saveError}${saveError.hint ? `（${saveError.hint}）` : ''}`) : null,
        state && !state.canSave ? h('p', { style: C.hint }, t('state.notSavable')) : null)
    }

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-default-model: dictionaries')
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'default-model',
        order: 42,
        label: () => t('nav'),
        locale: NS,
      }, props => h(Section, { ...props, ctx }))), 'dsh-default-model: settings section')
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'default-model'
    exports.__test = { DICT, apiUrl, keyOf }
    return module.exports
  },
})
