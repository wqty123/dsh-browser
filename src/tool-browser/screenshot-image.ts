import type { ImageBlock } from '@deepseek-ai/dsh-llm'

export const SCREENSHOT_MAX_WIDTH = 1280
export const SCREENSHOT_MAX_HEIGHT = 960
export const SCREENSHOT_MAX_BYTES = 4 * 1024 * 1024

export function screenshotDimension(value: number | undefined, limit: number): number {
  if (value === undefined) return limit
  if (!Number.isFinite(value) || value < 1) throw new Error('Screenshot dimensions must be positive finite numbers.')
  return Math.min(Math.floor(value), limit)
}

export function screenshotBytes(dataUrl: string): { data: Buffer; mediaType: 'image/png' | 'image/jpeg' } {
  if (dataUrl.length > 64 + Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4) {
    throw new Error('Screenshot exceeds the 4 MiB image limit; retry with smaller maxWidth/maxHeight.')
  }
  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl)
  if (!match) throw new Error('Screenshot must contain a PNG or JPEG base64 image.')
  const data = Buffer.from(match[2]!, 'base64')
  if (data.length === 0 || data.toString('base64') !== match[2]) throw new Error('Screenshot contains invalid base64.')
  if (data.length > SCREENSHOT_MAX_BYTES) throw new Error('Screenshot exceeds the 4 MiB image limit; retry with smaller maxWidth/maxHeight.')
  return { data, mediaType: match[1] as 'image/png' | 'image/jpeg' }
}

export async function screenshotVisionEnabled(context: unknown, execution: unknown, signal?: AbortSignal): Promise<boolean> {
  const ctx = context as { llm?: { resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{ inputModalities?: readonly string[] }> } }
  const exec = execution as { agent?: { model?: { current(): { provider: string; model: string } | undefined } } }
  signal?.throwIfAborted()
  try {
    const selection = exec.agent?.model?.current()
    if (!selection || !ctx.llm) return false
    const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model, signal)
    signal?.throwIfAborted()
    return info.inputModalities?.includes('image') === true
  } catch (error) {
    signal?.throwIfAborted()
    return false
  }
}

export async function saveScreenshotImage(context: unknown, image: ReturnType<typeof screenshotBytes>, maxWidth: number, maxHeight: number): Promise<ImageBlock['attachment']> {
  const ctx = context as { attachments?: { saveImage(input: { data: Uint8Array; mediaType: 'image/png' | 'image/jpeg' }): Promise<ImageBlock['attachment']> } }
  if (!ctx.attachments) throw new Error('Screenshot image delivery requires the host attachment service.')
  const ref = await ctx.attachments.saveImage(image)
  if (!(ref.bytes > 0 && ref.bytes <= SCREENSHOT_MAX_BYTES && ref.width > 0 && ref.width <= maxWidth && ref.height > 0 && ref.height <= maxHeight)) {
    throw new Error('Screenshot encoder exceeded the image size/dimension limits; retry with smaller maxWidth/maxHeight.')
  }
  return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height }
}
