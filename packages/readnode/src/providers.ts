import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { run } from "./exec.js";
import { STATE_DIR } from "./state.js";

export interface ProvisionRequest {
  name: string;
  region: string;
  instanceType: string;
  diskGb: number;
  sshKey?: string;
  sshHost?: string;
  fid: number;
  dryRun: boolean;
  cloudInitPath: string;
}

export interface ProvisionResult {
  host: string;
  sshKey?: string;
  instanceName: string;
  notes: string[];
}

export interface Provider {
  readonly id: string;
  readonly description: string;
  readonly requiredCli?: string;
  readonly defaults: {
    region: string;
    instanceType: string;
    diskGb: number;
  };
  provision(request: ProvisionRequest): Promise<ProvisionResult>;
}

async function exec(
  dryRun: boolean,
  command: string,
  args: string[],
): Promise<string> {
  const printable = `${command} ${args.map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`;
  if (dryRun) {
    process.stdout.write(`  [dry-run] ${printable}\n`);
    return "";
  }
  const result = await run(command, args);
  return result.stdout.trim();
}

const localProvider: Provider = {
  id: "local",
  description: "Run the read node on this machine",
  defaults: { region: "-", instanceType: "local", diskGb: 0 },
  async provision() {
    return {
      host: "local",
      instanceName: "local",
      notes: ["Node will run on this machine; use `readnode up --local`."],
    };
  },
};

const sshProvider: Provider = {
  id: "ssh",
  description: "Install onto a host you already have",
  defaults: { region: "-", instanceType: "existing", diskGb: 0 },
  async provision(request) {
    if (!request.sshHost) {
      throw new Error("--ssh-host user@host is required for the ssh provider");
    }
    return {
      host: request.sshHost,
      sshKey: request.sshKey,
      instanceName: request.sshHost,
      notes: [
        "Confirm the host has at least 16 GB RAM, 4 CPU and 2 TB of free disk.",
      ],
    };
  },
};

const awsProvider: Provider = {
  id: "aws",
  description: "EC2 instance, the provider balajis's guide uses",
  requiredCli: "aws",
  defaults: { region: "us-east-1", instanceType: "m5.xlarge", diskGb: 2048 },
  async provision(request) {
    const notes: string[] = [];
    const group = `${request.name}-sg`;

    const ami = await exec(request.dryRun, "aws", [
      "ssm",
      "get-parameters",
      "--names",
      "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
      "--query",
      "Parameters[0].Value",
      "--output",
      "text",
      "--region",
      request.region,
    ]);
    const imageId = request.dryRun ? "<ubuntu-22.04-ami>" : ami;
    if (!request.dryRun && !imageId.startsWith("ami-")) {
      throw new Error(`Could not resolve Ubuntu AMI, got: ${imageId}`);
    }

    // Without a key pair the instance boots fine but nobody can SSH in, so
    // `readnode up` has no way to watch the install. Make one if none given.
    let sshKey = request.sshKey;
    let keyName = sshKey ? basename(sshKey).replace(/\.pem$/, "") : `${request.name}-key`;
    if (!sshKey) {
      sshKey = join(STATE_DIR, `${keyName}.pem`);
      if (request.dryRun) {
        await exec(true, "aws", ["ec2", "create-key-pair", "--key-name", keyName, "--region", request.region]);
      } else if (!existsSync(sshKey)) {
        const material = await exec(false, "aws", [
          "ec2",
          "create-key-pair",
          "--key-name",
          keyName,
          "--query",
          "KeyMaterial",
          "--output",
          "text",
          "--region",
          request.region,
        ]);
        await mkdir(STATE_DIR, { recursive: true });
        await writeFile(sshKey, `${material}\n`, { mode: 0o600 });
        notes.push(`Created key pair ${keyName}; private key saved to ${sshKey}.`);
      }
    }

    await exec(request.dryRun, "aws", [
      "ec2",
      "create-security-group",
      "--group-name",
      group,
      "--description",
      "readnode: ssh + snapchain 3381-3383",
      "--region",
      request.region,
    ]);

    for (const port of [3381, 3382, 3383]) {
      await exec(request.dryRun, "aws", [
        "ec2",
        "authorize-security-group-ingress",
        "--group-name",
        group,
        "--protocol",
        port === 3382 ? "udp" : "tcp",
        "--port",
        String(port),
        "--cidr",
        "0.0.0.0/0",
        "--region",
        request.region,
      ]);
    }

    await exec(request.dryRun, "aws", [
      "ec2",
      "authorize-security-group-ingress",
      "--group-name",
      group,
      "--protocol",
      "tcp",
      "--port",
      "22",
      "--cidr",
      "0.0.0.0/0",
      "--region",
      request.region,
    ]);

    const tagSpec = `ResourceType=instance,Tags=[{Key=Name,Value=${request.name}}]`;
    const blockDevice = `DeviceName=/dev/sda1,Ebs={VolumeSize=${request.diskGb},VolumeType=gp3,Iops=6000,Throughput=500}`;

    const runArgs = [
      "ec2",
      "run-instances",
      "--image-id",
      imageId,
      "--instance-type",
      request.instanceType,
      "--count",
      "1",
      "--security-groups",
      group,
      "--block-device-mappings",
      blockDevice,
      "--user-data",
      `file://${request.cloudInitPath}`,
      "--tag-specifications",
      tagSpec,
      "--query",
      "Instances[0].InstanceId",
      "--output",
      "text",
      "--region",
      request.region,
    ];
    runArgs.push("--key-name", keyName);

    const instanceId = await exec(request.dryRun, "aws", runArgs);

    if (request.dryRun) {
      return {
        host: "<ec2-public-ip>",
        sshKey,
        instanceName: request.name,
        notes: [
          `EC2 ${request.instanceType} + ${request.diskGb} GB gp3.`,
          "Dry run: no resources created.",
        ],
      };
    }

    await exec(false, "aws", [
      "ec2",
      "wait",
      "instance-running",
      "--instance-ids",
      instanceId,
      "--region",
      request.region,
    ]);

    const ip = await exec(false, "aws", [
      "ec2",
      "describe-instances",
      "--instance-ids",
      instanceId,
      "--query",
      "Reservations[0].Instances[0].PublicIpAddress",
      "--output",
      "text",
      "--region",
      request.region,
    ]);

    notes.push(`Instance ${instanceId} running at ${ip} in ${request.region}.`);
    notes.push(`Snapshots take a few hours; watch with \`readnode status\`.`);

    return {
      host: `ubuntu@${ip}`,
      sshKey,
      instanceName: request.name,
      notes,
    };
  },
};

