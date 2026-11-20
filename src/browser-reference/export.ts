/**
 * Reference-library export encoders: JSONL records, readable Markdown, and a
 * stored ZIP carrying the actual image bytes.
 *
 * Nothing here reads a page or a browser. The service hands over immutable
 * records and already-validated asset bytes, so an export cannot claim content
 * the store does not hold. A reference is written as one JSON object per line;
 * the ZIP adds a manifest that binds each `assetKey` to its file, MIME type and
 * source address so a receiver can rebuild the ordered parts.
 * @module dsh-browser/browser-reference/export
 */

import type {
  BrowserReference,
  BrowserReferencePart,
  ImageReferencePart,
  TableReferencePart,
} from './types.ts'

/** Output shapes the local library can produce without a conversation host. */
export type ReferenceExportFormat = 'jsonl' | 'markdown' | 'zip' | 'markdown-zip'

/** One validated asset ready to be written. */
export interface ExportAsset {
  readonly assetKey: string
  readonly mime: string
  readonly bytes: Buffer
  readonly sourceUrl?: string
}

/** Everything one export needs. */
export interface ReferenceExportInput {
  readonly references: readonly BrowserReference[]
  readonly assets: readonly ExportAsset[]
  readonly exportedAt: string
}

/** One file in the resource package. */
export interface ZipEntry {
  readonly name: string
  readonly data: Buffer | string
}

const MIME_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
}

/** @returns one file name for an asset, keeping the extension derived from validated bytes. */
export function assetFileName(assetKey: string, mime: string): string {
  return `${assetKey}.${MIME_EXTENSIONS[mime.toLowerCase()] ?? 'bin'}`
}

/**
 * Unique asset keys used by these references, in first-use order.
 * @param references - stored records.
 * @returns keys from image parts and table-cell images.
 */
export function collectAssetKeys(references: readonly BrowserReference[]): string[] {
  const seen = new Set<string>()
  for (const reference of references) {
    for (const part of reference.parts) {
      if (part.type === 'image') seen.add(part.assetKey)
      else if (part.type === 'table') {
        for (const cell of part.table.cells) {
          for (const run of cell.inlineContent ?? []) {
            if (run.type === 'image') seen.add(run.assetKey)
          }
        }
      }
    }
  }
  return [...seen]
}

/** @returns one JSON object per line, oldest first. Binary assets stay in their files. */
export function referencesJsonl(references: readonly BrowserReference[]): string {
  return references.map(reference => JSON.stringify(reference)).join('\n') + (references.length === 0 ? '' : '\n')
}

/**
 * Render a readable export. Resource packages link images by relative path;
 * a single file names the source address instead of embedding remote images.
 */
export function referencesMarkdown(input: ReferenceExportInput, resources: boolean): string {
  const files = new Map(input.assets.map(asset => [asset.assetKey, asset]))
  const sections: string[] = ['# Browser references', '']
  for (const reference of input.references) {
    sections.push(`## ${singleLine(reference.source.title) || reference.source.pageUrl || reference.referenceId}`)
    sections.push('')
    sections.push(`- Reference: \`dsh-browser-ref:${reference.referenceId}\``)
    if (reference.source.pageUrl !== '') sections.push(`- Source: ${reference.source.pageUrl}`)
    sections.push(`- Captured: ${reference.source.capturedAt}`)
    sections.push(`- Carrier: ${reference.source.carrier}`)
    sections.push('')
    let counter = 0
    for (const part of reference.parts) {
      counter += 1
      sections.push(...partMarkdown(part, counter, files, resources))
      sections.push('')
    }
  }
  return sections.join('\n').replace(/\n{3,}/gu, '\n\n')
}

/**
 * Build the resource package.
 * @returns ZIP bytes plus the manifest that names each asset.
 */
