# Vendored Pi extensions

`subagents.ts` and its `footer-events.ts` dependency come from `@vessup/pi`. The
package is currently private and unpublished, so keeping its source here makes the
Staff Review runtime reproducible without substituting an unrelated npm package.

Staff Review applies one local hardening patch: child sessions inherit only the
read-only `read`, `bash`, `grep`, `find`, and `ls` tools. This prevents review
workers from recursively invoking the parent extension's `subagent_*` tools.

Keep both files synchronized with the upstream extension and preserve that patch
until upstream supports a child-tool allowlist. They are excluded from this
repository's Biome rules so vendoring does not otherwise rewrite upstream source.
