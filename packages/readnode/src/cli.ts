#!/usr/bin/env node
import { parseArgs } from "node:util";
import { provision } from "./commands/provision.js";
import { up } from "./commands/up.js";
import { status } from "./commands/status.js";
import { client } from "./commands/client.js";
import { PROVIDERS } from "./providers.js";

const HELP = `
readnode — provision a Snapchain read node and run a Farcaster client against it

Usage
  readnode provision [options]   create the compute for your read node
  readnode up [options]          install and start Snapchain, then wait for sync
  readnode status                show node version, shards and sync progress
  readnode client [options]      open the local Farcaster client

Provision options
  --provider <id>     ${Object.keys(PROVIDERS).join(" | ")}  (default: aws)
  --fid <number>      Farcaster ID that will operate the node
  --username <name>   resolve the FID from a Farcaster username instead
  --name <name>       instance name (default: readnode)
  --region <region>   provider region or zone
  --instance-type <t> provider machine type
  --disk-gb <gb>      disk size in GB
  --ssh-key <name>    SSH key name or path
  --ssh-host <h>      user@host, for --provider ssh
  --dry-run           print the commands instead of running them

Up options
  --host <user@host>  install onto this host
  --local             install on this machine
  --node-url <url>    skip install, just wait for this node
  --timeout <seconds> how long to wait for sync (default: 3600)

Client options
  --node-url <url>    node to read from (default: from state)
  --submit-url <url>  node to submit writes to, e.g. a validator
                      (default: the read node, which relays to validators)
  --port <port>       local port (default: 3939)
  --bind <address>    bind address (default: 127.0.0.1)
  --auth <user:pass>  basic auth for the node
  --op-rpc <url>      Optimism RPC (default: public endpoint)
  --fid <number>      use this FID instead of looking it up on Optimism

Environment
  READNODE_HOME       state directory (default: ~/.readnode)
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      fid: { type: "string" },
      username: { type: "string" },
      name: { type: "string" },
      region: { type: "string" },
      "instance-type": { type: "string" },
      "disk-gb": { type: "string" },
      "ssh-key": { type: "string" },
      "ssh-host": { type: "string" },
      host: { type: "string" },
      local: { type: "boolean" },
      "node-url": { type: "string" },
      "submit-url": { type: "string" },
      timeout: { type: "string" },
      port: { type: "string" },
      bind: { type: "string" },
      auth: { type: "string" },
      "op-rpc": { type: "string" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  const command = positionals[0];

  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }
  if (values.version) {
    process.stdout.write("readnode 0.1.0\n");
    return;
  }

  const number = (value: string | undefined): number | undefined =>
    value === undefined ? undefined : Number(value);

  switch (command) {
    case "provision":
      await provision({
        provider: values.provider,
        fid: number(values.fid),
        username: values.username,
        name: values.name,
        region: values.region,
        instanceType: values["instance-type"],
        diskGb: number(values["disk-gb"]),
        sshKey: values["ssh-key"],
        sshHost: values["ssh-host"],
        dryRun: values["dry-run"],
      });
      break;
    case "up":
      await up({
        host: values.host,
        local: values.local,
        sshKey: values["ssh-key"],
        nodeUrl: values["node-url"],
        timeoutSeconds: number(values.timeout),
      });
      break;
    case "status":
      await status({ nodeUrl: values["node-url"], json: values.json });
      break;
    case "client":
      await client({
        nodeUrl: values["node-url"],
        submitUrl: values["submit-url"],
        port: number(values.port),
        bind: values.bind,
        auth: values.auth,
        opRpc: values["op-rpc"],
        fid: number(values.fid),
      });
      break;
    default:
      process.stderr.write(`Unknown command "${command}".\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `\nError: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
