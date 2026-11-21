import { permissionGuard } from './permission-guard.mjs'

const DOMAINS = new Set(['Accessibility', 'DOM', 'DOMSnapshot', 'CSS', 'Emulation', 'Input', 'Log', 'Network', 'Page', 'Runtime', 'Target'])
const DENIED = new Set(['Page.close', 'Page.bringToFront', 'Page.setDownloadBehavior', 'Page.setInterceptFileChooserDialog',
  'Target.activateTarget', 'Target.createTarget', 'Target.closeTarget', 'Target.attachToTarget', 'Target.attachToBrowserTarget',
  'Target.detachFromTarget', 'Target.sendMessageToTarget', 'Target.exposeDevToolsProtocol', 'DOM.setFileInputFiles', 'Page.printToPDF'])
const validScope = value => typeof value === 'string' && value.length > 0 && value.length <= 4096
const allowedUrl = url => typeof url === 'string' && (url === 'about:blank' || /^https?:\/\//i.test(url))

export class ExtensionController {
  constructor(api, emit) {
    this.api = api; this.emit = emit; this.leases = new Map(); this.created = new Map(); this.tabLeases = new Map(); this.attaching = new Set(); this.generation = 0
    this.related = new Map(); this.containing = new Set()
    api.debugger.onEvent.addListener((source, method, params) => { void this.event(source, method, params) })
    api.debugger.onDetach.addListener((source, reason) => {
      const lease = this.tabLeases.get(source.tabId)
      if (lease) { this.leases.delete(lease.id); this.tabLeases.delete(source.tabId); this.emit({ type: 'event', lease: lease.id, method: 'target.detached', params: { reason } }) }
    })
    api.tabs.onRemoved.addListener(tabId => { this.created.delete(tabId); this.related.delete(tabId) })
    api.tabs.onCreated.addListener(tab => { void this.containPopup(tab) })
    api.windows.onCreated.addListener(window => {
      void api.tabs.query({ windowId: window.id }).then(tabs => Promise.all(tabs.map(tab => this.containPopup(tab)))).catch(() => {})
    })
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
        lease.notices = lease.notices.slice(-16)
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
        lease.notices.push(`Quiet mode dismissed JavaScript ${params.type ?? 'dialog'}: ${String(params.message ?? '').slice(0, 256)}`)
      } catch { lease.notices.push('Quiet mode could not dismiss a JavaScript dialog; human action may be required.') }
      lease.notices = lease.notices.slice(-16)
    }
    if (method === 'Page.fileChooserOpened') {
      lease.notices.push('Quiet mode blocked a file chooser; file uploads are unavailable.')
      lease.notices = lease.notices.slice(-16)
    }
    if (method.startsWith('Network.')) {
      params = JSON.parse(JSON.stringify(params))
      for (const headers of [params.headers, params.request?.headers, params.response?.headers]) {
        if (headers) for (const key of Object.keys(headers)) if (/^(authorization|proxy-authorization|cookie|set-cookie)$/i.test(key)) headers[key] = '[redacted]'
      }
    }
    const event = { type: 'event', lease: lease.id, method, params, ...(source.sessionId ? { sessionId: source.sessionId } : {}) }
    if (new TextEncoder().encode(JSON.stringify(event)).length <= 32 * 1024) this.emit(event)
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
      await this.api.debugger.attach({ tabId }, '1.3')
      if (generation !== this.generation) { await this.api.debugger.detach({ tabId }).catch(() => {}); throw Error('connection released during attach') }
      const lease = { id: crypto.randomUUID(), tabId, scope, view, notices: [] }
      this.leases.set(lease.id, lease); this.tabLeases.set(tabId, lease)
      try {
        await this.api.debugger.sendCommand({ tabId }, 'Page.enable', {})
        await this.api.debugger.sendCommand({ tabId }, 'Page.setInterceptFileChooserDialog', { enabled: true })
        await this.api.debugger.sendCommand({ tabId }, 'Emulation.setFocusEmulationEnabled', { enabled: true })
        await this.api.debugger.sendCommand({ tabId }, 'Page.setWebLifecycleState', { state: 'active' })
        if (this.created.get(tabId) === scope) {
          await this.api.debugger.sendCommand({ tabId }, 'Page.addScriptToEvaluateOnNewDocument', { source: permissionGuard })
          await this.api.debugger.sendCommand({ tabId }, 'Runtime.evaluate', { expression: permissionGuard })
        }
        if (generation !== this.generation) throw Error('connection released')
        return { lease: lease.id, tabId, url, title: tab.title ?? '', created: this.created.get(tabId) === scope }
      } catch {
        this.leases.delete(lease.id); this.tabLeases.delete(tabId)
        await this.api.debugger.detach({ tabId }).catch(() => {})
        throw Error('quiet-mode interception is unavailable on this browser/tab; no control lease was granted')
      }
    } finally { this.attaching.delete(tabId) }
  }
  async request(operation) {
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
      await this.api.tabs.remove(operation.tabId)
      this.created.delete(operation.tabId)
      return {}
    }
    const lease = this.leases.get(operation.lease)
    if (!lease || lease.scope !== scope || lease.view !== operation.view) throw Error('stale or foreign tab lease; explicitly reacquire the tab')
    if (kind === 'detach') {
      this.leases.delete(lease.id); this.tabLeases.delete(lease.tabId)
      await this.api.debugger.detach({ tabId: lease.tabId }).catch(() => {})
      return {}
    }
    if (kind === 'events') return lease.notices.splice(0)
    if (kind !== 'cdp') throw Error('unsupported extension operation')
    if (lease.notices.length) throw Error(lease.notices.shift())
    let { method, params = {}, sessionId } = operation
    if (typeof method !== 'string' || !DOMAINS.has(method.split('.')[0]) || DENIED.has(method)
      || /Cookies|Cookie/.test(method) || method.startsWith('Input.') && !method.startsWith('Input.dispatch') && method !== 'Input.insertText'
      || sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.length > 128)
      || !params || typeof params !== 'object' || Array.isArray(params)) throw Error('CDP capability is unavailable in personal-browser quiet mode')
    if (method === 'Page.navigate' && !allowedUrl(params.url)) throw Error('navigation requires an http(s) URL')
    if (method === 'Input.insertText') { method = 'Input.dispatchKeyEvent'; params = { type: 'char', text: String(params.text ?? '') } }
    if (method === 'Page.captureScreenshot') {
      if (!params.clip) {
        const metrics = await this.api.debugger.sendCommand({ tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) }, 'Page.getLayoutMetrics', {})
        const viewport = metrics.cssVisualViewport ?? metrics.visualViewport
        const width = viewport?.clientWidth ?? 1280, height = viewport?.clientHeight ?? 960
        params = { ...params, clip: { x: viewport?.pageX ?? 0, y: viewport?.pageY ?? 0, width, height, scale: Math.min(1, 1280 / width, 960 / height) } }
      }
      if (params.captureBeyondViewport === true || params.fromSurface === false || params.clip && (
        !Number.isFinite(params.clip.width) || !Number.isFinite(params.clip.height) || !Number.isFinite(params.clip.scale)
        || params.clip.width <= 0 || params.clip.height <= 0 || !Number.isFinite(params.clip.x) || !Number.isFinite(params.clip.y)
        || params.clip.width * params.clip.scale > 1280 || params.clip.height * params.clip.scale > 960 || params.clip.scale <= 0)) throw Error('screenshot exceeds quiet-mode dimensions')
      params = { ...params, fromSurface: true, captureBeyondViewport: false }
    }
    return this.api.debugger.sendCommand({ tabId: lease.tabId, ...(sessionId ? { sessionId } : {}) }, method, params)
  }
  async release() {
    this.generation++
    this.related.clear()
    const leases = [...this.leases.values()]
    this.leases.clear(); this.tabLeases.clear()
    await Promise.allSettled(leases.map(lease => this.api.debugger.detach({ tabId: lease.tabId })))
  }
}
