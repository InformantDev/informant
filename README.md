# Informant

**Local machines, reporting for CI duty.** Informant polls GitHub from behind your firewall,
claims commits through the Checks API, and runs TOML-defined jobs in disposable native checkouts,
Apple containers, rootless Podman containers, or Tart VMs.
Each job can select and prepare its own runtime image, keeping macOS VMs limited to jobs that need them.

## Install

Install the standalone binary and GitHub CLI with Homebrew on macOS or Linux:

```bash
brew install informantdev/tap/informant
gh auth login
informant setup
```

On Linux without Homebrew, use the official installer, then install
[GitHub CLI](https://github.com/cli/cli/blob/trunk/docs/install_linux.md) through your distribution:

```bash
curl --proto '=https' --tlsv1.2 -fsSL \
  https://raw.githubusercontent.com/InformantDev/informant/main/install.sh | sh
export PATH="$HOME/.local/bin:$PATH"
gh auth login
informant setup
```

The installer verifies the release checksum and writes to `~/.local/bin` by default; set
`INFORMANT_INSTALL_DIR` or `INFORMANT_VERSION` to override the destination or install a specific
release. The user-owned default also supports automatic updates. `informant setup` can install Podman
packages, but it does not install GitHub CLI. On Linux without a systemd user manager, run
`informant serve` in the foreground or under the host's existing supervisor.

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

## Releases

Tags matching `v*` run the Informant `release` job. It builds and smoke-tests the standalone Linux
binaries, publishes all four platform binaries with checksums and a generated Homebrew formula, and
opens the formula update PR in `InformantDev/homebrew-tap`. The release worker must provide
`INFORMANT_SECRET_RELEASE_GITHUB_TOKEN` with release write access to this repository and contents and
pull-request write access to the tap.

## License

[Apache License 2.0](LICENSE).
