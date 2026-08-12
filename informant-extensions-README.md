# Vendored Pi extensions

`subagents.ts` and its `footer-events.ts` dependency come from `@vessup/pi-kit`.
The package is currently private and unpublished, so keeping its source here makes
the Staff Review runtime reproducible without substituting another package.

Staff Review applies local hardening patches: parent and child file tools are
bounded to the review workspace (plus image-baked review skills), child sessions
inherit no shell or delegation tools, child settings are in-memory, project
context discovery is disabled, and completed protocol output is retrievable
without the ordinary activity-view truncation.

The protected job snapshots these sources and its review skills from the trusted
configuration revision, bakes them into the prepared image, and loads only that
image path. Keep the files synchronized with the upstream extension and preserve
the patches until upstream supports equivalent child options. They are excluded
from this repository's Biome rules so vendoring does not otherwise rewrite
upstream source.
