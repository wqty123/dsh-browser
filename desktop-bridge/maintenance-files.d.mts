export function renameMaintenanceFile(source: string, target: string, effects?: {
  rename?: (source: string, target: string) => Promise<void>
  pause?: (ms: number) => Promise<unknown>
}): Promise<void>
export function renameMaintenanceFileSync(source: string, target: string, effects?: {
  rename?: (source: string, target: string) => void
  pause?: (ms: number) => unknown
}): void
