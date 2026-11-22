# Release bundle fixtures

The `.js.gz` files contain complete, losslessly compressed source-build bundles
for rc.3 (this directory) and rc.5 (`rc5/`). Keeping generated bundles compressed
avoids overwhelming source review with generated JavaScript. Tests decompress
them in memory; all runtime-patch, migration, rollback and exact-restore assertions
still compare the complete bundles.

`manifest.json` records each uncompressed file's byte length and SHA-256. The
fixture-integrity test checks every entry. To inspect a bundle, use `gzip -dc
main.before.js.gz`, or Node's `zlib.gunzipSync`.

These fixtures are test-only and are not published. The independent
`tools/check-host-patch-source.mjs` comparator checks runtime output against actual
release source builds, not these fixtures.
