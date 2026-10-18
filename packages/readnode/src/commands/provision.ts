import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCloudInit } from "../cloud-init.js";
import { hasCommand } from "../exec.js";
import { resolveFidFromUsername } from "../fnames.js";
import { DEFAULT_PROVIDER, PROVIDERS } from "../providers.js";
import { STATE_DIR, loadState, saveState } from "../state.js";

export interface ProvisionFlags {
  provider?: string;
  name?: string;
  region?: string;
  instanceType?: string;
  diskGb?: number;
  sshKey?: string;
  sshHost?: string;
  fid?: number;
  username?: string;
  dryRun?: boolean;
  yes?: boolean;
}

export async function provision(flags: ProvisionFlags): Promise<void> {
  const providerId = flags.provider ?? DEFAULT_PROVIDER;
  const provider = PROVIDERS[providerId];
  if (!provider) {
    throw new Error(
      `Unknown provider "${providerId}". Available: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }

  const state = await loadState();
  let fid = flags.fid ?? state.fid;

  if (!fid && flags.username) {
    fid = await resolveFidFromUsername(flags.username);
  }
  if (!fid) {
    throw new Error(
      "A Farcaster account is required: pass --fid <n> or --username <name>.",
    );
  }

  if (provider.requiredCli && !flags.dryRun) {
    if (!(await hasCommand(provider.requiredCli))) {
      throw new Error(
        `Provider "${provider.id}" needs the "${provider.requiredCli}" CLI on your PATH.`,
      );
    }
  }

  const name = flags.name ?? "readnode";
  const region = flags.region ?? provider.defaults.region;
  const instanceType = flags.instanceType ?? provider.defaults.instanceType;
  const diskGb = flags.diskGb ?? provider.defaults.diskGb;

  const cloudInit = renderCloudInit({ fid });
  const cloudInitPath = join(STATE_DIR, "cloud-init.sh");
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(cloudInitPath, cloudInit, { encoding: "utf8", mode: 0o700 });

  process.stdout.write(
    `\nProvisioning ${provider.id} — ${instanceType}, ${diskGb} GB, ${region}\n`,
  );
  process.stdout.write(`FID: ${fid}\n`);
  process.stdout.write(`cloud-init: ${cloudInitPath}\n`);

  const result = await provider.provision({
    name: name ?? "readnode",
    region,
    instanceType,
    diskGb,
    sshKey: flags.sshKey,
    sshHost: flags.sshHost,
    fid,
    dryRun: Boolean(flags.dryRun),
    cloudInitPath,
  });

  for (const note of result.notes) {
    process.stdout.write(`  • ${note}\n`);
  }

  if (!flags.dryRun) {
    await saveState({
      provider: provider.id,
      instanceName: result.instanceName,
      host: result.host,
      sshKey: result.sshKey,
      nodeUrl: `http://${result.host.replace(/^[^@]*@/, "")}:3381`,
      fid,
      createdAt: new Date().toISOString(),
    });
    process.stdout.write(
      `\nSaved to ${STATE_DIR}/state.json. Next: readnode up\n`,
    );
  }
}
