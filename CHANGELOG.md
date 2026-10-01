# Changelog

All notable changes to this project are documented in this file.

## [1.0.4] - 2026-10-01

### Fixed
- Notes missing from ticket threads. The Zammad -> Discord sync skipped every
  System-sender article, which dropped the internal "Call activity" notes the
  Zammad-KC RingCentral integration adds (and monitoring notes such as "API
  health check failure detected"). Every note is now posted, internal or
  public, agent or System; System notes are labelled "System (<subject>)".
  Only System-sender articles that are not notes (trigger auto-replies) are
  still skipped.
- Inline images not reaching Discord:
  - The Outlook quoted-header pattern in the email splitter skipped over
    `<img>` tags, so a screenshot placed just above the `<hr>` + "From:/Sent:"
    block was cut into the quoted context and never extracted. Same fix in
    the quote stripper.
  - Only the reply part was searched for images, so a screenshot in the
    quoted or forwarded part (e.g. from an email that never reached the
    ticket) was never posted. Images are now taken from the whole body,
    reply first, and de-duplicated per ticket by content hash (new table
    `posted_media`), so quoted copies of images already in the thread are
    not posted again.
  - Inline images were handled for emails only; notes and other article
    types are covered now.
  - `cid:` references (webhook payloads) and `data:` URIs are handled, with
    lenient base64 decoding (wrapped lines, percent-encoding, URL-safe
    alphabet, missing padding); undecodable ones are skipped.
  - Inline images keep their Zammad filename (from Content-Disposition).
  - HEIC/HEIF images are converted to JPEG when sharp can decode them.
- Webhooks with an empty `article` object no longer log a false
  "ticket_id mismatch" warning.

### Added
- `/md`: exports the ticket of the current thread to `ticket-<number>.md`
  (header with number, title, state, priority, group, owner, customer,
  organization, created/updated, tags; every article in order with time,
  from/to/cc, type, sender, internal flag, body converted from HTML to
  Markdown, attachment links). The file is posted in the thread, split into
  parts if it exceeds Discord's upload limit, and added to the Zammad ticket
  as an internal note attachment. Articles missing from the by-ticket list
  are fetched individually.
- `/remind-me <when> [message]`: pings the user in the same channel or
  thread with the message and a link back. Reminders are stored in SQLite
  (new table `reminders` in `data/bot.db`), survive restarts, are delivered
  late (and marked so) if they fell due while the bot was down, and fall back
  to a DM if the channel is gone. Past times, times under 30 seconds away and
  times more than 366 days ahead are rejected.
- `/reminders [cancel]`: list or cancel your pending reminders.
- Tests for note filtering, inline-image extraction and collection, the time
  parser, the Markdown export and reminders (53 tests in total).

### Changed
- Time parsing (shared by `/schedule` and `/remind-me`): dates and date-times
  without an offset (`2026-10-05`, `2026-10-05 14:00`) are read in the bot
  timezone instead of the container's; added combined durations (`1h30m`),
  months (`2mo`), `in 2h`, weekdays (`friday 3pm`) and bare times (`17:30`).
- New runtime dependency: turndown (HTML to Markdown for `/md`).
- Version 1.0.3 -> 1.0.4.

## [1.0.3] - 2026-09-25

CI only; no application changes.

### Changed
- CI: pipelines run on merge requests (tests/builds only, nothing published).
  Through the shared `dean/ci-templates` workflow rules, a merge request (e.g. a Renovate MR) now gets a pipeline that runs the tests and builds the image(s), but it never publishes anything: no registry push, no GHCR mirror, no release.
  Plain pushes still start no pipeline; tags and manual runs behave as before.
- Docs: README and `.gitlab-ci.yml` comments describe the merge-request pipelines.
- Version 1.0.2 -> 1.0.3 in `package.json`, `package-lock.json`.

## [1.0.2] - 2026-09-24

### Added
- GitLab CI check job in the test stage (`ci/check.sh`). It runs on
  `node:24-alpine`, the image the Dockerfile uses, and gates the image build:
  - fails if the job's Node major differs from the Dockerfile's `FROM node:<N>`;
  - on a `v*` tag or `RELEASE_VERSION` run, fails unless `package.json` and
    `package-lock.json` carry that version;
  - `npm ci`, a load check of `better-sqlite3` and `sharp`, `npm run typecheck`,
    `npm run build`, and `npm test` (webhook signature and image conversion tests).
- README section "Building / Releases (GitLab CI)".

### Changed
- Version bumped to 1.0.2 in package.json and package-lock.json. There are no
  application behavior changes.

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
