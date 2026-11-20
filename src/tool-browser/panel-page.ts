/**
 * Panel-surface page reader.
 *
 * The Web sidebar renders pages through the plugin's own same-origin proxy, so there is no CDP
 * target behind it. `dsh_browser_open` on the panel surface therefore only hands the address to the
 * sidebar, and every read tool afterwards answered "nothing is open in this task yet" — the model
 * could open a page but never look at it.
 *
 * This module gives those tools something real to read: it fetches the proxied document from
 * loopback (the proxy route is same-origin and loopback-authorized) and parses the parts a snapshot
 * needs — title, text, and the interactive nodes with their labels. It cannot run page script, so
 * actions that need JS still belong to the `builtin` surface; reads do not.
 *
 * @module dsh-builtin-browser/tool-browser/panel-page
 */

/** One interactive node found in the proxied document. */
export interface PanelElement {
  readonly index: number
  /** `link` | `button` | `input` | `select` | `textarea` */
  readonly kind: string
  /** Accessible-ish name: text content, aria-label, placeholder or value. */
  readonly name: string
  /** Destination for links, or the control's type. */
  readonly detail?: string
}

/** What a panel read returns. */
export interface PanelPage {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly elements: readonly PanelElement[]
  readonly truncated: boolean
}

/** Decode the handful of entities that matter for labels. */
function decodeEntities(raw: string): string {
  return raw
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Number(code)))
}

/** Strip tags and collapse whitespace. */
function plain(raw: string): string {
  return decodeEntities(raw.replace(/<[^>]*>/gu, ' ')).replace(/\s+/gu, ' ').trim()
}

/**
 * Read one attribute out of a tag's source text.
 * @param tag - the tag source (e.g. `<a href="x" aria-label="y">`).
 * @param name - attribute name.
 * @returns the attribute value, or undefined.
 */
function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(tag)
  if (match === null) return undefined
  const value = match[2] ?? match[3] ?? match[4] ?? ''
  return decodeEntities(value).trim()
}

/**
 * Fetch the proxied document for an address and parse it.
 * @param pageUrl - the real page address (what the sidebar is showing).
 * @param origin - this host's origin, used to reach the proxy.
 * @param options - optional element cap.
 * @returns the parsed page.
 */
export async function readPanelPage(
  pageUrl: string,
  origin: string,
  options: { readonly limit?: number; readonly signal?: AbortSignal } = {},
): Promise<PanelPage> {
  const limit = options.limit ?? 120
  const proxied = `${origin}/dsh-builtin-browser/browser-view/guest?u=${encodeURIComponent(pageUrl)}`
  const response = await fetch(proxied, {
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
  const html = await response.text()
  if (!response.ok) {
    throw new Error(`panel read failed: HTTP ${response.status} for ${pageUrl}`)
  }

  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)
  const title = titleMatch === null ? '' : plain(titleMatch[1] ?? '')
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
  const text = plain(withoutScripts).slice(0, 4000)

  const elements: PanelElement[] = []
  const pattern = /<(a|button|input|select|textarea)\b([^>]*)>/giu
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null && elements.length < limit) {
    const tagName = (match[1] ?? '').toLowerCase()
    const tag = match[0]
    if (tagName === 'a') {
      const href = attribute(tag, 'href')
      const label = attribute(tag, 'aria-label') ?? ''
      if (href === undefined || href.startsWith('javascript:')) continue
      elements.push({ index: elements.length + 1, kind: 'link', name: label === '' ? href : label, detail: href })
      continue
    }
    if (tagName === 'button') {
      const label = attribute(tag, 'aria-label') ?? attribute(tag, 'title') ?? ''
      elements.push({ index: elements.length + 1, kind: 'button', name: label === '' ? '(button)' : label })
      continue
    }
    const type = attribute(tag, 'type') ?? tagName
    const label = attribute(tag, 'aria-label') ?? attribute(tag, 'placeholder') ?? attribute(tag, 'name') ?? ''
    elements.push({ index: elements.length + 1, kind: tagName, name: label === '' ? `(${tagName})` : label, detail: type })
  }

  return { url: pageUrl, title, text, elements, truncated: elements.length >= limit || text.length >= 4000 }
}
