# Changelog

All notable changes to this project are documented in this file.

## [1.0.10] - 2026-10-29

### Changed
- `/merge` accepts closed tickets as targets (zammad-kc 0.0.9 keeps the target closed). Only merged, removed and deleted tickets are refused. Default suggestions stay open-only; closed tickets appear only when searching, after the open matches, tagged `[closed]`.
- Merging into a closed ticket posts no pointer note into its archived thread, and the reply says the target stays closed.

### Fixed
- A Zammad webhook for a closed ticket that has no thread no longer creates one (it used to create the thread, post the header in the tickets channel and archive it). Closed tickets never show up in the tickets channel.

## [1.0.9] - 2026-10-29

### Added
- Every Zammad message posted to a ticket thread starts with a small line saying how it was sent and to whom:
  - Email: sender address, To, Cc (and Bcc on agent emails).
  - SMS (RingCentral, FreePBX): contact name and number of each recipient.
  - Teams: the person, our Teams account, or the group chat and its members.
  - Messages sent directly in Teams or RingCentral (captured as notes), missed calls, and internal notes ("not sent to anyone") are labelled too.
  - Zammad fills these recipients from zammad-kc 0.0.8 on; older articles fall back to the numbers stored on them.

### Fixed
- Forwarded emails lost their forwarded content in Discord. Outlook's forward header (an empty line, a rule, then bold From/Sent) was read as a quoted reply chain, so the whole forward went behind a spoiler cut at 800 characters, or was dropped entirely on later articles and the webhook fallback path. Forwards (Fw:/Fwd: subjects or a "forwarded message" banner) are now posted in full, and an `&nbsp;`-only line no longer counts as a reply.
- `/reply` on a FreePBX SMS ticket sent an email to the customer instead of a text. It now replies by SMS like RingCentral tickets.

## [1.0.8] - 2026-10-28

### Security
- `/setup` no longer lets everyone in when `ADMIN_USER_IDS` is empty. Only the listed Discord user IDs are admins; an empty list means nobody is.
- The `/debug/*` web routes had no authentication, so any pod in the cluster could read ticket titles and thread members, start a keepalive sweep or change the keepalive hour. They are now off unless `DEBUG_TOKEN` is set, and then need `Authorization: Bearer <DEBUG_TOKEN>`.
- `/search`, `/weekly` and the `/merge` ticket suggestions now need a Discord user mapped to a Zammad agent (`/setup usermap`), like the other ticket commands. Before, any member who could see the commands could search every ticket or open tickets with the bot's token.
- Dependency updates for advisories (lockfile only): undici 6.28.1 -> 6.29.1, zod 4.3.6 -> 4.6.7, fastify 5.12.5 -> 5.12.7, fast-uri 3.1.8 -> 3.1.9 and 4.2.1 -> 4.2.3.

## [1.0.7] - 2026-10-14

### Security
- sharp 0.35.4 -> 0.35.5 (bundled libvips/librsvg advisory GHSA-wq5f-xc86-pv6w); fast-copy 4.0.2 -> 4.1.0 (dev-only). Lockfile only.

## [1.0.6] - 2026-10-14

### Fixed
- A ticket deleted in Zammad is retired once (thread notice + archive, state
  `deleted`) instead of being re-fetched with a 404 every 30-second sync cycle.

## [1.0.5] - 2026-10-14

### Changed
- Every human message posted in a ticket thread is added to the Zammad ticket
  as an internal note, not only messages from mapped agents. Unmapped Discord
  users are named at the top of the note ("Discord message from <name>") and
  the article is created by the bot's API user; mapped agents still author
  the note as themselves. The webhook echo is suppressed as before, so the
  message is never posted back into Discord. Slash commands are interactions
  and are never forwarded.

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
