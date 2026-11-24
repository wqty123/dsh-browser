  connectedView(id: string): boolean {
    const view = this.views.get(id), target = view === undefined ? undefined : this.sessions.get(view.session)
    return view !== undefined && target !== undefined && view.client === this.client && !view.client.headless
      && !view.client.destroyedTargets.has(target) && this.connectionStatus().connected
  }

  headlessView(id: string): boolean {
    const view = this.views.get(id), target = view === undefined ? undefined : this.sessions.get(view.session)
    return view !== undefined && target !== undefined && view.client === this.client && view.client.headless
      && !view.client.destroyedTargets.has(target) && this.connectionStatus().connected
  }