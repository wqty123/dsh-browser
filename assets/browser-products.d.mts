export const PATH_NAMES: Record<'chrome' | 'edge' | 'brave', Partial<Record<NodeJS.Platform, string[]>>>
export const INSTALL_LOCATIONS: typeof PATH_NAMES
export const NATIVE_PRODUCTS: Record<'edge' | 'chrome', Record<'win32' | 'darwin' | 'linux', string>>
export const PERSONAL_PROFILE_DIRS: Record<'win32' | 'darwin' | 'linux', string[]>

export const WINDOWS_TOOLS: Readonly<{ powershell: string; registry: string }>
