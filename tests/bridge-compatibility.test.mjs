import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridgePackageError, BridgeVersionError, BRIDGE_PACKAGE_MESSAGE, BRIDGE_VERSION_MESSAGE } from '../lib/bridge-compatibility.js'

test('loader package failures retain one named compatibility error across serialized and thrown forms', () => {
  for (const field of ['code', 'name', 'message', 'error', 'reason', 'note']) {
    const error = bridgePackageError({ [field]: 'DSH_BRIDGE_PACKAGE_UNAVAILABLE' })
    assert.ok(error instanceof BridgeVersionError)
    assert.equal(error.name, 'BridgeVersionError')
    assert.equal(error.code, 'BROWSER_BRIDGE_VERSION_MISMATCH')
    assert.equal(error.message, BRIDGE_PACKAGE_MESSAGE)
  }
  assert.equal(bridgePackageError(new Error('DSH_BRIDGE_PACKAGE_UNAVAILABLE: missing package')).message, BRIDGE_PACKAGE_MESSAGE)
  assert.equal(new BridgeVersionError().message, BRIDGE_VERSION_MESSAGE)
})

test('empty, unrelated and lookalike errors do not become missing-package errors', () => {
  for (const value of [undefined, null, '', {}, { code: 'ECONNREFUSED' }, { error: 'sidebar unavailable' },
    { code: 'NOT_DSH_BRIDGE_PACKAGE_UNAVAILABLE' }, { code: 'DSH_BRIDGE_PACKAGE_UNAVAILABLE_EXTRA' }]) {
    assert.equal(bridgePackageError(value), undefined)
  }
})
