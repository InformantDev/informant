# Informant

**Local machines, reporting for CI duty.** Informant polls GitHub from behind your firewall,
claims commits through the Checks API, and runs TOML-defined jobs in disposable native checkouts,
Apple containers, rootless Podman containers, or Tart VMs.
Each job can select and prepare its own runtime image, keeping macOS VMs limited to jobs that need them.

## Install

Install the standalone binary with Homebrew on macOS:

```bash
brew install informantdev/tap/informant
brew install gh
gh auth login
informant setup
```

On Linux, install Informant separately from Podman. From a source checkout with Bun installed:

```bash
bun install
bun run --cwd apps/informant build:binary
sudo install -m 0755 apps/informant/dist/informant /usr/local/bin/informant
informant setup
```

`informant setup` can install Podman packages, but it does not install Informant itself. On Linux
without a systemd user manager, run `informant serve` in the foreground or under the supervisor
already used by the host.

Informant requires GitHub CLI (`gh`) and a GitHub App installation with **Checks: read/write**,
**Contents: read**, and **Pull requests: read/write** permissions. Native host jobs run on Linux or
macOS. Linux workers use daemonless rootless Podman for container jobs; `informant setup` can install
it with `apt-get` or `dnf`, without systemd or a Podman service. Apple Silicon workers can use
[Apple Container](https://github.com/apple/container) for container jobs or
[Tart](https://tart.run) and `sshpass` for VM jobs. On Apple Silicon, the interactive setup command
installs and verifies Apple Container, then
creates and installs that App with the required permissions. Install Tart and `sshpass` separately only
on workers that run VM jobs. Portable container jobs use `runs_on = ["container"]`. See the
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
