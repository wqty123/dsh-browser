import { DEFAULT_OPERATION_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { writeFileNoReplace } from './file-write.ts'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import type { BrowserScreenshotRequest, BrowserSessionId, ExportedCookie } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { PROVIDER_TIMEOUTS, CDP_PAGE_CAPTURE_SCREENSHOT, layoutSize, toExportedCookies, toCdpCookie, withTimeout } from './provider-core.ts'
import { ProviderInteraction } from './provider-interaction.ts'

/**
 * Whether a directory entry exists at `path`, judging the ENTRY rather than what it
 * points at.
 *
 * `existsSync` follows links, so a DANGLING symlink — a link whose target does not
 * exist — reads as "nothing here", and a write to that path creates the target
 * instead: outside `downloadDir` whenever the link points out of it. `lstatSync`
 * sees the link itself, which is the only correct answer to "is this name free".
 * @param path - the path to judge.
 * @returns true when any entry (file, directory, link) occupies the name.
 */
function entryExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * The real path of the deepest existing ancestor of `path` — `path` itself when it
 * exists, otherwise the nearest directory above it that does.
 *
 * `resolve()` normalizes `..` but never follows a link, so nothing textual can tell
 * that `<downloadDir>/link/x.png` leaves the directory through `link`. The first
 * ancestor that exists (judged by lstat, so a dangling link counts — the write would
 * go through it) is the last component whose real location still determines where
 * the bytes land, so that is the one to resolve and check.
 * @param path - an absolute path that may not exist yet.
 * @returns the resolved real path of its deepest existing ancestor.
 */
function realAncestorOf(path: string): string {
  let current = path
  for (let depth = 0; depth < 64; depth += 1) {
    if (entryExists(current)) {
      try {
        return realpathSync(current)
      } catch {
        // The entry vanished between the two calls, or cannot be resolved: the
        // textual path is the best available answer, and the write reports the rest.
        return current
      }
    }
    const parent = dirname(current)
    if (parent === current) return current
    current = parent
  }
  return current
}

/**
 * Bounds for one passive preview frame.
 *
 * The design's numbers (issue #34): viewport only, JPEG quality 70, fit inside 1280x720 without
 * enlarging, and a 2 s capture ceiling so a stuck frame ends the viewer's wait instead of piling up
 * behind the control queue. These are deliberately not configurable in v1 — one canonical spec per
 * target is what lets several viewers share a single capture.
 */
const PREVIEW_CAPTURE_MS = 2_000

const PREVIEW_QUALITY = 70

const PREVIEW_MAX_WIDTH = 1280

const PREVIEW_MAX_HEIGHT = 720

export abstract class ProviderMedia extends ProviderInteraction {
  /**
   * Admit a caller-supplied save path for a file the browser writes to disk.
   * ONE gate for both `dsh_browser_download` and `dsh_browser_screenshot`: the path
   * must be absolute, must resolve inside `downloadDir`, and must not already
   * exist. Without it a prompt-injected agent could write — or silently
   * replace — any file the DSH process can reach, which also escapes the file
   * sandbox every other tool in the set runs under.
   * @param savePath - the caller's target path.
   * @param kind - the operation, used in the error code and message.
   * @returns the resolved absolute target path.
   * @throws BrowserError when the path is relative, outside the directory, or occupied.
   */
  private admitSavePath(savePath: string, kind: 'download' | 'screenshot'): string {
    const code = kind === 'download' ? 'BROWSER_DOWNLOAD_BLOCKED' : 'BROWSER_SCREENSHOT_BLOCKED'
    if (!isAbsolute(savePath)) {
      throw new BrowserError(`browser: ${kind} savePath must be an absolute path`, code)
    }
    const file = resolve(savePath)
    if (this.downloadDir !== undefined) {
      const dir = resolve(this.downloadDir)
      // Windows paths are case-insensitive and resolve() does not normalize case, so there
      // the containment check folds case — otherwise C:\Users\X\Downloads and
      // c:\users\x\downloads would read as different roots. Everywhere else the fold is
      // REMOVED: a case-sensitive filesystem (Linux) treats /home/u/DOWNLOADS and
      // /home/u/Downloads as different directories, so folding case there let a savePath
      // that merely differed in case pass admission — a directory-confinement escape, and
      // one that mkdirSync below would then happily create.
      const fold = process.platform === 'win32' ? (value: string): string => value.toLowerCase() : (value: string): string => value
      const dirKey = fold(dir)
      const fileKey = fold(file)
      // The directory ITSELF is refused, not accepted: a save path that IS downloadDir names
      // a directory, so there is no file to write — and mkdirSync would have created the
      // directory when it did not exist. Two paths are "inside" only when the file path is
      // strictly below the directory, which the separator check below already expresses.
      if (!fileKey.startsWith(dirKey + fold(sep))) {
        throw new BrowserError(`browser: ${kind} savePath must be inside downloadDir "${dir}"`, code)
      }
      // The check above is textual, and a symlink defeats it: resolve() normalizes `..`
      // but never follows a link, so `<downloadDir>/out/x.png` passed every test above
      // while `out` pointed at a directory outside the gate — and the write then landed
      // there. Resolve the REAL location of the deepest existing ancestor (which is what
      // decides where the bytes go) and require it to be inside the real directory too.
      // A legitimate path is unaffected: its ancestor resolves to the directory itself.
      //
      // The directory is created first so that it can be resolved at all — mkdirSync is a
      // no-op for one that already exists — and a directory that cannot be created or
      // resolved falls back to its textual form, leaving the real filesystem error to the
      // write instead of inventing one here.
      let realDir: string
      try {
        mkdirSync(dir, { recursive: true })
        realDir = fold(realpathSync(dir))
      } catch {
        realDir = fold(dir)
      }
      const realAncestor = fold(realAncestorOf(file))
      if (realAncestor !== realDir && !realAncestor.startsWith(realDir + fold(sep))) {
        throw new BrowserError(`browser: ${kind} savePath resolves outside downloadDir "${dir}" (a symlink leaves it)`, code)
      }
    }
    // Never replace an existing file: its previous content is unrecoverable,
    // and the admitted directory may hold files the human put there. A new
    // name is one tool call away.
    //
    // Judged with lstat (see {@link entryExists}), not existsSync: existsSync FOLLOWS
    // links, so a DANGLING symlink read as "nothing here" and the write below created
    // its target — outside the directory whenever the link pointed out of it. It is the
    // directory entry that has to be free, whatever that entry points at.
    if (entryExists(file)) {
      throw new BrowserError(`browser: refusing to overwrite existing file "${file}" — use another name`, code)
    }
    return file
  }

  /**
   * Download an HTTP(S) URL with the session's cookies to a local file.
   * Admission is the shared {@link admitSavePath} gate. The carrier downloads
   * with its own authenticated browser session. Both admitted paths and screenshots are confined
   * to `downloadDir`, so a prompt-injected agent cannot write arbitrary
   * machine paths.
   * @param session - the session whose cookies are used.
   * @param request - the URL plus the absolute target path.
   * @param signal - optional cancellation.
   * @returns the path the file was written to.
   */
  async download(session: BrowserSessionId, request: { readonly url: string; readonly savePath: string }, signal?: AbortSignal): Promise<{ readonly path: string }> {
    // Before admission, and before the session is even resolved: a switched-off action is
    // not a path problem, and the caller should hear the real reason.
    this.assertActionAllowed('download')
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    // URL admission: HTTP(S) only (mirrors the navigation guard). The seam
    // intentionally does not block private/localhost targets — a shared real
    // browser legitimately reaches local dev servers.
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      throw new BrowserError(`browser: refusing download of unparseable URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserError(`browser: refusing download of non-HTTP(S) URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED')
    }
    // savePath admission: the shared gate — absolute, inside `downloadDir`,
    // and never an existing file. Screenshots use the very same one.
    const savePath = this.admitSavePath(request.savePath, 'download')
    const downloadable = handle
    if (typeof downloadable.download !== 'function') {
      throw new BrowserError('browser: the selected carrier does not provide file downloads', 'BROWSER_DOWNLOAD_UNSUPPORTED')
    }
    // The child fetches and writes the file; a slow/hung network can block
    // it well past the tool budget, so bound it. NOTE: unlike CDP calls,
    // there is no child-side abort mechanism for the RPC download — when the
    // parent's timeout fires the child continues writing. The parent's pending
    // entry is cleaned up (the promise settles) and the child's eventual
    // reply is harmlessly consumed by the RPC layer.
    const timeoutMs = PROVIDER_TIMEOUTS.download
    await withTimeout(
      downloadable.download(request.url, savePath),
      timeoutMs,
      signal,
      `browser: download timed out after ${timeoutMs}ms`,
    )
    this.record(s, 'download', { url: request.url, savePath }, true, { result: savePath })
    return { path: savePath }
  }

  /**
   * Export the session's cookies (login state) as serializable objects.
   * Self-hosted only; the desktop shell's embedded views use the real profile.
   */
  async flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]> {
    // The settings panel offers "allow the agent to read cookies / export login state".
    // Until now nothing read that switch, so turning it off changed nothing at all —
    // the tool exported every cookie regardless.
    if (this.settingsSource?.().credentials.allowRead === false) {
      throw new BrowserError('browser: reading cookies is switched off in settings (Browser → credentials)', 'BROWSER_AUTH_DISABLED')
    }
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    // The self-hosted carrier has a native path (the child reads its own session), which
    // is worth preferring: it reports exactly what the browser persisted.
    const native = handle
    if (typeof native.flushAuth === 'function') {
      const cookies = await withTimeout(native.flushAuth(), timeoutMs, undefined, `browser: auth export timed out after ${timeoutMs}ms`)
      this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies` })
      return cookies
    }
    // Every other carrier drives a real browser over CDP, and cookies are part of CDP —
    // the sidebar goes through the shell's webContents.debugger, an installed Chrome or
    // Edge is the browser itself. So this works everywhere rather than only self-hosted.
    // Scoped to the page this session is on. The jar itself is SHARED on purpose — every
    // window and every task drives the same browser, so signing in once works everywhere,
    // which is the whole point of "use your own browser". What must not be shared is the
    // HANDING OVER: an unfiltered read puts every domain every task has visited, plus
    // whatever the human is signed into, in front of one task's caller. Least exposure,
    // not isolation.
    //
    // Two corrections to the previous attempt. It called Storage.getCookies with a `urls`
    // parameter, but that method takes only browserContextId and ignores everything else, so
    // the filter did nothing and the whole jar was still exported; `urls` belongs to
    // Network.getCookies. And it silently fell back to an unfiltered read when the page URL
    // was unavailable — an error path that asked for MORE than the normal one. Both are
    // fixed: the method that honours the filter, and a failure that refuses instead of
    // widening.
    const cookiesUrl = await this.currentUrl(handle).catch(() => '')
    if (cookiesUrl === '') {
      throw new BrowserError(
        'browser: cannot export cookies without knowing which page this session is on — the URL was unavailable, and reading the whole cookie jar would expose every other session\'s logins',
        'BROWSER_AUTH_SCOPE_UNKNOWN',
      )
    }
    const result = await withTimeout(
      handle.sendCommand('Network.getCookies', { urls: [cookiesUrl] }),
      timeoutMs,
      undefined,
      `browser: auth export timed out after ${timeoutMs}ms`,
    )
    const cookies = toExportedCookies(result.cookies)
    this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies (CDP)` })
    return cookies
  }

  /** Import cookies into the session (restore login state). Self-hosted only. */
  async restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number> {
    // Restore WRITES cookies, so it answers to the write switch — not to
    // `credentials.allowRead`. It used to consult the read switch and report "reading
    // cookies is switched off", which is both the wrong gate and the wrong sentence: an
    // operator who allowed reading but wanted logins left alone had no switch at all,
    // and one who turned reading off lost the restore path for the wrong reason.
    this.assertActionAllowed('credentialWrite')
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    const native = handle
    if (typeof native.restoreAuth === 'function') {
      const restored = await withTimeout(native.restoreAuth(cookies), timeoutMs, undefined, `browser: auth restore timed out after ${timeoutMs}ms`)
      this.record(s, 'restoreAuth', { count: cookies.length }, true, { result: `${restored} cookies` })
      return restored
    }
    // CDP again, for the same reason as the export: any carrier that drives a real
    // browser can set cookies on it. Storage.setCookies needs the cookie fields spelled
    // the CDP way, including the sameSite spelling and seconds rather than milliseconds.
    //
    // toCdpCookie returns undefined for a cookie it cannot place (no usable domain), and
    // `cookies.map(...)` passed that undefined straight through: the array then held a
    // JSON `null`, CDP rejected the WHOLE call, and every valid cookie failed with an error
    // naming none of them. Filter the unusable ones out and say how many went.
    const mapped = cookies.map(toCdpCookie)
    const convertible = mapped.filter((cookie): cookie is Record<string, unknown> => cookie !== undefined)
    const dropped = mapped.length - convertible.length
    if (dropped > 0) {
      process.stderr.write(`[dsh-browser] restoreAuth: dropped ${dropped} of ${mapped.length} cookie(s) with no usable domain; the rest were still restored\n`)
    }
    await withTimeout(
      handle.sendCommand('Storage.setCookies', { cookies: convertible }),
      timeoutMs,
      undefined,
      `browser: auth restore timed out after ${timeoutMs}ms`,
    )
    // Storage.setCookies returns nothing, so the count comes from what was actually sent.
    // An earlier version read result.cookies here; it was always undefined and rendered as
    // "Restored 0 cookies." even though the write had succeeded.
    const restored = convertible.length
    this.record(s, 'restoreAuth', { count: cookies.length, dropped }, true, { result: `${restored} cookies (CDP)${dropped > 0 ? `; ${dropped} dropped` : ''}` })
    return restored
  }

  /**
   * Capture the active page WITHOUT presenting it.
   *
   * `screenshot` calls `showActive()` before capturing, and that is right for a tool whose point is
   * that the human sees what the model just captured. It is also what makes that path unusable for a
   * live preview: presenting on every frame would move focus, switch tabs and expand windows on the
   * host's screen — exactly the side effects a viewer must not cause (issue #34).
   *
   * So this does the capture and nothing else. Deliberately narrow: viewport only, JPEG at the
   * preview defaults, a short timeout, no save path, no history entry, no carrier recovery. A
   * preview that rebuilt a vanished carrier would make watching a way to start a browser, which the
   * design forbids: no page means "nothing to watch", not "open one".
   * @param session - the session whose active page to capture.
   * @returns the encoded image and its dimensions; throws BROWSER_PREVIEW_UNAVAILABLE when the page
   *   is not painted, which the caller turns into a "paused" state rather than an error.
   */
  async capturePassive(session: BrowserSessionId): Promise<{
    readonly dataUrl: string
    readonly width?: number
    readonly height?: number
  }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const timeoutMs = PREVIEW_CAPTURE_MS
    const timeoutMessage = `browser: preview capture timed out after ${timeoutMs}ms`
    // The self-hosted carrier encodes in the child from a NativeImage; it is the only path that can
    // produce JPEG under Electron 43, whose CDP JPEG encoder hangs.
    if (typeof handle.capture === 'function') {
      const shot = await withTimeout(
        handle.capture({
          format: 'jpeg',
          quality: PREVIEW_QUALITY,
          maxWidth: PREVIEW_MAX_WIDTH,
          maxHeight: PREVIEW_MAX_HEIGHT,
        }),
        timeoutMs,
        undefined,
        timeoutMessage,
      )
      if (shot.base64 === '') {
        // A hidden or minimized window is not a failure to report as one: the design says the
        // viewer shows pause and does not open a window to fix it.
        throw new BrowserError(
          'browser: preview unavailable (the page is not painted; the window may be hidden or minimized)',
          'BROWSER_PREVIEW_UNAVAILABLE',
        )
      }
      return {
        dataUrl: `data:${shot.mime};base64,${shot.base64}`,
        ...shot.width !== undefined && shot.height !== undefined
          ? { width: shot.width, height: shot.height }
          : {},
      }
    }
    // Real Chrome/Edge (and the sidebar): CDP. Viewport only — `captureBeyondViewport` would pull
    // the whole document, which is neither what a viewer shows nor bounded in size.
    //
    // `present: false` is load-bearing (issue #46): a preview is read-only, so it must not reach the
    // carrier's present path, which for the sidebar asks the shell to display this conversation —
    // the reported symptom was the sidebar browser panel jumping to the front when someone opened
    // the preview. A page that is not displayed now reads as "unavailable", which the route already
    // turns into the panel's paused state.
    const result = await withTimeout(
      handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, {
        format: 'jpeg',
        quality: PREVIEW_QUALITY,
        fromSurface: true,
        captureBeyondViewport: false,
      }, { present: false }),
      timeoutMs,
      undefined,
      timeoutMessage,
    ) as { data?: unknown }
    const base64 = typeof result?.data === 'string' ? result.data : ''
    if (base64 === '') {
      throw new BrowserError(
        'browser: preview unavailable (the carrier returned no image)',
        'BROWSER_PREVIEW_UNAVAILABLE',
      )
    }
    return { dataUrl: `data:image/jpeg;base64,${base64}` }
  }

  /** Capture the current page, optionally full-page, PNG or JPEG, scalable. */
  async screenshot(    session: BrowserSessionId,
    request?: BrowserScreenshotRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly dataUrl: string; readonly path?: string; readonly width?: number; readonly height?: number }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const format = request?.format ?? 'png'
    // Native capturePage path (self-hosted): CDP Page.captureScreenshot can
    // hang indefinitely on a view once another (hidden) WebContentsView exists
    // in the window; capturePage is fast for visible views and resolves
    // immediately (empty) for hidden ones. JPEG and downscaling are encoded
    // in the child from the NativeImage, so this path is the only one that
    // can produce JPEG (CDP JPEG hangs on Electron 43).
    const capturable = handle
    // A region capture must go through CDP: the native NativeImage path has no
    // clip and would present/activate the window (a quiet-mode violation).
    if (request?.clip === undefined && request?.fullPage !== true && typeof capturable.capture === 'function') {
      // Ensure the target view is the visible one before capturing — unless quiet mode is on.
      // There, presenting the view is exactly what the user asked to avoid (it restores and
      // raises the window); the host switches the visible tab inside the window and, if the
      // window has no surface to capture, falls through to CDP.
      if (!this.isQuiet()) this.showActive(s)
      const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
      const shot = await withTimeout(
        capturable.capture({
          ...format === 'jpeg' ? { format, quality: request?.quality } : {},
          ...request?.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {},
          ...request?.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {},
          quiet: this.isQuiet(),
        }),
        timeoutMs,
        signal,
        `browser: screenshot timed out after ${timeoutMs}ms`,
      )
      if (shot.base64 === '') {
        throw new BrowserError('browser: capture returned an empty image (view not painted); retry shortly', 'BROWSER_SCREENSHOT_FAILED')
      }
      return this.saveScreenshot(
        shot.base64,
        request?.savePath,
        shot.mime ?? 'image/png',
        // The child measured these after applying any downscale, and they describe the image
        // the caller receives. Without them this path — the default self-hosted one — could
        // never answer the width/height its own tool schema declares.
        shot.width !== undefined && shot.height !== undefined
          ? { width: shot.width, height: shot.height }
          : undefined,
      )
    }
    // Fallback: a handle without a native capture() (the sidebar, or an installed Chrome
    // or Edge) uses CDP; full-page needs `captureBeyondViewport`, which capturePage lacks.
    //
    // JPEG: Electron 43's CDP hangs on it, which is why the sidebar stays PNG. An
    // installed Chrome or Edge is the real browser and has no such defect, so it says so
    // through `supportsCdpJpeg` and gets the format it asked for, and the same for
    // downscaling, which CDP performs through a full-document clip.
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    const params: Record<string, unknown> = {}
    const region = request?.clip
    if (region !== undefined) {
      const valid = [region.x, region.y, region.width, region.height].every(
        value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8192,
      ) && region.width > 0 && region.height > 0
      if (!valid) throw new BrowserError('browser: screenshot region is out of range', 'BROWSER_SCREENSHOT_FAILED')
      params.clip = { x: region.x, y: region.y, width: region.width, height: region.height, scale: 1 }
      params.fromSurface = true
      params.captureBeyondViewport = false
    }
    if (region === undefined && request?.fullPage === true) {
      // `captureBeyondViewport` captures the full scrollable content; without
      // a clip this yields the full-page image (CDP default is the viewport).
      params.captureBeyondViewport = true
    }
    const supportsJpeg = (handle as { supportsCdpJpeg?: boolean }).supportsCdpJpeg === true
    if (format === 'jpeg' && supportsJpeg) {
      params.format = 'jpeg'
      // CDP range is 0-100 and defaults to 80 when omitted.
      if (request?.quality !== undefined) params.quality = request.quality
    }
    // Downscaling on this path: CDP scales through `clip.scale`, and a clip only applies
    // to the region it names, so it has to cover the whole document. The page's own size
    // is read first; when that is unavailable the capture proceeds unscaled rather than
    // failing — an image the caller can shrink itself beats no image at all.
    let rendered: { width: number; height: number } | undefined
    if (region === undefined && (request?.maxWidth !== undefined || request?.maxHeight !== undefined)) {
      const metrics = await withTimeout(
        handle.sendCommand('Page.getLayoutMetrics', {}),
        timeoutMs,
        signal,
        `browser: screenshot timed out after ${timeoutMs}ms`,
      )
      const size = layoutSize(metrics)
      if (size !== undefined) {
        const height = request.fullPage === true ? size.height : size.viewportHeight
        const byWidth = request.maxWidth !== undefined && size.width > 0 ? request.maxWidth / size.width : 1
        const byHeight = request.maxHeight !== undefined && height > 0 ? request.maxHeight / height : 1
        const scale = Math.min(1, byWidth, byHeight)
        // What the caller will actually receive. Recorded before the branch below, because the
        // size is worth reporting even when no scaling happened (scale 1).
        rendered = { width: Math.round(size.width * scale), height: Math.round(height * scale) }
        if (scale < 1) {
          params.clip = { x: 0, y: 0, width: size.width, height, scale }
          // The clip defines the captured area; captureBeyondViewport must not also apply.
          delete params.captureBeyondViewport
        }
      }
    }
    // A region capture is a read: it must never present the conversation or
    // raise a window. Every other screenshot keeps the original call shape.
    const result = await withTimeout(
      region === undefined
        ? handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params)
        : handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params, { present: false }),
      timeoutMs,
      signal,
      `browser: screenshot timed out after ${timeoutMs}ms`,
    )
    const data = result.data
    if (typeof data !== 'string') {
      throw new BrowserError('browser: screenshot returned no image data', 'BROWSER_SCREENSHOT_FAILED')
    }
    // The mime must name the format that was ACTUALLY requested (params.format), not PNG
    // unconditionally: a carrier that sets supportsCdpJpeg asks for `format: 'jpeg'`, so
    // hardcoding the PNG mime announced a JPEG body as a PNG — the data URL then carried a
    // mislabelled image, and a caller that decodes by mime wrote the wrong file.
    const mime = params.format === 'jpeg' ? 'image/jpeg' : 'image/png'
    return this.saveScreenshot(data, request?.savePath, mime, rendered)
  }

  /**
   * Build the data URL and optionally write the image to disk. The caller's
   * path goes through the SAME {@link admitSavePath} gate as a download — it
   * must be absolute, resolve inside `downloadDir`, and not be an existing
   * file — so a screenshot cannot be used to write to, or silently replace,
   * files anywhere the DSH process happens to have permission (issue #13).
   */
  private saveScreenshot(
    base64: string,
    savePath: string | undefined,
    mime: string,
    rendered?: { width: number; height: number },
  ): { dataUrl: string; path?: string; width?: number; height?: number } {
    if (savePath !== undefined) {
      // Admission failures propagate unchanged: they describe the caller's
      // path, not a disk problem.
      const target = this.admitSavePath(savePath, 'screenshot')
      try {
        writeFileNoReplace(target, Buffer.from(base64, 'base64'))
        return { dataUrl: `data:${mime};base64,${base64}`, path: target, ...rendered }
      } catch (error) {
        // Report the write problem but keep the capture usable.
        throw new BrowserError(`browser: screenshot save to "${target}" failed: ${String(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', { cause: error })
      }
    }
    return { dataUrl: `data:${mime};base64,${base64}`, ...rendered }
  }
}
