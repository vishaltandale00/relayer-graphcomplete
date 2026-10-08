# SheetJS Community Edition

`xlsx-0.20.3-sha256-….tgz` is SheetJS 0.20.3 (Apache-2.0), downloaded unchanged from
`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`. SheetJS no longer publishes to npm, and
the npm copy (0.18.5) has known vulnerabilities, so the tarball is committed here and
`package-lock.json` pins its sha512 integrity. It is a build-time dependency of the artifact
viewer's Office bundle (`scripts/prepare-renderer-vendor.mjs`, PRD 6.6.9).
