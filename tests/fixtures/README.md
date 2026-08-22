# Backfill parity fixtures

`backfill-merged-49c70c3.json.gz` is the minified JSON output produced by the
legacy `backfill-loader.js` at commit
`49c70c3f00fa77aec9d52b9dc1adecc24c29b161`.

The legacy loader was executed once in the shared VM harness against the PR
base snapshot:

- `data.json` blob: `23ebab3b728b0be7982501e3cbd17ae86b872dce`
- backfill manifest blob: `dc5568431e06954ced6f56b3988c23085a622a5a`
- legacy loader blob: `f1c842e4f7080d8a666b67ecbdc3e16e1148c63b`
- uncompressed JSON SHA-256: `8a6726e27905807adc5f3ca8a9551f1b2f4a4d95d8beb46991b1b0f3ab9f345e`

The fixture is compressed only to keep the repository diff small. Tests unzip
and parse it before using `deepStrictEqual`; it is not a runtime data source.
Regenerate it from the pinned legacy loader only when an intentional parity
baseline change is reviewed.
