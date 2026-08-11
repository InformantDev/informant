# Informant

**Local machines, reporting for CI duty.** Informant polls GitHub from behind your firewall,
claims commits through the Checks API, and runs TOML-defined jobs in disposable native checkouts,
Apple containers, or Tart VMs.
Each job can select and prepare its own runtime image, keeping macOS VMs limited to jobs that need them.

## Install

Install the standalone binary with Homebrew:

```bash
brew install informantdev/tap/informant
brew install gh
gh auth login
informant setup
```

Informant requires GitHub CLI (`gh`) and a GitHub App installation with **Checks: read/write**,
**Contents: read**, and **Pull requests: read/write** permissions. Native host jobs run on Linux or
macOS. Apple Silicon workers can additionally use
[Apple Container](https://github.com/apple/container) for container jobs or
[Tart](https://tart.run) and `sshpass` for VM jobs. On Apple Silicon, the interactive setup command
installs and verifies Apple Container, then
creates and installs that App with the required permissions. Install Tart and `sshpass` separately only
on workers that run VM jobs. See the
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
