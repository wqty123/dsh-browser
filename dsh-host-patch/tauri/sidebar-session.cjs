'use strict'
// Embedded verbatim into DSH Tauri's Electron main (runtime/browser.cjs) by tools/generate-tauri-host-patch.mjs.
// One persistent sidebar partition per DSH home (as on rc.5), plus a checkpoint for the session cookies
// Chromium drops at exit, so the sidebar keeps its logins across DSH Tauri restarts.
module.exports = ({ app, createHash, fs, path }) => {
  const GESTURE_MS = 10_000
  const FILE = 'dsh-sidebar-session-cookies.json'
  const states = new Map()
  const keyOf = cookie => JSON.stringify([cookie.name, cookie.domain ?? '', cookie.path ?? '/'])
  const urlOf = cookie => {
    const host = (cookie.domain ?? '').replace(/^\./, '')
    return `http${cookie.secure ? 's' : ''}://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}${cookie.path ?? '/'}`
  }
  const record = cookie => ({
    url: urlOf(cookie), name: cookie.name, value: cookie.value,
    ...cookie.hostOnly ? {} : { domain: cookie.domain },
    path: cookie.path ?? '/', secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
    ...typeof cookie.sameSite === 'string' ? { sameSite: cookie.sameSite } : {},
  })
  const valid = value => value !== null && typeof value === 'object' && typeof value.url === 'string'
    && typeof value.name === 'string' && typeof value.value === 'string' && value.expirationDate === undefined
    && value.partitionKey === undefined && value.partitioned === undefined
  const unpartitioned = cookie => cookie.partitionKey == null && cookie.partitioned !== true
  const write = state => {
    clearTimeout(state.timer)
    state.timer = undefined
    const temporary = `${state.file}.${process.pid}.tmp`
    try {
      fs.writeFileSync(temporary, JSON.stringify([...state.cookies.values()]), { mode: 0o600 })
      fs.renameSync(temporary, state.file)
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }) } catch {}
      console.error('dsh sidebar session cookie checkpoint failed', error)
    }
  }
  const flushStorage = target => { try { target.flushStorageData() } catch {} }
  const flushAll = () => {
    for (const [target, state] of states) {
      flushStorage(target)
      if (state.timer !== undefined) write(state)
    }
  }
  // electron-rs is stopped by a kill (socket shutdown, then the Windows job object / child.kill),
  // so will-quit rarely runs and Chromium's lazy localStorage commit is lost. Commit after the
  // input and loads that change a sidebar page's storage instead.
  const storageCommit = new WeakMap()
  const gestures = new WeakMap()
  const commitSoon = target => {
    clearTimeout(storageCommit.get(target))
    storageCommit.set(target, setTimeout(() => flushStorage(target), 300))
  }
  app.on('web-contents-created', (_event, contents) => {
    const target = contents.session
    if (!states.has(target)) return
    const commit = () => commitSoon(target)
    contents.on('input-event', (_input, input) => {
      if (input.type !== 'mouseUp' && input.type !== 'keyUp') return
      gestures.set(contents, Date.now())
      commit()
    })
    for (const event of ['did-finish-load', 'did-navigate-in-page', 'destroyed']) contents.on(event, commit)
  })
  app.on('will-quit', flushAll)
  process.on('exit', flushAll)
  const storage = target => target.storagePath ?? target.getStoragePath?.() ?? undefined
  const home = process.env.DSH_HOME || app.getPath('userData')
  const reserved = new Set()
  return {
    download(event, item, contents) {
      if (!(Date.now() - (gestures.get(contents) ?? -Infinity) < GESTURE_MS)) return event.preventDefault()
      const directory = app.getPath('downloads')
      const name = path.basename(item.getFilename() || 'download')
      const extension = path.extname(name)
      const stem = name.slice(0, name.length - extension.length)
      let target = path.join(directory, name)
      for (let n = 1; reserved.has(target) || fs.existsSync(target); n++) target = path.join(directory, `${stem} (${n})${extension}`)
      fs.mkdirSync(directory, { recursive: true })
      reserved.add(target)
      item.once('done', () => reserved.delete(target))
      item.setSavePath(target)
    },
    partition() {
      return 'persist:dsh-sidebar-browser-' + createHash('sha256').update(home).digest('hex').slice(0, 32)
    },
    attach(target) {
      const existing = states.get(target)
      if (existing !== undefined) return existing.ready
      const directory = storage(target)
      if (directory === undefined) throw new Error('browser guest: persistent sidebar storage is unavailable')
      const state = { file: path.join(directory, FILE), cookies: new Map(), timer: undefined, ready: Promise.resolve() }
      states.set(target, state)
      let saved = []
      try { saved = JSON.parse(fs.readFileSync(state.file, 'utf8')) } catch {}
      const restored = Array.isArray(saved) ? saved.filter(valid) : []
      for (const cookie of restored) state.cookies.set(keyOf({ ...cookie, domain: cookie.domain ?? new URL(cookie.url).hostname }), cookie)
      const schedule = () => {
        clearTimeout(state.timer)
        state.timer = setTimeout(() => write(state), 200)
      }
      target.cookies.on('changed', (_event, cookie, _cause, removed) => {
        const key = keyOf(cookie)
        if (removed || cookie.session !== true || !unpartitioned(cookie)) state.cookies.delete(key)
        else state.cookies.set(key, record(cookie))
        if (cookie.session !== true) target.cookies.flushStore().catch(() => {})
        schedule()
      })
      state.ready = Promise.all(restored.map(cookie => target.cookies.set(cookie).catch(() => {}))).then(() => undefined)
      return state.ready
    },
  }
}
