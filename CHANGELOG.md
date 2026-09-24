# Changelog

All notable changes to this project are documented in this file.

## [1.0.1] - 2026-09-24

Changes since the last pre-release baseline (commit 38c34db, version 1.0.0).

### Security
- Updated fastify 5.7.4 -> 5.12.5 (fixes content-type validation bypass, schema validation bypass and X-Forwarded-* header spoofing on the webhook server).
- Updated undici 6.24.1 -> 6.28.1, @discordjs/rest 2.6.1 -> 2.6.3 and discord.js 14.26.3 -> 14.27.0 (fixes header/CRLF injection and response desync).
- Updated ws 8.19.0 -> 8.21.3 (fixes memory disclosure and denial of service).
- Updated transitive packages fast-uri, find-my-way, ajv and lodash to patched versions, plus dev-only brace-expansion, minimatch, js-yaml, flatted and @humanfs/node.
- Upgraded sharp from 0.34.5 to 0.35.4 to pick up patched libvips/libheif (CVE-2026-33327, CVE-2026-33328, CVE-2026-35590, CVE-2026-35591, and a libheif advisory); sharp processes user-supplied attachments. `npm audit` now reports 0 vulnerabilities.

### Added
- `npm test` script (node:test via tsx, no new packages) with tests in `test/`:
  - Zammad webhook HMAC-SHA1 signature check (missing, wrong secret, wrong body, truncated, prefixed and bare signatures).
  - Attachment image conversion to PNG (webp, jpeg, gif, tiff, avif; corrupt input; unsupported targets; BMP returns null).
  - Status-board-style SVG text rendering through sharp.
  Tests are outside `src/`, so they are not built into `dist/` or the Docker image.

### Changed
- Version bumped to 1.0.1 in package.json and package-lock.json.
