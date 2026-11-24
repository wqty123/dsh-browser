  try {
    return await fetch(url, { ...init, dispatcher } as RequestInit)
  } finally {
    void dispatcher.close().catch(() => {})
  }