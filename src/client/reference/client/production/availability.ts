/**
 * Explicit availability states for the browser-reference delivery pipeline.
 *
 * The client talks to the plugin's `/dsh-builtin-browser/reference/*` routes on
 * the SAME ORIGIN (relative paths, never a hardcoded port). A 404 means the
 * installed plugin copy does not ship the delivery endpoints; a malformed body
 * or 5xx means delivery is temporarily unavailable; a network/abort failure
 * means the plugin host cannot be reached. None of these are a silent success:
 * each maps to a human-readable state the dock renders instead of an empty
 * (falsely "clean") card list.
 *
 * @module dsh-browser-reference/production/availability
 */
import { ReferenceHttpError, type DeliveriesResponse } from './protocol.ts'

export type DeliveryAvailability = 'ok' | 'plugin-too-old' | 'delivery-unavailable' | 'offline'

export interface AvailabilityState {
  readonly status: DeliveryAvailability
  /** One human sentence; '' when everything is fine. */
  readonly message: string
}

/** Human-readable copy for each non-ok state (Chinese, matches the host UI). */
export const AVAILABILITY_MESSAGES: Readonly<Record<DeliveryAvailability, string>> = {
  ok: '',
  'plugin-too-old': '浏览器插件需要更新到包含引用交付的版本（未找到引用交付端点）。',
  'delivery-unavailable': '引用交付暂不可用（返回数据不符合预期），稍后会自动重试。',
  offline: '无法连接浏览器插件，请确认 DSH 内置浏览器已启动。',
}

export const OK: AvailabilityState = { status: 'ok', message: '' }

/** Classify the last poll error into an explicit, user-facing state. */
export function availabilityOf(error: unknown): AvailabilityState {
  if (error === undefined || error === null) return OK
  if (error instanceof ReferenceHttpError) {
    if (error.status === 404) return { status: 'plugin-too-old', message: AVAILABILITY_MESSAGES['plugin-too-old'] }
    // status 0 is reserved for a successfully-fetched but malformed payload.
    return { status: 'delivery-unavailable', message: AVAILABILITY_MESSAGES['delivery-unavailable'] }
  }
  if (error instanceof Error && error.name === 'AbortError') {
    // A cancelled poll (dispose / session switch) is not a user-visible outage.
    return OK
  }
  return { status: 'offline', message: AVAILABILITY_MESSAGES.offline }
}

/**
 * Strict shape check for `GET /reference/deliveries`. A plugin that answers
 * 200 with an unexpected body is a real failure, not an empty delivery list.
 */
export function isDeliveriesResponse(value: unknown): value is DeliveriesResponse {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (record.ok !== true || typeof record.sequence !== 'number' || !Number.isFinite(record.sequence)) return false
  if (!Array.isArray(record.deliveries)) return false
  for (const entry of record.deliveries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return false
    const delivery = entry as Record<string, unknown>
    if (typeof delivery.intentId !== 'string' || typeof delivery.sessionId !== 'string'
      || typeof delivery.state !== 'string' || delivery.state !== 'prepared'
      && delivery.state !== 'draft-applied' && delivery.state !== 'acknowledged' && delivery.state !== 'consumed') return false
    if (typeof delivery.snapshot !== 'object' || delivery.snapshot === null) return false
    const snapshot = delivery.snapshot as Record<string, unknown>
    if (typeof snapshot.referenceId !== 'string' || !Array.isArray(snapshot.parts)) return false
    if (!Array.isArray(delivery.failures) || !Array.isArray(delivery.assetKeys)
      || !Array.isArray(delivery.requiredAssets)) return false
    if (typeof delivery.sequence !== 'number' || !Number.isFinite(delivery.sequence)) return false
  }
  return true
}