export function referenceZip(input: ReferenceExportInput): Buffer {
  const fileNames = new Map(input.assets.map(asset => [asset.assetKey, assetFileName(asset.assetKey, asset.mime)]))
  const manifest = {
    kind: 'dsh-browser-reference-export',
    version: 1,
    exportedAt: input.exportedAt,
    references: input.references.map(reference => ({
      referenceId: reference.referenceId,
      manifestHash: reference.manifestHash,
      pageUrl: reference.source.pageUrl,
      title: reference.source.title,
      capturedAt: reference.source.capturedAt,
      owner: reference.owner,
      assets: collectAssetKeys([reference]).flatMap(key => {
        const asset = input.assets.find(candidate => candidate.assetKey === key)
        return asset === undefined ? [] : [{
          assetKey: key,
          file: `assets/${fileNames.get(key) ?? assetFileName(key, asset.mime)}`,
          mime: asset.mime,
          bytes: asset.bytes.length,
          ...asset.sourceUrl === undefined ? {} : { sourceUrl: asset.sourceUrl },
        }]
      }),
    })),
    assets: input.assets.map(asset => ({
      assetKey: asset.assetKey,
      file: `assets/${fileNames.get(asset.assetKey) ?? assetFileName(asset.assetKey, asset.mime)}`,
      mime: asset.mime,
      bytes: asset.bytes.length,
      ...asset.sourceUrl === undefined ? {} : { sourceUrl: asset.sourceUrl },
    })),
  }
  const entries: ZipEntry[] = [
    { name: 'references.jsonl', data: referencesJsonl(input.references) },
    { name: 'manifest.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: 'references.md', data: referencesMarkdown(input, true) },
  ]
  for (const asset of input.assets) {
    entries.push({ name: `assets/${fileNames.get(asset.assetKey)!}`, data: asset.bytes })
  }
  return createZip(entries)
}

/**
 * Encode an export in the requested shape.
 * @returns a file name, content type, and body.
 */
export function encodeReferenceExport(input: ReferenceExportInput, format: ReferenceExportFormat):
  { readonly fileName: string; readonly mime: string; readonly body: Buffer } {
  const stamp = input.exportedAt.replace(/[:.]/gu, '-')
  if (format === 'jsonl') {
    return { fileName: `browser-references-${stamp}.jsonl`, mime: 'application/x-ndjson; charset=utf-8',
      body: Buffer.from(referencesJsonl(input.references), 'utf8') }
  }
  if (format === 'markdown') {
    return { fileName: `browser-references-${stamp}.md`, mime: 'text/markdown; charset=utf-8',
      body: Buffer.from(referencesMarkdown(input, false), 'utf8') }
  }
  if (format === 'markdown-zip') {
    const zip = createZip([
      { name: 'references.md', data: referencesMarkdown(input, true) },
      { name: 'references.jsonl', data: referencesJsonl(input.references) },
      ...input.assets.map(asset => ({ name: `assets/${assetFileName(asset.assetKey, asset.mime)}`, data: asset.bytes })),
    ])
    return { fileName: `browser-references-${stamp}-markdown.zip`, mime: 'application/zip', body: zip }
  }
  return { fileName: `browser-references-${stamp}.zip`, mime: 'application/zip', body: referenceZip(input) }
}

function partMarkdown(part: BrowserReferencePart, index: number, files: ReadonlyMap<string, ExportAsset>,
  resources: boolean): string[] {
  if (part.type === 'text') {
    return [`### Part ${String(index)} · text`, '', quote(part.text)]
  }
  if (part.type === 'image') return imageMarkdown(part, index, files, resources)
  return tableMarkdown(part, index)
}

function imageMarkdown(part: ImageReferencePart, index: number, files: ReadonlyMap<string, ExportAsset>,
  resources: boolean): string[] {
  const asset = files.get(part.assetKey)
  const alt = singleLine(part.alt ?? '') || singleLine(part.caption ?? '') || 'Image'
  const source = part.anchor.currentSrc ?? part.anchor.src ?? asset?.sourceUrl
  if (resources && asset !== undefined) {
    const lines = [`### Part ${String(index)} · image`, '', `![${escapeMarkdown(alt)}](assets/${assetFileName(asset.assetKey, asset.mime)})`]
    if (source !== undefined && source !== '') lines.push('', `<${source}>`)
    return lines
  }
  const lines = [`### Part ${String(index)} · image`, '', `Image: ${alt}`]
  if (source !== undefined && source !== '') lines.push('', `Source: <${source}>`)
  return lines
}

function tableMarkdown(part: TableReferencePart, index: number): string[] {
  const { table } = part
  const rows = Math.min(Math.max(table.rowCount, 0), 1000)
  const columns = Math.min(Math.max(table.columnCount, 0), 200)
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''))
  const merges: string[] = []
  for (const cell of table.cells) {
    if (cell.row >= rows || cell.column >= columns) continue
    grid[cell.row]![cell.column] = singleLine(cell.text)
    if (cell.rowSpan > 1 || cell.columnSpan > 1) {
      merges.push(`(${String(cell.row + 1)},${String(cell.column + 1)}) spans ${String(cell.rowSpan)}×${String(cell.columnSpan)}`)
    }
  }
  const lines = [`### Part ${String(index)} · table`, '']
  if (table.caption !== undefined && table.caption !== '') lines.push(`Caption: ${singleLine(table.caption)}`, '')
  if (rows > 0 && columns > 0) {
    lines.push(`| ${grid[0]!.map(escapeCell).join(' | ')} |`)
    lines.push(`| ${Array.from({ length: columns }, () => '---').join(' | ')} |`)
    for (let row = 1; row < rows; row += 1) {
      lines.push(`| ${grid[row]!.map(escapeCell).join(' | ')} |`)
    }
  }
  lines.push('')
  lines.push(`Completeness: ${table.completeness}; rows ${String(rows)}; columns ${String(columns)}`)
  if (merges.length > 0) lines.push('', ...merges.map(note => `- ${note}`))
  return lines
}

function quote(text: string): string {
  return text.split(/\r?\n/u).map(line => `> ${line}`).join('\n')
}

function escapeMarkdown(text: string): string {
  return text.replace(/[[\]\\]/gu, match => `\\${match}`)
}

function escapeCell(text: string): string {
  return text.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ')
}

function singleLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) === 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1
    table[index] = value >>> 0
  }
  return table
})()

export function crc32(data: Buffer): number {
  let crc = 0xFFFFFFFF
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xFF]! ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosTimestamp(date: Date): { readonly time: number; readonly date: number } {
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/**
 * Write a ZIP using the stored method. The export has no server-side
 * compressor dependency, and PNG bytes do not compress further anyway.
 * @param entries - names and already-validated bytes.
 * @returns ZIP bytes.
 */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const stamp = dosTimestamp(new Date())
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    if (data.length > 0xFFFFFFFF) throw new Error('zip entry exceeds the 4 GiB stored limit')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034B50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014B50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += local.length + name.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054B50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuffer, end])
}
