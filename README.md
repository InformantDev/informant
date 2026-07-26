# Informant

**Local machines, reporting for CI duty.** Informant polls GitHub from behind your firewall,
claims commits through the Checks API, and runs TOML-defined jobs in disposable Docker containers or Tart VMs.

## Install

Install the standalone binary with Homebrew:

```bash
brew install informant-ci/tap/informant
brew install gh openai/tools/tart cirruslabs/cli/sshpass
gh auth login
informant setup
```

Informant requires macOS on Apple Silicon, GitHub CLI (`gh`), and Docker for container jobs or
[Tart](https://tart.run) and `sshpass` for VM jobs,
and a GitHub App installation with **Checks: read/write**, **Contents: read**, and **Pull requests:
read/write** permissions. The interactive setup command creates and installs that App with the required permissions. See the
[documentation](apps/web/content/docs/index.mdx) for configuration and usage.

## Monorepo

- `apps/informant` — the `@clack/prompts` CLI, polling server, GitHub client, and Tart runner.
- `apps/web` — Fumadocs documentation site.

## Development

```bash
bun test
bun run check
bun run typecheck
bun run docs:dev
```

## License

[Apache License 2.0](LICENSE).
