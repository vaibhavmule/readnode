# readnode

Run your own Farcaster read node, then use a client that reads from it.

No API keys from anyone. You supply the compute and nothing else.

## Quickstart

```bash
# 0. Provision the compute
readnode provision --provider aws --username yourname

# 1. Install and sync the Snapchain read node
readnode up

# 2. Open the client
readnode client        # → http://127.0.0.1:3939
```

The client imports your seed phrase, issues itself a **gasless** app key (no
Optimism transaction, no gas), and then reads the feed, posts casts, follows,
reacts, and filters casts by which client posted them.

The long-form version — every protocol concept, every failure mode, and the
seed phrase safety section — is in [`docs/tutorial.md`](docs/tutorial.md) and at
the microsite.

## Requirements

A read node needs **16 GB RAM, 4 CPU, 2 TB of disk and a public IP** with ports
3381–3383 reachable. Expect roughly **$50–70 of cloud spend for a one-week run**.

The 2 TB is not the database — the database is about 550 GB. It is the
`.rocks.snapshot/` scratch directory, which holds a second copy of the state
while the snapshot downloads and decompresses. One terabyte fills up mid-sync
and the node dies.

You also need a Farcaster account that **already has storage rented**. Storage is
paid onchain; this tool does not rent it for you.

## Providers

```bash
readnode provision --provider aws       # EC2, the provider the official guide uses
readnode provision --provider gcp       # cheaper block storage
readnode provision --provider hetzner   # Hetzner Cloud + volume
readnode provision --provider ssh --ssh-host ubuntu@1.2.3.4
readnode provision --provider local     # on this machine
readnode provision --dry-run            # print every command, run none
```

`--dry-run` prints the exact API calls, so you can review the plan before
spending anything.

## Commands

| Command | What it does |
| --- | --- |
| `readnode provision` | Create the compute, install Docker, seed the node config |
| `readnode up` | Install and start Snapchain, then wait until `blockDelay` is single-digit |
| `readnode status` | Node version, state size, per-shard height and sync lag |
| `readnode client` | Serve the local client on `127.0.0.1:3939` |

## Repo layout

```
packages/readnode          the CLI, the protocol logic and the client UI
  src/core                 gasless keys, message builders, node client, client identity
  src/commands             provision / up / status / client
  src/client               feed builder and HTTP server
  public                   client UI (plain HTML/CSS/JS)
docs/tutorial.md           the full tutorial
site                       microsite source
```

## Security

The client holds your seed phrase **in memory only**, long enough to sign one
delegation. It is never written to disk. The app key it derives is scoped,
time-limited and revocable — that is the whole point of a delegated signer.

Test with a throwaway account, and only paste a seed phrase into software from
developers you trust.

## License

MIT. See [`LICENSE`](LICENSE).
