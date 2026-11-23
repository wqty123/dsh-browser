'use strict'
// Embedded verbatim into DSH Tauri's Electron main (runtime/browser.cjs) by tools/generate-tauri-host-patch.mjs.
// electron-rs has no Desktop main-extension loader, so the plugin's desktop bridge never ran there and the
// agent's tools had no CDP into the sidebar. The running plugin names its package in $DSH_HOME; this starts
// that package's `dsh.desktop.main` once, with the shell views BrowserGuests trusts as the sidebar's host.
module.exports = ({ app, webContents, fs, path, os, url, importEntry }) => {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const pointer = path.join(home, 'dsh-builtin-browser-desktop-main.json')
  const hosts = new Set()
  let started = false
  let stop
  const shellContents = () => {
    const live = [...hosts].filter(contents => !contents.isDestroyed())
    const focused = webContents.getFocusedWebContents?.()
    const shell = focused?.hostWebContents ?? focused
    return live.includes(shell) ? shell : live.at(-1)
  }
  const inside = (root, file) => {
    const child = path.relative(root, file)
    return child !== '' && !path.isAbsolute(child) && child !== '..' && !child.startsWith('..' + path.sep)
  }
  const entryOf = () => {
    try {
      const { root } = JSON.parse(fs.readFileSync(pointer, 'utf8'))
      if (typeof root !== 'string' || !path.isAbsolute(root)) return undefined
      const directory = fs.realpathSync(root)
      const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'))
      const main = pkg?.dsh?.desktop?.main
      if (pkg?.name !== 'dsh-builtin-browser' || typeof main !== 'string' || !main.startsWith('./')) return undefined
      const entry = fs.realpathSync(path.resolve(directory, main))
      return inside(directory, entry) ? entry : undefined
    } catch { return undefined }
  }
  const load = async () => {
    if (started) return
    const entry = entryOf()
    if (entry === undefined) return
    started = true
    fs.unwatchFile(pointer, poll)
    try {
      const extension = await importEntry(url.pathToFileURL(entry).href)
      if (typeof extension?.start !== 'function') throw new Error('entry must export start(api)')
      const result = await extension.start({ app, webContents, dshHome: home, shellContents })
      stop = typeof result === 'function' ? result : typeof result?.dispose === 'function' ? () => result.dispose() : undefined
    } catch (error) { console.error('desktop main extension dsh-builtin-browser:', error) }
  }
  const poll = () => { void load() }
  void app.whenReady().then(() => {
    fs.watchFile(pointer, { interval: 1000, persistent: false }, poll)
    return load()
  })
  app.on('will-quit', () => {
    fs.unwatchFile(pointer, poll)
    try { stop?.() } catch (error) { console.error('desktop main extension dsh-builtin-browser:', error) }
  })
  return {
    host(contents) {
      hosts.add(contents)
      contents.once('destroyed', () => hosts.delete(contents))
    },
  }
}
