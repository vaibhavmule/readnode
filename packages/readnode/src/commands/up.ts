import { run, ssh, sshScript } from "../exec.js";
import { SnapchainNode } from "../core/index.js";
import { loadState, saveState } from "../state.js";
import { renderCloudInit } from "../cloud-init.js";
import { SNAPSHOT_LOG } from "../snapshot-fetch.js";

export interface UpFlags {
  host?: string;
  local?: boolean;
  sshKey?: string;
  nodeUrl?: string;
  timeoutSeconds?: number;
  targetDelay?: number;
}

const SYNCED_DELAY_SECONDS = 10;

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export function nodeUrlForHost(host: string): string {
  return `http://${host.replace(/^[^@]*@/, "")}:3381`;
}

// These providers boot with our cloud-init as user-data, so the install is
// already running by the time `up` is called. Running it again would race it.
const CLOUD_INIT_PROVIDERS = new Set(["aws", "gcp", "hetzner"]);

async function install(
  host: string,
  sshKey: string | undefined,
  fid: number,
): Promise<void> {
  process.stdout.write(
    `Installing Snapchain on ${host} (this takes a few minutes)...\n`,
  );
  const sudo = host.startsWith("root@") ? "" : "sudo ";
  const result = await sshScript(host, renderCloudInit({ fid }), {
    sshKey,
    inherit: true,
    command: `${sudo}bash -s`,
  });
  if (result.code !== 0) {
    throw new Error(`Remote install failed with exit code ${result.code}.`);
  }
}

async function waitForCloudInit(
  host: string,
  sshKey: string | undefined,
): Promise<void> {
  process.stdout.write(`Waiting for ${host} to accept SSH...\n`);
  for (let attempt = 0; ; attempt++) {
    const probe = await ssh(host, "true", { sshKey, allowFailure: true });
    if (probe.code === 0) break;
    if (attempt >= 40) {
      throw new Error(`Could not SSH to ${host} after 10 minutes:\n${probe.stderr}`);
    }
    await sleep(15);
  }

  process.stdout.write(
    "Waiting for the boot-time install (Docker, the snapshot, Snapchain) to finish.\n" +
      "The snapshot is ~450 GB, so expect a few hours. Ctrl-C is safe; rerun `readnode up` to keep watching.\n",
  );
  let lastLine = "";
  let status;
  for (;;) {
    status = await ssh(
      host,
      `sudo cloud-init status | tail -n 1; sudo tail -n 1 ${SNAPSHOT_LOG} 2>/dev/null || true`,
      { sshKey, allowFailure: true },
    );
    const [state = "", progress = ""] = status.stdout.trim().split("\n");
    if (progress && progress !== lastLine) {
      process.stdout.write(`  ${new Date().toISOString().slice(11, 19)}  ${progress.replace(/^readnode-snapshot: /, "")}\n`);
      lastLine = progress;
    }
    if (/status: (done|error|degraded)/.test(state)) break;
    await sleep(60);
  }
  if (!/status: done/.test(status.stdout)) {
    const log = await ssh(host, "sudo tail -n 60 /var/log/cloud-init-output.log", {
      sshKey,
      allowFailure: true,
    });
    throw new Error(
      `The install on ${host} failed (${status.stdout.trim()}). Last lines of cloud-init-output.log:\n${log.stdout}`,
    );
  }
  process.stdout.write("Snapchain is installed and running.\n");
}

export async function up(flags: UpFlags): Promise<void> {
  const state = await loadState();
  const host = flags.local ? "local" : flags.host ?? state.host;
  const fid = state.fid;

  if (flags.local) {
    if (!fid) throw new Error("No FID recorded. Run `readnode provision --fid <n>` first.");
    process.stdout.write("Installing Snapchain on this machine...\n");
    const result = await run(
      "bash",
      ["-c", `curl -sSL https://raw.githubusercontent.com/farcasterxyz/snapchain/refs/heads/main/scripts/snapchain-bootstrap.sh | bash`],
      { inherit: true, allowFailure: true },
    );
    if (result.code !== 0) {
      throw new Error("Local install failed. See output above.");
    }
  } else if (host) {
    const sshKey = flags.sshKey ?? state.sshKey;
    if (!flags.host && state.provider && CLOUD_INIT_PROVIDERS.has(state.provider)) {
      await waitForCloudInit(host, sshKey);
    } else {
      if (!fid) throw new Error("No FID recorded. Run `readnode provision --fid <n>` first.");
      await install(host, sshKey, fid);
    }
  }

  const nodeUrl = flags.nodeUrl ?? state.nodeUrl ?? (host ? nodeUrlForHost(host) : undefined);
  if (!nodeUrl) {
    throw new Error("No node to reach. Provision a host or pass --node-url.");
  }

  const node = new SnapchainNode(nodeUrl);
  const timeout = flags.timeoutSeconds ?? 3600;
  const target = flags.targetDelay ?? SYNCED_DELAY_SECONDS;
  const started = Date.now();

  process.stdout.write(`\nWaiting for ${nodeUrl} to sync (target: blockDelay < ${target}s)\n`);

  for (;;) {
    try {
      const info = await node.info();
      const delay = Math.max(...info.shardInfos.map((s) => s.blockDelay), 0);
      const behind = info.shardInfos.map((s) => `${s.shardId}:${s.blockDelay}`).join(" ");
      process.stdout.write(
        `  ${new Date().toISOString().slice(11, 19)}  v${info.version}  blockDelay ${behind}\n`,
      );
      if (delay < target) {
        process.stdout.write("\nNode is synced.\n");
        break;
      }
    } catch (error) {
      process.stdout.write(
        `  ${new Date().toISOString().slice(11, 19)}  not reachable yet (${
          error instanceof Error ? error.message : String(error)
        })\n`,
      );
    }

    if ((Date.now() - started) / 1000 > timeout) {
      process.stdout.write(
        `\nStill syncing after ${timeout}s. Snapshot download can take hours — rerun \`readnode status\` later.\n`,
      );
      break;
    }
    await sleep(15);
  }

  await saveState({ nodeUrl });
  process.stdout.write(`\nNext: readnode client\n`);
}
