import { EXTENSION_LIMITS, DEBUGGER_IDLE_TIMEOUT_MS, DEBUGGER_IDLE_ALARM, DEBUGGER_SESSION_KEY } from './constants.mjs'
import { permissionGuard } from './permission-guard.mjs'

const DOMAINS = new Set(['Accessibility', 'DOM', 'DOMSnapshot', 'CSS', 'Emulation', 'Input', 'Log', 'Network', 'Page', 'Runtime', 'Target'])
const DENIED = new Set(['Page.close', 'Page.bringToFront', 'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog',
  'Target.activateTarget', 'Target.createTarget', 'Target.closeTarget', 'Target.attachToTarget', 'Target.attachToBrowserTarget',
  'Target.detachFromTarget', 'Target.sendMessageToTarget', 'Target.exposeDevToolsProtocol', 'DOM.setFileInputFiles', 'Page.printToPDF'])
const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= EXTENSION_LIMITS.scopeLength
const allowedUrl = url => typeof url === 'string' && (url === 'about:blank' || /^https?:\/\//i.test(url))

export class ExtensionController {
  constructor(api, emit) {
    this.api = api; this.emit = emit; this.leases = new Map(); this.created = new Map(); this.tabLeases = new Map(); this.attaching = new Set(); this.generation = 0
    this.related = new Map(); this.containing = new Set()
    this.active = undefined; this.expectedDetach = new Set(); this.tail = Promise.resolve()
    this.ready = this.restore()
    this.ready.catch(() => {})
    api.alarms?.onAlarm.addListener(alarm => {
      if (alarm.name === DEBUGGER_IDLE_ALARM) return this.enqueue(async () => {
        if (Date.now() >= this.idleAt) await this.suspend()
      }).catch(() => {})
    })
    api.debugger.onEvent.addListener((source, method, params) => { void this.event(source, method, params) })
    api.debugger.onDetach.addListener((source, reason) => {
      if (reason !== 'canceled_by_user' && this.expectedDetach.delete(source.tabId)) return
      if (this.active === source.tabId) this.active = undefined
      const lease = this.tabLeases.get(source.tabId)
      if (lease) { this.leases.delete(lease.id); this.tabLeases.delete(source.tabId); this.emit({ type: 'event', lease: lease.id, method: 'target.detached', params: { reason } }) }
      void this.enqueue(() => this.persist()).catch(() => {})
    })
    api.tabs.onRemoved.addListener(tabId => { this.created.delete(tabId); this.related.delete(tabId) })
    api.tabs.onCreated.addListener(tab => { void this.containPopup(tab) })
    api.windows.onCreated.addListener(window => {
      void api.tabs.query({ windowId: window.id }).then(tabs => Promise.all(tabs.map(tab => this.containPopup(tab)))).catch(() => {})
    })
  }
  enqueue(work) {
    const result = this.tail.then(() => this.ready).then(work)
    this.tail = result.catch(() => {})
    return result
  }
  async persist() {
    await this.api.storage?.session?.set({ [DEBUGGER_SESSION_KEY]: {
      leases: [...this.leases.values()], created: [...this.created], active: this.active, activeReady: this.activeReady, idleAt: this.idleAt,
    } })
  }
  async restore() {
    if (!this.api.storage?.session) return
    const stored = (await this.api.storage.session.get(DEBUGGER_SESSION_KEY))[DEBUGGER_SESSION_KEY]
    for (const lease of stored?.leases ?? []) {
      if (validScope(lease.id) && validScope(lease.scope) && validScope(lease.view) && Number.isInteger(lease.tabId)) {
        lease.notices = Array.isArray(lease.notices) ? lease.notices : []
        lease.blockingNotices = Array.isArray(lease.blockingNotices) ? lease.blockingNotices : []
        this.leases.set(lease.id, lease); this.tabLeases.set(lease.tabId, lease)
      }
    }
    this.created = new Map(stored?.created ?? [])
    const targets = await this.api.debugger.getTargets()
    let retained
    for (const target of targets.filter(target => target.attached && Number.isInteger(target.tabId))) {
      // getTargets also includes other debuggers. Only our own sessions accept commands.
      try { await this.api.debugger.sendCommand({ tabId: target.tabId }, 'Runtime.getIsolateId', {}) }
      catch { continue }
      if (target.tabId === stored?.active && stored.activeReady && this.tabLeases.has(target.tabId) && stored.idleAt > Date.now()) {
        retained = target.tabId
      } else { this.active = target.tabId; await this.suspend() }
    }
    this.active = retained
    this.activeReady = retained !== undefined
    this.idleAt = stored?.idleAt
    if (this.active !== undefined) await this.api.alarms.create(DEBUGGER_IDLE_ALARM, { when: this.idleAt })
    await this.persist()
  }
  suspend() {
    return this.suspending ??= this.detachActive().finally(() => { this.suspending = undefined })
  }
  async detachActive() {
    if (this.active === undefined) return
    const tabId = this.active
    this.expectedDetach.add(tabId)
    try { await this.api.debugger.detach({ tabId }) }
    finally { this.expectedDetach.delete(tabId) }
    this.active = undefined
    this.activeReady = false
    await this.api.alarms?.clear(DEBUGGER_IDLE_ALARM)
    await this.persist()
  }
  async activate(lease) {
    if (this.active === lease.tabId) return
    const generation = this.generation
    await this.suspend()
    const tab = await this.api.tabs.get(lease.tabId)
    if (tab.incognito || !allowedUrl(tab.url || tab.pendingUrl) || !allowedUrl(tab.pendingUrl || tab.url)) throw Error('restricted/internal, extension and incognito pages are unavailable')
    this.active = lease.tabId
    this.activeReady = false
    await this.persist()
    if (generation !== this.generation) { this.active = undefined; throw Error('connection released') }
    try { await this.api.debugger.attach({ tabId: lease.tabId }, '1.3') }
    catch (error) { this.active = undefined; await this.persist(); throw error }
    if (generation !== this.generation) { this.active = lease.tabId; await this.suspend(); throw Error('connection released') }
    try {
      for (const [method, params] of [
        ['Page.enable', {}], ['Page.setInterceptFileChooserDialog', { enabled: true }],
        ['Emulation.setFocusEmulationEnabled', { enabled: true }], ['Page.setWebLifecycleState', { state: 'active' }],
      ]) await this.api.debugger.sendCommand({ tabId: lease.tabId }, method, params)
      if (this.created.get(lease.tabId) === lease.scope) {
        await this.api.debugger.sendCommand({ tabId: lease.tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: permissionGuard })
        await this.api.debugger.sendCommand({ tabId: lease.tabId }, 'Runtime.evaluate', { expression: permissionGuard })
      }
      if (generation !== this.generation || !this.leases.has(lease.id)) throw Error('connection released')
      this.activeReady = true
    } catch (error) {
      await this.suspend()
      throw error
    }
  }
  async containPopup(tab) {
    const root = this.created.has(tab.openerTabId) ? tab.openerTabId : this.related.get(tab.openerTabId)?.root
    const scope = this.tabLeases.has(root) ? this.created.get(root) : undefined
    if (!scope || !Number.isInteger(tab.id) || this.containing.has(tab.id) || this.related.has(tab.id)) return
    this.containing.add(tab.id)
    const generation = this.generation
    try {
      const opener = await this.api.tabs.get(tab.openerTabId)
      if (generation !== this.generation) return
      this.related.set(tab.id, { scope, opener: tab.openerTabId, root })
      const window = await this.api.windows.get(tab.windowId)
      if (generation !== this.generation || !this.tabLeases.has(root)) return
      if (window.type === 'popup' && opener.windowId !== tab.windowId) {
        await this.api.tabs.move(tab.id, { windowId: opener.windowId, index: -1 })
      }
      const lease = this.tabLeases.get(root)
      if (lease) {
        lease.notices.push(`Site-created tab ${tab.id} detected${window.type === 'popup' ? '; moved to opener window without activation' : ''}. Site activation may precede browser events.`)
        lease.notices = lease.notices.slice(-EXTENSION_LIMITS.notices)
      }
      this.emit({ type: 'event', method: 'target.popup', lease: lease?.id, params: { tabId: tab.id, openerTabId: tab.openerTabId, containment: window.type === 'popup' ? 'moved' : 'observed', siteActivated: tab.active === true } })
    } catch {
      this.emit({ type: 'event', method: 'target.popup', params: { tabId: tab.id, containment: 'unavailable' } })
    } finally { this.containing.delete(tab.id) }
  }
  async event(source, method, params = {}) {
    const lease = this.tabLeases.get(source.tabId)
    if (!lease) return
    if (method === 'Page.javascriptDialogOpening') {
      try {
        await this.api.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: false })
        lease.notices.push(`Quiet mode dismissed JavaScript ${params.type ?? 'dialog'}: ${String(params.message ?? '').slice(0, EXTENSION_LIMITS.dialogPreview)}`)
      } catch {
        const msg = 'Quiet mode could not dismiss a JavaScript dialog; human action may be required.'
        lease.notices.push(msg)
        lease.blockingNotices.push(msg)
        lease.blockingNotices = lease.blockingNotices.slice(-EXTENSION_LIMITS.notices)
      }
      lease.notices = lease.notices.slice(-EXTENSION_LIMITS.notices)
    }
    if (method === 'Page.fileChooserOpened') {
      const msg = 'Quiet mode blocked a file chooser; file uploads are unavailable.'
      lease.notices.push(msg)
      lease.blockingNotices.push(msg)
      lease.notices = lease.notices.slice(-EXTENSION_LIMITS.notices)
      lease.blockingNotices = lease.blockingNotices.slice(-EXTENSION_LIMITS.notices)
    }
    if (method.startsWith('Network.')) {
      params = JSON.parse(JSON.stringify(params))
      for (const headers of [params.headers, params.request?.headers, params.response?.headers]) {
        if (headers) for (const key of Object.keys(headers)) if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(key)) headers[key] = '[redacted]'
      }
    }
    const event = { type: 'event', lease: lease.id, method, params, ...(source.sessionId ? { sessionId: source.sessionId } : {}) }
    if (new TextEncoder().encode(JSON.stringify(event)).length <= EXTENSION_LIMITS.eventBytes) this.emit(event)
  }
  async attach(tabId, scope, view) {
    if (!Number.isInteger(tabId) || tabId < 0 || !validScope(scope) || !validScope(view)) throw Error('invalid tab lease')
    if (this.tabLeases.has(tabId) || this.attaching.has(tabId)) throw Error('tab is already leased; release it before adoption')
    if (this.created.has(tabId) && this.created.get(tabId) !== scope) throw Error('tab belongs to another session')
    this.attaching.add(tabId)
    const generation = this.generation
    try {
      const tab = await this.api.tabs.get(tabId)
      const url = tab.url || tab.pendingUrl || (this.created.get(tabId) === scope ? 'about:blank' : undefined)
      if (tab.incognito || !allowedUrl(url) || !allowedUrl(tab.pendingUrl || url)) throw Error('restricted/internal, extension and incognito pages are unavailable')
      const lease = { id: crypto.randomUUID(), tabId, scope, view, notices: [], blockingNotices: [] }
      this.leases.set(lease.id, lease); this.tabLeases.set(tabId, lease)
      try {
        await this.activate(lease)
        if (generation !== this.generation || !this.leases.has(lease.id)) throw Error('connection released')
        return { lease: lease.id, tabId, url, title: tab.title ?? '', created: this.created.get(tabId) === scope }
      } catch {
        this.leases.delete(lease.id); this.tabLeases.delete(tabId)
        if (this.active === tabId) await this.suspend()
        throw Error('quiet-mode interception is unavailable on this browser/tab; no control lease was granted')
      }
    } finally { this.attaching.delete(tabId) }
  }
  request(operation) {
    const generation = this.generation
    return this.enqueue(async () => {
      if (generation !== this.generation) throw Error('connection released')
      try { return await this.perform(operation) }
      finally {
        if (this.active !== undefined) {
          this.idleAt = Date.now() + DEBUGGER_IDLE_TIMEOUT_MS
          await this.api.alarms?.create(DEBUGGER_IDLE_ALARM, { when: this.idleAt })
        }
        await this.persist()
      }
    })
  }
  async perform(operation) {
    if (!operation || typeof operation !== 'object' || !validScope(operation.scope)) throw Error('a scoped operation is required')
    const { kind, scope } = operation
    if (kind === 'create') {
      if (!validScope(operation.view)) throw Error('view identity is required')
      const generation = this.generation
      const windows = await this.api.windows.getAll({ windowTypes: ['normal'] })
      const window = windows.find(value => !value.incognito && Number.isInteger(value.id))
      if (!window) throw Error('open a normal browser window first; quiet mode never creates a window')
      const tab = await this.api.tabs.create({ windowId: window.id, active: false, url: 'about:blank' })
      this.created.set(tab.id, scope)
      if (generation !== this.generation) throw Error('connection released during creation; inactive tab was left open')
      try { return await this.attach(tab.id, scope, operation.view) }
      catch (error) { throw Error(`${error.message}; the inactive agent tab was left open (id ${tab.id})`) }
    }
    if (kind === 'list') {
      const tabs = await this.api.tabs.query({})
      return tabs.filter(tab => !tab.incognito && allowedUrl(tab.url) && !this.tabLeases.has(tab.id) && (!this.created.has(tab.id) || this.created.get(tab.id) === scope))
        .slice(0, 256).map(tab => ({ tabId: tab.id, title: tab.title ?? '', url: tab.url, created: this.created.get(tab.id) === scope }))
    }
    if (kind === 'attach') return this.attach(operation.tabId, scope, operation.view)
    if (kind === 'close') {
      if (!Number.isInteger(operation.tabId) || this.created.get(operation.tabId) !== scope) throw Error('personal, adopted or other-session tabs are detach-only')
      if (this.active === operation.tabId) await this.suspend()
      await this.api.tabs.remove(operation.tabId)
      const lease = this.tabLeases.get(operation.tabId)
      if (lease) this.leases.delete(lease.id)
      this.tabLeases.delete(operation.tabId)
      this.created.delete(operation.tabId)
      return {}
    }
    const lease = this.leases.get(operation.lease)
    if (kind === 'detach' && !lease) return {}
    if (!lease || lease.scope !== scope || lease.view !== operation.view) throw Error('stale or foreign tab lease; explicitly reacquire the tab')
    if (kind === 'detach') {
      this.leases.delete(lease.id); this.tabLeases.delete(lease.tabId)
      if (this.active === lease.tabId) await this.suspend()
      return {}
    }
    if (kind === 'events') return lease.notices.splice(0)
    if (kind !== 'cdp') throw Error('unsupported extension operation')
    if (lease.blockingNotices?.length) throw Error(lease.blockingNotices.shift())
    let { method, params = {}, sessionId } = operation
    if (typeof method !== 'string' || !DOMAINS.has(method.split('.')[0]) || DENIED.has(method)
      || /Cookies|Cookie/.test(method) || method.startsWith('Input.') && !method.startsWith('Input.dispatch') && method !== 'Input.insertText'
      || sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)
      || !params || typeof params !== 'object' || Array.isArray(params)) throw Error('CDP capability is unavailable in personal-browser quiet mode')
    if (method === 'Page.navigate' && !allowedUrl(params.url)) throw Error('navigation requires an http(s) URL')
    await this.activate(lease)
    if (!this.leases.has(lease.id)) throw Error('tab detached during request')
    if (method === 'Input.insertText') {
      for (const text of String(params.text ?? '')) {
        await this.api.debugger.sendCommand({ tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) }, 'Input.dispatchKeyEvent', { type: 'char', text })
      }
      return {}
    }
    if (method === 'Page.captureScreenshot') {
      if (!params.clip) {
        const metrics = await this.api.debugger.sendCommand({ tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) }, 'Page.getLayoutMetrics', {})
        const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
        const width = viewport?.clientWidth ?? EXTENSION_LIMITS.screenshotWidth, height = viewport?.clientHeight ?? EXTENSION_LIMITS.screenshotHeight
        params = { ...params, clip: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0, width, height, scale: Math.min(1, EXTENSION_LIMITS.screenshotWidth / width, EXTENSION_LIMITS.screenshotHeight / height) } }
      }
      if (params.captureBeyondViewport === true || params.fromSurface === false || params.clip && (
        !Number.isFinite(params.clip.width) || !Number.isFinite(params.clip.height) || !Number.isFinite(params.clip.scale)
        || params.clip.width <= 0 || params.clip.height <= 0 || !Number.isFinite(params.clip.x) || !Number.isFinite(params.clip.y)
        || params.clip.width * params.clip.scale > EXTENSION_LIMITS.screenshotWidth || params.clip.height * params.clip.scale > EXTENSION_LIMITS.screenshotHeight || params.clip.scale <= 0)) throw Error('screenshot exceeds quiet-mode dimensions')
      params = { ...params, fromSurface: true, captureBeyondViewport: false }
    }
    return this.api.debugger.sendCommand({ tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
  }
  release() {
    this.generation++
    const interrupt = this.ready.then(() => this.suspend())
    interrupt.catch(() => {})
    return this.enqueue(async () => {
      await interrupt.catch(() => {})
      await this.suspend()
      this.related.clear()
      this.leases.clear(); this.tabLeases.clear()
      await this.persist()
    })
  }
}
