      } else if (host instanceof SystemBrowserViewHost) {
        const provider = referenceProvider!
        unregisterTakeover = registerCarrierTakeover(ctx.browser, owner => provider.takeoverTargets(owner).map(target => ({
          ...target,
          connected: () => adoptedCarrier === host && host.connectedView(target.tabId),
          unavailableReason: () => adoptedCarrier === host && host.headlessView(target.tabId)
            ? 'The selected browser is running headless and has no visible window for human takeover. Switch browser.headless to windowed or auto with a display, then retry.'
            : undefined,
        })), { exclusive: false })
      }