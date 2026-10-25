#!/usr/bin/env bash
# Reference-only mirrors. Versions come from package.json; never runtime inputs.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
pin() { node -p "require('${ROOT}/package.json').devDependencies['$1']"; }

# Preserve dirty or mismatched mirrors; a version bump needs deliberate review.
git_source() {
  local remote="$1" rel="$2" ref="$3" dest="${ROOT}/.agent_sources/$2"
  if [[ -d "$dest/.git" ]]; then
    if [[ -n "$(git -C "$dest" status --porcelain)" ]]; then
      echo "Refusing modified mirror: $rel" >&2; exit 1
    fi
    if [[ "$(git -C "$dest" rev-parse HEAD)" != "$(git -C "$dest" rev-parse "${ref}^{commit}")" ]]; then
      echo "Mirror ref mismatch: $rel; preserve it and hydrate a matching mirror" >&2; exit 1
    fi
    return
  elif [[ -e "$dest" ]]; then
    echo "Refusing non-mirror directory: $rel" >&2; exit 1
  fi
  mkdir -p "$(dirname "$dest")"
  git clone --depth 1 --branch "$ref" "$remote" "$dest"
  printf '\n.agent-source.json\n' >> "$dest/.git/info/exclude"
  printf '{"type":"git-source","remote":"%s","ref":"%s","commit":"%s","addedAt":"%s"}\n' \
    "$remote" "$ref" "$(git -C "$dest" rev-parse HEAD)" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/.agent-source.json"
}

git_source https://github.com/Effect-TS/effect.git github.com/Effect-TS/effect "effect@$(pin effect)"
# Alchemy ships its source in the lockfile-integrity-checked npm package.
# Its upstream Git repository need not be public for source-first inspection.
version="$(pin alchemy)"
installed="$(node -p "require('${ROOT}/node_modules/alchemy/package.json').version")"
[[ "$installed" == "$version" ]] || { echo 'Install the pinned Alchemy package first' >&2; exit 1; }
dest="$ROOT/.agent_sources/npm/alchemy@$version"
if [[ ! -e "$dest" ]]; then
  mkdir -p "$dest"
  cp -R "$ROOT/node_modules/alchemy/src" "$dest/"
  cp "$ROOT/node_modules/alchemy/package.json" "$ROOT/node_modules/alchemy/LICENSE" "$dest/"
fi
printf 'Pinned reference sources ready. Inspect node_modules/alchemy/src for installed behavior.\n'
