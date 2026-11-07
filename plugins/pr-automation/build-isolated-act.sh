#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
plugin_dir="$repo_root/plugins/pr-automation"
source_dir="$repo_root/.artifacts/act-dsh-source"
binary_dir="$repo_root/.artifacts/pr-automation"
binary="$binary_dir/act-dsh-isolated"
source_commit="2540ba6c49dfbafe167d655e4044921cd2ed19e7"
patches=("$plugin_dir/patches/act-toolcache-isolation.patch" "$plugin_dir/patches/act-service-network.patch")
version='0.2.97-dsh2'
runner_tag='dsh-pr-act:openbot'
runner_image='sha256:8cb9d32523bd18f280c365eb461d07f7b49ba7e06e3497584f128fb50d408a8b'

if [[ ! -d "$source_dir/.git" ]]; then
  mkdir -p "$repo_root/.artifacts"
  git clone --filter=blob:none --no-checkout https://github.com/nektos/act.git "$source_dir"
  git -C "$source_dir" checkout --detach "$source_commit"
fi
actual_commit="$(git -C "$source_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$source_commit" ]]; then
  printf 'Unexpected act source commit: %s\n' "$actual_commit" >&2
  exit 1
fi
for patch in "${patches[@]}"; do
  if git -C "$source_dir" apply --reverse --check "$patch" >/dev/null 2>&1; then
    :
  else
    git -C "$source_dir" apply --check "$patch"
    git -C "$source_dir" apply "$patch"
  fi
done
gofmt -w "$source_dir/pkg/runner/run_context.go"
mkdir -p "$binary_dir"
(
  cd "$source_dir"
  go build -trimpath -ldflags "-X main.version=$version" -o "$binary" .
)
chmod 0700 "$binary"
actual_version="$("$binary" --version)"
if [[ "$actual_version" != "act version $version" ]]; then
  printf 'Unexpected isolated act version: %s\n' "$actual_version" >&2
  exit 1
fi
docker_cli="${DOCKER_CLI:-docker}"
actual_runner_image="$("$docker_cli" image inspect --format '{{.Id}}' "$runner_tag")"
if [[ "$actual_runner_image" != "$runner_image" ]]; then
  printf 'Runner image mismatch: expected %s, got %s; update the pinned image only after reviewing the rebuilt image.\n' "$runner_image" "$actual_runner_image" >&2
  exit 1
fi
printf '%s\n' "$binary"
