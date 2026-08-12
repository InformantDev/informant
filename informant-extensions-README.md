# Vendored Pi extensions

`subagents.ts` and its `footer-events.ts` dependency come from `@vessup/pi-kit`.
The package is currently private and unpublished, so keeping its source here makes
the Staff Review runtime reproducible without substituting another package.

Staff Review applies two local hardening patches: child sessions inherit only the
read-only `read`, `grep`, `find`, and `ls` tools, and they do not discover project
context files. This prevents review workers from executing shell commands,
recursively invoking the parent extension's `subagent_*` tools, or obeying
PR-controlled `AGENTS.md` files.

The container build copies these files into the prepared image, and the job loads
only that trusted image path. Keep both files synchronized with the upstream
extension and preserve the patches until upstream supports equivalent child
options. They are excluded from this repository's Biome rules so vendoring does
not otherwise rewrite upstream source.
