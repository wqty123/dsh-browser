import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bridgePackageError, BridgeVersionError, NativeSurfaceUnavailableError, isBridgeVersionMismatch, BRIDGE_PACKAGE_MESSAGE, BRIDGE_VERSION_MESSAGE, NATIVE_SURFACE_MESSAGE } from '../lib/bridge-compatibility.js'

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

test('outdated bridge and missing native surface codes survive serialized and thrown transports', () => {
  for (const [code, ErrorType, message] of [
    ['BROWSER_BRIDGE_OUTDATED', BridgeVersionError, BRIDGE_VERSION_MESSAGE],
    ['BROWSER_NATIVE_SURFACE_UNAVAILABLE', NativeSurfaceUnavailableError, NATIVE_SURFACE_MESSAGE],
  ]) {
    for (const field of ['code', 'name', 'message', 'error', 'reason', 'note']) {
      const error = bridgePackageError({ [field]: code, repairAction: 'reinstall' })
      assert.ok(error instanceof ErrorType)
      assert.equal(error.message, message)
    }
    assert.ok(bridgePackageError(Object.assign(new Error('bridge refused'), { code })) instanceof ErrorType)
    for (const value of ['NOT_' + code, code + '_EXTRA', code.toLowerCase()]) assert.equal(bridgePackageError(value), undefined)
  }
  assert.equal(isBridgeVersionMismatch({ code: 'BROWSER_BRIDGE_OUTDATED' }), true)
  assert.equal(isBridgeVersionMismatch({ code: 'BROWSER_NATIVE_SURFACE_UNAVAILABLE' }), false)
})
