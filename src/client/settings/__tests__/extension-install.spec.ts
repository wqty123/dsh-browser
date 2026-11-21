import { describe, expect, it } from 'vitest'
import { extensionInstallCommand } from '../panel.ts'

describe('extension install helper', () => {
  it('quotes Windows paths for PowerShell without putting a token in settings', () => {
    const command = extensionInstallCommand({ platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', installer: "D:\\User's files\\native-host\\install.mjs", directory: 'D:\\dsh-home\\extension\\edge' }, 'edge')
    expect(command).toBe("& 'C:\\Program Files\\nodejs\\node.exe' 'D:\\User''s files\\native-host\\install.mjs' --browser edge --extension-id EXTENSION_ID --directory 'D:\\dsh-home\\extension\\edge' --label 'My edge profile'")
    expect(command).not.toContain('--token')
  })

  it('quotes POSIX paths without invoking a shell or installing from the UI', () => {
    expect(extensionInstallCommand({ platform: 'linux', node: '/usr/bin/node', installer: "/home/user's app/install.mjs", directory: '/home/user/.dsh/extension/chrome' }, 'chrome'))
      .toContain("'/home/user'\\''s app/install.mjs' --browser chrome --extension-id EXTENSION_ID")
  })
})
