  const composedParent = (node) => node.parentElement || (node.parentNode && node.parentNode.host) || (node.ownerDocument && node.ownerDocument.defaultView && node.ownerDocument.defaultView.frameElement) || null
  const deepHit = (x, y) => {
    let cx = x, cy = y
    let node = document.elementFromPoint(cx, cy)
    for (let i = 0; node && i < 16; i += 1) {
      if (node.shadowRoot && node.shadowRoot.elementFromPoint) {
        const inner = node.shadowRoot.elementFromPoint(cx, cy)
        if (!inner || inner === node) break
        node = inner
        continue
      }
      if (node.tagName === 'IFRAME') {
        let frameDoc = null
        try { frameDoc = node.contentDocument } catch (error) { frameDoc = null }
        if (!frameDoc || typeof frameDoc.elementFromPoint !== 'function') break
        const rect = node.getBoundingClientRect()
        cx -= rect.left
        cy -= rect.top
        const inner = frameDoc.elementFromPoint(cx, cy)
        if (!inner || inner === node) break
        node = inner
        continue
      }
      break
    }
    return node
  }