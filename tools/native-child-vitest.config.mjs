import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const root = process.env.DSH_SOURCE_ROOT
if (!root) throw new Error('Set DSH_SOURCE_ROOT to the DSH source checkout')
const require = createRequire(resolve(root, 'package.json'))
const ts = require('typescript')
const config = ts.readConfigFile(resolve(root, 'tsconfig.base.json'), ts.sys.readFile)
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
const alias = Object.entries(config.config.compilerOptions.paths).map(([name, paths]) => ({
  find: new RegExp('^' + name.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace('*', '(.*)') + '$'),
  replacement: resolve(root, paths[0]).replace('*', '$1'),
}))
const clientRequire = createRequire(resolve(root, 'packages/client/ui-sidebar-right/package.json'))
for (const name of ['react', 'react-dom', 'zod']) {
  alias.push({ find: name, replacement: dirname(clientRequire.resolve(`${name}/package.json`)) })
}

export default {
  resolve: { alias },
  test: { environment: 'jsdom', include: [
    'src/client/browser/__tests__/child-tabs.spec.ts',
    'src/client/browser/__tests__/controller-lifetime.spec.ts',
    'src/client/browser/__tests__/packaged-native-open.spec.ts',
  ] },
}
