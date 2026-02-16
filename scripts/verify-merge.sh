#!/usr/bin/env bash
# Verify no upstream changes were accidentally dropped during merge resolution.
#
# Usage: ./scripts/verify-merge.sh [merge-base] [upstream-ref]
#   merge-base:   defaults to $(git merge-base HEAD origin/main)
#   upstream-ref: defaults to origin/main
#
# For each file that had conflicts, this script extracts the non-import,
# non-whitespace additions upstream made and checks whether each line
# exists (possibly adapted) in the working tree.
#
# Lines that are NOT found are printed so you can manually verify whether
# they were intentionally replaced (e.g., node API -> Bun API) or
# accidentally dropped.

set -euo pipefail

BASE="${1:-$(git merge-base HEAD origin/main)}"
UPSTREAM="${2:-origin/main}"

echo "Merge base: $BASE"
echo "Upstream:   $UPSTREAM"
echo ""

# Get files that had conflicts (UU in the merge)
# Fallback: compare what upstream changed in files we also changed
UPSTREAM_CHANGED=$(git diff --name-only "$BASE".."$UPSTREAM" -- src/ test/)
OUR_CHANGED=$(git diff --name-only "$BASE"..HEAD -- src/ test/)

# Intersection: files changed by both sides
BOTH_CHANGED=$(comm -12 <(echo "$UPSTREAM_CHANGED" | sort) <(echo "$OUR_CHANGED" | sort))

if [ -z "$BOTH_CHANGED" ]; then
  echo "No files changed by both sides. Nothing to verify."
  exit 0
fi

MISSING=0

for file in $BOTH_CHANGED; do
  # Get upstream's additions (skip imports, blank lines, pure comments)
  ADDITIONS=$(git diff "$BASE".."$UPSTREAM" -- "$file" \
    | grep '^+' \
    | grep -v '^+++' \
    | grep -v '^+\s*$' \
    | grep -v '^+\s*//' \
    | grep -v '^+import ' \
    | sed 's/^+//' \
    | sed 's/^[[:space:]]*//' \
    | grep -v '^$' \
    | sort -u)

  if [ -z "$ADDITIONS" ]; then
    continue
  fi

  FILE_MISSING=0
  MISSING_LINES=""

  while IFS= read -r line; do
    # Skip very short lines (braces, etc.) -- too noisy
    if [ ${#line} -lt 15 ]; then
      continue
    fi

    # Escape for grep
    escaped=$(printf '%s' "$line" | sed 's/[[\.*^$()+?{|\\]/\\&/g')

    if ! grep -qF "$line" "$file" 2>/dev/null; then
      FILE_MISSING=$((FILE_MISSING + 1))
      MISSING_LINES="${MISSING_LINES}  ${line}\n"
    fi
  done <<< "$ADDITIONS"

  if [ "$FILE_MISSING" -gt 0 ]; then
    echo "WARNING: $file -- $FILE_MISSING upstream lines not found verbatim:"
    printf "$MISSING_LINES" | head -20
    if [ "$FILE_MISSING" -gt 20 ]; then
      echo "  ... and $((FILE_MISSING - 20)) more"
    fi
    echo ""
    MISSING=$((MISSING + FILE_MISSING))
  fi
done

if [ "$MISSING" -eq 0 ]; then
  echo "All upstream additions found in working tree."
else
  echo "Total: $MISSING upstream lines not found verbatim."
  echo "Review each to confirm it was intentionally adapted (e.g., fs -> Bun API)."
fi
