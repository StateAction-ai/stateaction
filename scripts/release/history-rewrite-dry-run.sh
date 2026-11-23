#!/usr/bin/env bash
# Dry run of the author-email rewrite on a THROWAWAY mirror clone. Never touches
# the real repository. Usage: history-rewrite-dry-run.sh <mirror-dir> <work-dir>
# <mirror-dir> is a `git clone --mirror` (plus `fetch '+refs/pull/*:refs/pull/*'`)
# of the repository; <work-dir> must not exist. See history-rewrite-runbook.md.
set -euo pipefail
src=${1:?mirror dir}; work=${2:?empty work dir}
here=$(cd "$(dirname "$0")" && pwd)
[[ ! -e "$work" ]] || { echo "work dir exists" >&2; exit 2; }
mkdir -p "$work"
git clone -q --mirror "$src" "$work/after"
git -C "$work/after" for-each-ref --format='%(objectname) %(refname)' > "$work/refs-before.txt"
git -C "$work/after" log --all --format='%H %T' | sort > "$work/commit-tree-before.txt"
(cd "$work/after" && uvx git-filter-repo --mailmap "$here/history-mailmap.txt" --force)
git -C "$work/after" for-each-ref --format='%(objectname) %(refname)' > "$work/refs-after.txt"
bad=0; total=0
while read -r old new; do
  total=$((total + 1))
  t_old=$(git -C "$src" rev-parse "$old^{tree}")
  t_new=$(git -C "$work/after" rev-parse "$new^{tree}")
  [[ "$t_old" == "$t_new" ]] || { echo "TREE DIFFERS $old -> $new" >&2; bad=$((bad + 1)); }
done < <(tail -n +2 "$work/after/filter-repo/commit-map")
gmail=$(git -C "$work/after" cat-file --batch-all-objects --batch | grep -ac 'timothywangdev@gmail' || true)
echo "commits compared: $total, tree mismatches: $bad"
echo "objects mentioning the old address after rewrite: $gmail"
git -C "$work/after" log --all --format='%an <%ae> | %cn <%ce>' | sort | uniq -c
signed() { git -C "$1" rev-list --all | while read -r c; do git -C "$1" cat-file commit "$c" | sed '/^$/q' | grep -q '^gpgsig' && echo x; done | wc -l; }
echo "signed commits before: $(signed "$src"), after: $(signed "$work/after")"
join -j2 <(sort -k2 "$work/refs-before.txt") <(sort -k2 "$work/refs-after.txt") \
  | awk '$2!=$3{c++} $2==$3{u++} END{print "ref tips changed:",c+0," unchanged:",u+0}'
[[ $bad -eq 0 && $gmail -eq 0 ]] && echo DRY_RUN_PASS || { echo DRY_RUN_FAIL; exit 1; }
