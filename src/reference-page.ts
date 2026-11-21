export function sameReferenceDocument(left: string, right: string): boolean {
  try {
    const current = new URL(left)
    const source = new URL(right)
    current.hash = ''
    source.hash = ''
    return current.href === source.href
  } catch { return left === right }
}
