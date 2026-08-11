#!/bin/sh

set -eu

if [ "$#" -ne 3 ]; then
  printf 'usage: %s <tag> <SHA256SUMS> <output>\n' "$0" >&2
  exit 2
fi

tag=$1
checksum_file=$2
output=$3
version=${tag#v}

case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *) printf 'invalid release tag: %s\n' "$tag" >&2; exit 2 ;;
esac

release_checksum() {
  checksum=$(awk -v asset="$1" '$2 == asset { print $1 }' "$checksum_file")
  if ! printf '%s\n' "$checksum" | grep -Eq '^[0-9a-fA-F]{64}$'; then
    printf 'missing or invalid checksum for %s\n' "$1" >&2
    exit 1
  fi
  printf '%s' "$checksum"
}

darwin_arm64=$(release_checksum informant-darwin-arm64)
darwin_x64=$(release_checksum informant-darwin-x64)
linux_arm64=$(release_checksum informant-linux-arm64)
linux_x64=$(release_checksum informant-linux-x64)

cat > "$output" <<EOF
class Informant < Formula
  desc "Local machines, reporting for CI duty"
  homepage "https://github.com/InformantDev/informant"
  version "$version"
  license "Apache-2.0"

  depends_on "gh"

  if OS.mac?
    if Hardware::CPU.arm?
      url "https://github.com/InformantDev/informant/releases/download/v#{version}/informant-darwin-arm64"
      sha256 "$darwin_arm64"
    else
      url "https://github.com/InformantDev/informant/releases/download/v#{version}/informant-darwin-x64"
      sha256 "$darwin_x64"
    end
  elsif OS.linux?
    if Hardware::CPU.arm?
      url "https://github.com/InformantDev/informant/releases/download/v#{version}/informant-linux-arm64"
      sha256 "$linux_arm64"
    else
      url "https://github.com/InformantDev/informant/releases/download/v#{version}/informant-linux-x64"
      sha256 "$linux_x64"
    end
  end

  def install
    binary_name = "informant-#{OS.mac? ? "darwin" : "linux"}-#{Hardware::CPU.arm? ? "arm64" : "x64"}"
    bin.install binary_name => "informant"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/informant --version")
  end
end
EOF
