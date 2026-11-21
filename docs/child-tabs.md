# Sidebar child-tab contract

No operation may create a popup or replace an opener as a substitute for a child.

`DesktopBrowserBridge.childTabs` version 1 registers a lease-scoped `onRequested`
listener. A host sends `BrowserChildTabRequest` with an absolute HTTP(S) URL and
one of these modes:

- `url-only`: no opener, named-target reuse, child handle or cross-window messaging
  is promised. `url-only-dispatched` acknowledges dispatch into the owning
  conversation's sidebar tab model, **not** guest readiness or native adoption.
- `native-opener`: requires a real native child. The current plugin returns
  `unsupported / native-child-opener-unavailable`. The host must honor this
  decision before creating anything; it must not downgrade it to `url-only`.

Invalid URLs return `invalid-child-url`; callbacks from a retired guest return
`guest-disposed`. Registration is removed with the guest lease lifetime. Hosts
without this API retain only the legacy `onOpenRequested` URL notification.
That notification cannot distinguish opener-dependent requests, so it cannot
establish native-child support on an installed host.

The opaque Web guest implements only URL-only tabs. Its channel is checked
against the owned iframe window, opaque origin, current load identity and
monotonic request identity. Ordinary blank links and GET forms use URL-only
dispatch. Explicit noopener `window.open` returns `null`; requests that need an
opener throw `NotSupportedError` with a stable `code`. Unsupported link/form
requests report the same capability failure without navigating or submitting.
Before the parent handshake, a scripted open fails with
`sidebar-tab-owner-not-ready`, rather than dropping a request or guessing an
owner. Ordinary `_self` navigation remains in the current view.

Real Desktop child support remains host-blocked. It needs an API that preserves
the engine-created child WebContents/WindowProxy, adopts that same native child
into a conversation-owned sidebar surface, and owns named-target reuse, opener
messaging, close and disposal. A URL notification or a new independently loaded
webview cannot implement that contract. Version 1 deliberately does not advertise
these capabilities. No upstream DSH files or installer hooks implement them here.
