import { SnapchainNode } from "../core/index.js";
import { loadState } from "../state.js";

export interface StatusFlags {
  nodeUrl?: string;
  json?: boolean;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export async function status(flags: StatusFlags): Promise<void> {
  const state = await loadState();
  const nodeUrl = flags.nodeUrl ?? state.nodeUrl ?? "http://127.0.0.1:3381";
  const node = new SnapchainNode(nodeUrl);
  const info = await node.info();

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
    return;
  }

  process.stdout.write(`\nNode    ${nodeUrl}\n`);
  process.stdout.write(`Version ${info.version}\n`);
  if (info.dbStats) {
    process.stdout.write(
      `State   ${info.dbStats.numMessages.toLocaleString()} messages, ${formatBytes(info.dbStats.approxSize)}\n`,
    );
    process.stdout.write(`FIDs    ${info.dbStats.numFidRegistrations.toLocaleString()}\n`);
  }
  process.stdout.write(`\n${"shard".padEnd(7)}${"height".padStart(12)}${"delay".padStart(8)}\n`);
  for (const shard of info.shardInfos) {
    process.stdout.write(
      `${String(shard.shardId).padEnd(7)}${shard.maxHeight.toLocaleString().padStart(12)}${String(shard.blockDelay).padStart(8)}\n`,
    );
  }
  const worst = Math.max(...info.shardInfos.map((s) => s.blockDelay), 0);
  process.stdout.write(
    worst < 10 ? "\nSynced.\n" : `\nSyncing — lagging ${worst}s. Snapshot download can take hours.\n`,
  );
}