const gcpProvider: Provider = {
  id: "gcp",
  description: "Compute Engine instance, cheaper block storage than AWS",
  requiredCli: "gcloud",
  defaults: { region: "us-central1-a", instanceType: "n2-standard-4", diskGb: 2000 },
  async provision(request) {
    const notes: string[] = [];

    await exec(request.dryRun, "gcloud", [
      "compute",
      "firewall-rules",
      "create",
      `${request.name}-snapchain`,
      "--allow",
      "tcp:22,tcp:3381,tcp:3383,udp:3382",
      "--source-ranges",
      "0.0.0.0/0",
      "--quiet",
    ]);

    await exec(request.dryRun, "gcloud", [
      "compute",
      "instances",
      "create",
      request.name,
      "--zone",
      request.region,
      "--machine-type",
      request.instanceType,
      "--image-family",
      "ubuntu-2204-lts",
      "--image-project",
      "ubuntu-os-cloud",
      "--boot-disk-size",
      `${request.diskGb}GB`,
      "--boot-disk-type",
      "pd-standard",
      "--tags",
      `${request.name}-snapchain`,
      "--metadata-from-file",
      `user-data=${request.cloudInitPath}`,
      "--quiet",
    ]);

    if (request.dryRun) {
      return {
        host: "<gce-public-ip>",
        sshKey: request.sshKey,
        instanceName: request.name,
        notes: [
          `GCE ${request.instanceType} + ${request.diskGb} GB pd-standard.`,
          "Dry run: no resources created.",
        ],
      };
    }

    const ip = await exec(false, "gcloud", [
      "compute",
      "instances",
      "describe",
      request.name,
      "--zone",
      request.region,
      "--format",
      "get(networkInterfaces[0].accessConfigs[0].natIP)",
    ]);

    notes.push(`Instance ${request.name} running at ${ip} in ${request.region}.`);
    return {
      host: `ubuntu@${ip}`,
      sshKey: request.sshKey,
      instanceName: request.name,
      notes,
    };
  },
};

const hetznerProvider: Provider = {
  id: "hetzner",
  description: "Hetzner Cloud with an attached volume",
  requiredCli: "hcloud",
  defaults: { region: "fsn1", instanceType: "ccx33", diskGb: 2048 },
  async provision(request) {
    const notes: string[] = [];

    await exec(request.dryRun, "hcloud", [
      "server",
      "create",
      "--name",
      request.name,
      "--type",
      request.instanceType,
      "--image",
      "ubuntu-22.04",
      "--location",
      request.region,
      "--user-data-from-file",
      request.cloudInitPath,
    ]);

    await exec(request.dryRun, "hcloud", [
      "volume",
      "create",
      "--size",
      String(request.diskGb),
      "--name",
      `${request.name}-data`,
      "--server",
      request.name,
    ]);

    notes.push(
      "Hetzner volumes are network-attached: expect slower initial sync than local NVMe.",
    );
    notes.push("Mount the volume at ~/snapchain before starting the node.");

    if (request.dryRun) {
      notes.push("Dry run: no resources created.");
      return { host: "<hetzner-ip>", instanceName: request.name, notes };
    }

    const ip = await exec(false, "hcloud", [
      "server",
      "describe",
      request.name,
      "-o",
      "json",
    ]);
    const parsed = JSON.parse(ip) as { public_net?: { ipv4?: { ip?: string } } };
    const address = parsed.public_net?.ipv4?.ip ?? "";
    return { host: `root@${address}`, instanceName: request.name, notes };
  },
};

export const PROVIDERS: Record<string, Provider> = {
  local: localProvider,
  ssh: sshProvider,
  aws: awsProvider,
  gcp: gcpProvider,
  hetzner: hetznerProvider,
};

export const DEFAULT_PROVIDER = "aws";
