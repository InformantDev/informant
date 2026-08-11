#!/bin/sh

set -eu

repository="InformantDev/informant"
install_dir=${INFORMANT_INSTALL_DIR:-"$HOME/.local/bin"}
version=${INFORMANT_VERSION:-latest}
release_root=${INFORMANT_RELEASE_ROOT:-"https://github.com/$repository/releases"}

fail() {
  printf 'informant installer: %s\n' "$1" >&2
  exit 1
}

command -v mktemp >/dev/null 2>&1 || fail "mktemp is required"
command -v awk >/dev/null 2>&1 || fail "awk is required"

case "$(uname -s)" in
  Linux) ;;
  Darwin) fail "use Homebrew on macOS: brew install informantdev/tap/informant" ;;
  *) fail "only Linux is supported by this installer" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) architecture=x64 ;;
  aarch64 | arm64) architecture=arm64 ;;
  *) fail "unsupported architecture: $(uname -m)" ;;
esac

case "$version" in
  latest) release_url="$release_root/latest/download" ;;
  v[0-9]*) release_url="$release_root/download/$version" ;;
  [0-9]*) release_url="$release_root/download/v$version" ;;
  *) fail "INFORMANT_VERSION must be a release version such as 0.1.2 or v0.1.2" ;;
esac

download() {
  url=$1
  destination=$2
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
      --output "$destination" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --quiet --output-document="$destination" "$url"
  else
    fail "curl or wget is required"
  fi
}

checksum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail "sha256sum or shasum is required"
  fi
}

asset="informant-linux-$architecture"
temporary_directory=$(mktemp -d "${TMPDIR:-/tmp}/informant-install.XXXXXX")
trap 'rm -rf "$temporary_directory"' EXIT HUP INT TERM

download "$release_url/$asset" "$temporary_directory/$asset"
download "$release_url/SHA256SUMS" "$temporary_directory/SHA256SUMS"

expected_checksum=$(awk -v asset="$asset" '$2 == asset { print $1 }' "$temporary_directory/SHA256SUMS")
[ -n "$expected_checksum" ] || fail "the release checksum file does not contain $asset"
actual_checksum=$(checksum "$temporary_directory/$asset")
[ "$actual_checksum" = "$expected_checksum" ] || fail "checksum verification failed for $asset"

mkdir -p "$install_dir"
temporary_binary="$install_dir/.informant.$$"
trap 'rm -rf "$temporary_directory"; rm -f "$temporary_binary"' EXIT HUP INT TERM
cp "$temporary_directory/$asset" "$temporary_binary"
chmod 0755 "$temporary_binary"
mv -f "$temporary_binary" "$install_dir/informant"

installed_version=$("$install_dir/informant" --version) || fail "the installed binary could not run"
printf 'Installed Informant %s to %s/informant\n' "$installed_version" "$install_dir"

case ":${PATH:-}:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH before running Informant.\n' "$install_dir" ;;
esac

if command -v gh >/dev/null 2>&1; then
  printf 'Next: gh auth login && informant setup\n'
else
  printf 'Next: install GitHub CLI, run gh auth login, then run informant setup.\n'
fi
