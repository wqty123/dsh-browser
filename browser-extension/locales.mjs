export const en = {
  title: 'DSH Browser Bridge status',
  heading: 'DSH Browser Bridge',
  consent: 'This explicitly grants DSH control of tabs in this browser profile. Browser debugging warnings remain visible. No extension popup or automatic window activation is used.',
  automatic: 'DSH registers the native host automatically. This extension connects automatically; no token or configuration is needed.',
  disconnect: 'Disconnect',
  pause: 'Disconnect leaves all tabs open and pauses reconnects. Remove and add the extension again to resume. The native-host --revoke command disables access persistently, including across plugin restarts.',
  quiet: 'Quiet-mode limits: the normal debugger infobar cannot be hidden; browser/OS permission prompts, website-initiated downloads and page-created windows cannot be guaranteed invisible. File choosers are intercepted on attached tabs. Never use this mode when absolutely no browser-owned UI is acceptable.',
  identity: 'Extension ID: {id}',
  accepted: 'Request accepted. Refreshing connection status…',
  unavailable: 'Extension worker unavailable.',
  disconnected: 'Native host is disconnected.',
  reconnect: 'Native host disconnected or is not installed. Reconnect after installing.',
}
