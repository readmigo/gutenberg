#!/usr/bin/env bash
#
# Download EPUB fixtures used by the golden-snapshot tests. Fixtures are
# intentionally gitignored — they can be tens of MB and we don't want to
# bloat the repo. CI should cache this directory to avoid re-downloading
# on every run.
#
# Usage: pnpm test:fixtures  (or bash scripts/tests/download-fixtures.sh)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURES_DIR="${SCRIPT_DIR}/fixtures"
mkdir -p "${FIXTURES_DIR}"

UA="Mozilla/5.0 (gutenberg-platform-tests)"

# Each entry: <target-filename>::<url>
FIXTURES=(
  "pg-1342-pride-and-prejudice.epub::https://www.gutenberg.org/ebooks/1342.epub3.images"
  "pg-84-frankenstein.epub::https://www.gutenberg.org/ebooks/84.epub3.images"
  "pg-11-alice.epub::https://www.gutenberg.org/ebooks/11.epub3.images"
  "se-pride-and-prejudice.epub::https://standardebooks.org/ebooks/jane-austen/pride-and-prejudice/downloads/jane-austen_pride-and-prejudice.epub?source=download"
)

for entry in "${FIXTURES[@]}"; do
  filename="${entry%%::*}"
  url="${entry##*::}"
  target="${FIXTURES_DIR}/${filename}"

  if [[ -s "${target}" ]]; then
    echo "✓ ${filename} (cached)"
    continue
  fi

  echo "↓ ${filename}"
  curl -sSL -H "User-Agent: ${UA}" --retry 3 --retry-delay 2 "${url}" -o "${target}"

  # Quick sanity: EPUB is a ZIP archive, first bytes should be PK\x03\x04
  if ! head -c 4 "${target}" | grep -q "PK"; then
    echo "✗ ${filename} is not a valid EPUB (server may have returned an HTML page)"
    rm -f "${target}"
    exit 1
  fi
done

echo ""
echo "Fixture summary:"
ls -lh "${FIXTURES_DIR}" | tail -n +2 | awk '{printf "  %s  %s\n", $5, $NF}'
