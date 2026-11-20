/**
 * Session-scoped durable asset bindings.
 *
 * An image part is a content hash (`assetKey`), NOT a URL and NOT alt text.
 * Before a delivery may be ACKed, every required key must have real bytes from
 * `GET /reference/asset?encoding=base64` AND a durable host attachment
 * admission (`receiptId` from the host's createDrafts/serializeAttachments).
 * Both facts are persisted per session so a restart restores the exact bytes
 * and the receipt, and the card can render a real thumbnail without the page.
 *
 * All persistence goes through an injected `KeyValueStorage`; no globals.
 *
 * @module dsh-browser-reference/production/asset-store
 */
import type { KeyValueStorage } from '../types.ts'
import { decodeBase64 } from './bytes.ts'
import type { AssetResponse } from './protocol.ts'

export const ASSET_STORE_PREFIX = 'dsh.browser-reference.assets.'

export function assetStoreKey(sessionId: string): string {
  return `${ASSET_STORE_PREFIX}${sessionId}`
}

/** One durably bound image asset. `data` is base64 of the real bytes. */
export interface AssetBinding {
  readonly key: string
  readonly mime: string
  readonly bytes: number
  readonly sha256: string
  readonly data: string
  /** Opaque receipt from the host attachment admission service, when uploaded. */
  readonly receiptId?: string
}

export interface AssetStore {
  /** Bind one asset fetched from the plugin, optionally with a host receipt. */
  bind(asset: AssetResponse, receiptId?: string): AssetBinding
  get(key: string): AssetBinding | undefined
  /** Real bytes decoded from `data`, or undefined when unbound. */
  bytesOf(key: string): Uint8Array | undefined
  hasAll(keys: readonly string[]): boolean
  missing(keys: readonly string[]): readonly string[]
  keys(): readonly string[]
  values(): readonly AssetBinding[]
  restore(): void
  dispose(): void
}

const FORMAT_VERSION = 1

interface SerializedAssets {
  readonly version: typeof FORMAT_VERSION
  readonly bindings: readonly AssetBinding[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBinding(value: unknown): value is AssetBinding {
  if (!isRecord(value)) return false
  return typeof value.key === 'string' && /^[0-9a-f]{64}$/u.test(value.key)
    && typeof value.mime === 'string'
    && typeof value.bytes === 'number' && Number.isInteger(value.bytes) && value.bytes >= 0
    && typeof value.sha256 === 'string'
    && typeof value.data === 'string'
    && (value.receiptId === undefined || typeof value.receiptId === 'string')
}

function parse(raw: string): Map<string, AssetBinding> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== FORMAT_VERSION || !Array.isArray(parsed.bindings)) return undefined
    const map = new Map<string, AssetBinding>()
    for (const entry of parsed.bindings as readonly unknown[]) {
      if (!isBinding(entry)) return undefined
      map.set(entry.key, entry)
    }
    return map
  } catch {
    return undefined
  }
}

/** Build the store for ONE DSH session; construction restores its persisted state. */
export function createAssetStore(storage: KeyValueStorage, sessionId: string): AssetStore {
  const key = assetStoreKey(sessionId)
  let bindings = new Map<string, AssetBinding>()
  let disposed = false

  const persist = (): void => {
    const snapshot: SerializedAssets = { version: FORMAT_VERSION, bindings: [...bindings.values()] }
    storage.setItem(key, JSON.stringify(snapshot))
  }

  const load = (): void => {
    const raw = storage.getItem(key)
    bindings = raw === null ? new Map() : parse(raw) ?? new Map()
  }

  load()

  return {
    bind(asset, receiptId) {
      if (disposed) throw new Error('asset store is disposed')
      if (asset.sha256 !== asset.key) {
        throw new Error(`asset sha256 ${asset.sha256} does not match key ${asset.key}`)
      }
      const binding: AssetBinding = {
        key: asset.key,
        mime: asset.mime,
        bytes: asset.bytes,
        sha256: asset.sha256,
        data: asset.data,
        ...(receiptId === undefined ? {} : { receiptId }),
      }
      const previous = bindings.get(asset.key)
      bindings.set(asset.key, binding)
      try {
        persist()
      } catch (error: unknown) {
        // Never leave an in-memory "bound" asset when the durable write failed:
        // missing() would report it as present and the delivery would be ACKed
        // over an image that turns into a placeholder after a restart.
        if (previous === undefined) bindings.delete(asset.key)
        else bindings.set(asset.key, previous)
        throw error
      }
      return binding
    },
    get(assetKey) { return bindings.get(assetKey) },
    bytesOf(assetKey) {
      const binding = bindings.get(assetKey)
      return binding === undefined ? undefined : decodeBase64(binding.data)
    },
    hasAll(keys) { return keys.every(assetKey => bindings.has(assetKey)) },
    missing(keys) { return keys.filter(assetKey => !bindings.has(assetKey)) },
    keys() { return [...bindings.keys()] },
    values() { return [...bindings.values()] },
    restore() { load() },
    dispose() { disposed = true; bindings.clear() },
  }
}
