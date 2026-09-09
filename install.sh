#!/bin/sh
# Download a self-contained Mason release. Node/npm are not prerequisites.
set -eu
case "$(uname -s)" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'Use install.ps1 on Windows.' >&2; exit 2 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported architecture.' >&2; exit 2 ;; esac
version=${MASON_VERSION:-}
if [ -n "${MASON_RELEASE_BASE:-}" ] && [ -z "$version" ]; then
  echo 'Set MASON_VERSION when using MASON_RELEASE_BASE; no public latest-version lookup was made.' >&2
  exit 2
fi
if [ -z "$version" ]; then
  resolved=$(curl -fsSLI -o /dev/null -w '%{url_effective}' https://github.com/adrianczuczka/mason/releases/latest)
  version=${resolved##*/}
fi
version=${version#v}
# A version is one URL/path component. No options, whitespace or shell syntax.
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || { echo 'Invalid Mason release version.' >&2; exit 2; }
asset="mason-$platform-$arch.tar.gz"
base=${MASON_RELEASE_BASE:-https://github.com/adrianczuczka/mason/releases/download}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
curl -fsSL "$base/v$version/$asset" -o "$tmp/bundle.tar.gz"
curl -fsSL "$base/v$version/SHA256SUMS" -o "$tmp/checksums"
expected=$(awk -v name="$asset" '$2 == name { print $1; n++ } END { if (n != 1) exit 2 }' "$tmp/checksums")
case "$expected" in ''|*[!a-f0-9]*) echo 'Invalid release checksum.' >&2; exit 2 ;; esac
[ "${#expected}" -eq 64 ] || exit 2
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$tmp/bundle.tar.gz" | awk '{print $1}')
else actual=$(shasum -a 256 "$tmp/bundle.tar.gz" | awk '{print $1}'); fi
[ "$actual" = "$expected" ] || { echo 'Mason archive checksum mismatch; installation unchanged.' >&2; exit 2; }
tar -tzf "$tmp/bundle.tar.gz" | while IFS= read -r entry; do
  case "$entry" in *../*|*/..|/*|*\\*) echo 'Unsafe archive entry.' >&2; exit 2 ;; esac
  case "$entry" in "mason-$platform-$arch/"*) ;; *) echo 'Unexpected archive root.' >&2; exit 2 ;; esac
done
tar -xzf "$tmp/bundle.tar.gz" -C "$tmp"
bundle="$tmp/mason-$platform-$arch"
"$bundle/node" "$bundle/app/dist/mason.js" internal-install
