export const PATH_NAMES = {
  chrome: {
    win32: ['chrome'],
    darwin: ['Google Chrome', 'Chromium'],
    linux: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
  },
  edge: {
    win32: ['msedge'],
    darwin: ['Microsoft Edge'],
    linux: ['microsoft-edge-stable', 'microsoft-edge', 'microsoft-edge-dev'],
  },
  brave: {
    win32: ['brave'],
    darwin: ['Brave Browser'],
    linux: ['brave-browser', 'brave'],
  },
}

export const INSTALL_LOCATIONS = {
  chrome: {
    win32: [
      String.raw`%ProgramFiles%\Google\Chrome\Application\chrome.exe`,
      String.raw`%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe`,
      // Where a per-user install lands, which is what Chrome's own installer chooses when it
      // cannot (or should not) write to Program Files. Missing this meant the plugin reported
      // "no browser found" on machines that plainly had one.
      String.raw`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`,
      String.raw`%LOCALAPPDATA%\Chromium\Application\chrome.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/opt/google/chrome/chrome',
      '/snap/bin/chromium',
    ],
  },
  edge: {
    win32: [
      String.raw`%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe`,
      String.raw`%ProgramFiles%\Microsoft\Edge\Application\msedge.exe`,
      String.raw`%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`,
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: [
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-dev',
    ],
  },
  brave: {
    win32: [
      String.raw`%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe`,
      String.raw`%ProgramFiles(x86)%\BraveSoftware\Brave-Browser\Application\brave.exe`,
      String.raw`%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe`,
    ],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
  },
}

export const NATIVE_PRODUCTS = Object.freeze({
  edge: { win32: 'Microsoft\\Edge', darwin: 'Microsoft Edge', linux: 'microsoft-edge' },
  chrome: { win32: 'Google\\Chrome', darwin: 'Google/Chrome', linux: 'google-chrome' },
})
export const PERSONAL_PROFILE_DIRS = Object.freeze({
  win32: [NATIVE_PRODUCTS.edge.win32, NATIVE_PRODUCTS.chrome.win32, 'BraveSoftware\\Brave-Browser'].map(name => name + '/User Data'),
  darwin: [NATIVE_PRODUCTS.edge.darwin, NATIVE_PRODUCTS.chrome.darwin, 'BraveSoftware/Brave-Browser'],
  linux: [NATIVE_PRODUCTS.edge.linux, NATIVE_PRODUCTS.chrome.linux, 'chromium', 'BraveSoftware/Brave-Browser'],
})

export const WINDOWS_TOOLS = Object.freeze({ powershell: 'powershell.exe', registry: 'reg.exe' })
