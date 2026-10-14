# Changelog

## [1.0.5] - 2026-10-14

### Changed
- Every human message posted in a ticket thread is added to the Zammad ticket
  as an internal note, not only messages from mapped agents. Unmapped Discord
  users are named at the top of the note ("Discord message from <name>") and
  the article is created by the bot's API user; mapped agents still author
  the note as themselves. The webhook echo is suppressed as before, so the
  message is never posted back into Discord. Slash commands are interactions
  and are never forwarded.

