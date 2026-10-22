// Snapchain's built-in snapshot download reads every shard's latest.json once,
// then fetches the shards one after another, one chunk at a time. That takes
// 5-8 hours, and the snapshot bucket publishes a new snapshot per shard every
// 24 h (shard 0 ~05:19 UTC, shard 2 ~08:06, shard 1 ~13:38) and deletes the
// old one straight away. Any shard whose turn comes after its rotation gets a
// 404, the node panics, restarts with a non-empty DB, skips the snapshot and
// syncs that shard from genesis.
//
// This script does the download instead: it reads latest.json per shard right
// before fetching it, starts that shard over if it rotates mid-download, and
// fetches chunks in parallel. Snapchain only loads a snapshot into an empty
// DB, so once .rocks is populated it starts straight from there.

export const SNAPSHOT_BUCKET = "https://pub-d352dd8819104a778e20d08888c5a661.r2.dev";
export const SNAPSHOT_LOG = "/var/log/readnode-snapshot.log";

export function renderSnapshotFetch(options: { parallel?: number } = {}): string {
  const parallel = options.parallel ?? 8;
  return `#!/bin/bash
# readnode snapshot fetch. Safe to rerun: finished shards and chunks are kept.
set -euo pipefail
ROCKS="\${1:?usage: readnode-snapshot <snapchain>/.rocks}"
WORK="$ROCKS.readnode"
BUCKET="${SNAPSHOT_BUCKET}"
NETWORK="FARCASTER_NETWORK_MAINNET"
PARALLEL=${parallel}

command -v jq >/dev/null || { apt-get update -qq && apt-get install -y -qq jq; }

if [ -d "$ROCKS" ] && [ -n "$(ls -A "$ROCKS")" ]; then
  echo "readnode-snapshot: $ROCKS already has data, nothing to fetch"
  exit 0
fi
mkdir -p "$WORK/db"

fetch_chunk() {
  # $1 dir, $2 url prefix, $3 chunk name. Chunks land as .part and are renamed
  # only once curl succeeds, so any chunk without the suffix is complete.
  local f="$1/$3"
  [ -s "$f" ] && return 0
  curl -fsS --retry 10 --retry-delay 10 --retry-all-errors -o "$f.part" "$2/$3" && mv "$f.part" "$f"
}
export -f fetch_chunk

for shard in 1 2 0; do
  [ -f "$WORK/done-$shard" ] && { echo "readnode-snapshot: shard $shard already done"; continue; }
  dir="$WORK/chunks-$shard"
  for attempt in 1 2 3 4; do
    meta=$(curl -fsS --retry 5 "$BUCKET/$NETWORK/$shard/latest.json")
    key=$(echo "$meta" | jq -r .key_base)
    if [ "$(cat "$dir/key" 2>/dev/null)" != "$key" ]; then
      rm -rf "$dir"; mkdir -p "$dir"; echo "$key" > "$dir/key"
    fi
    echo "$meta" | jq -r '.chunks[]' > "$dir/list"
    total=$(wc -l < "$dir/list")
    echo "readnode-snapshot: shard $shard, $total chunks of $key"

    ( while sleep 60; do
        echo "readnode-snapshot: shard $shard $(ls "$dir" | grep -c '\\.bin$')/$total chunks"
      done ) &
    progress=$!
    status=0
    xargs -P "$PARALLEL" -I{} bash -c 'fetch_chunk "$0" "$1" "$2"' "$dir" "$BUCKET/$key" {} < "$dir/list" || status=$?
    kill "$progress" 2>/dev/null || true

    [ "$status" -eq 0 ] && break
    # A 404 means the snapshot rotated under us; latest.json now names the new one.
    echo "readnode-snapshot: shard $shard download failed (attempt $attempt), rereading latest.json"
    [ "$attempt" -eq 4 ] && { echo "readnode-snapshot: giving up on shard $shard"; exit 1; }
    sleep 30
  done

  echo "readnode-snapshot: unpacking shard $shard"
  rm -rf "$WORK/db/shard-$shard"
  # Each chunk is its own gzip member; concatenated they decompress to one tar.
  while read -r c; do cat "$dir/$c"; done < "$dir/list" | gunzip | tar -x -C "$WORK/db"
  touch "$WORK/done-$shard"
  rm -rf "$dir"
  echo "readnode-snapshot: shard $shard done"
done

mkdir -p "$ROCKS"
mv "$WORK"/db/* "$ROCKS"/
rm -rf "$WORK"
echo "readnode-snapshot: complete, $(du -sh "$ROCKS" | cut -f1) in $ROCKS"
`;
}
