// What the screenshot path reads when it needs the page's size (issue #140).
//
// The reported bug was a screenshot at 189×960 while the page itself reported 1029×768. That can
// only be the capture surface, not this conversion — so the conversion is pinned here: CSS pixels,
// document width from the content box, viewport height from the layout viewport, and never a
// guessed value when the page did not report one.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layoutSize } from '../src/browser-electron/provider-core.ts'

test('the layout size prefers CSS boxes and takes the viewport height from the layout viewport', () => {
  assert.deepEqual(layoutSize({
    cssContentSize: { width: 1029, height: 3200 },
    cssLayoutViewport: { width: 1029, height: 768 },
    contentSize: { width: 1, height: 1 },
    layoutViewport: { width: 1, height: 1 },
  }), { width: 1029, height: 3200, viewportHeight: 768 })
})

test('the device-pixel boxes are never used when the CSS ones are present', () => {
  const size = layoutSize({
    cssContentSize: { width: 1029, height: 3200 },
    cssLayoutViewport: { width: 1029, height: 768 },
    contentSize: { width: 2058, height: 6400 },
    layoutViewport: { width: 2058, height: 1536 },
  })
  assert.equal(size.width, 1029)
  assert.equal(size.viewportHeight, 768)
})

test('a missing viewport falls back to the document height, and a missing document is unknown', () => {
  assert.deepEqual(layoutSize({ cssContentSize: { width: 800, height: 600 } }), { width: 800, height: 600, viewportHeight: 600 })
  assert.equal(layoutSize({}), undefined)
  assert.equal(layoutSize({ cssLayoutViewport: { width: 800, height: 600 } }), undefined, 'width comes from the document, not the viewport')
})
