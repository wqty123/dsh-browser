export const referenceCaptureErrors: Readonly<Record<'captureFailed' | 'storeRefused' | 'imageFailed' | 'imageUnreadable', string>>
export const extensionMessages: Record<'en' | 'zh', { notConnected: string; connected: string; loadHint: string; storeHint: string }>

export const hostMessages: { zh: { referenceLabel: string; referenceFailed: string; dismiss: string }; bilingual: { unavailableTitle: string; unavailableDetail: string; retry: string } }
export const referenceCaptureMessages: Readonly<Record<string, string>>
