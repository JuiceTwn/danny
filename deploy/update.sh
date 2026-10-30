#!/usr/bin/env bash
# Update Danny to the latest code: danny update
# Backs up first, builds, migrates, starts the new version, and puts the old code back if the new one does not come up healthy.
# Database migrations are additive and are NOT undone by a rollback. To go back further, use danny restore with the backup this made.
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
# shellcheck source=common.sh
. "$DIR/common.sh"
cd "$DANNY_DIR"

branch="${DANNY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
[ "$branch" != "HEAD" ] || die "the checkout is detached. Check out a branch first (git checkout main)"
[ -z "$(git status --porcelain --untracked-files=no)" ] || die "there are local changes to tracked files. Commit or discard them first."

prev="$(git rev-parse HEAD)"
git fetch --quiet origin "$branch"
target="$(git rev-parse "origin/$branch")"
if [ "$prev" = "$target" ]; then say "Already up to date ($(git rev-parse --short HEAD))."; exit 0; fi

say "Updating $(git rev-parse --short "$prev") -> $(git rev-parse --short "$target")"
"$DIR/backup.sh"
git merge --ff-only "origin/$branch"   # never a merge commit, never a rewrite: if history diverged this stops here

rollback() {
  say "The new version did not come up healthy. Putting the old code back ($(git rev-parse --short "$prev"))..."
  git reset --hard "$prev"
  compose up -d --build api
  if wait_healthy 120; then say "Rolled back and healthy. Check: docker compose logs api"; else say "Rollback is not healthy either. Run: danny doctor"; fi
  exit 1
}

compose build api || rollback
compose run --rm --no-deps api node dist/cli/migrate.js || rollback
compose up -d || rollback
wait_healthy 120 || rollback
say "Updated and healthy at $(git rev-parse --short HEAD)."
