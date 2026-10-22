# Read from your own Farcaster node

Run your own Snapchain read node and a client that reads from it. Your feed and
your posts go through your node. The only outside services the tool calls are
the fnames registry and a public Optimism RPC, both to look up your FID.

---

## Quickstart

Three commands. You need a Farcaster account that already has storage rented —
use a test account ([how to get one](#before-you-start-a-test-account)).

First install the CLI (Node 20.11+). For the AWS provider you also need the
[AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
with credentials configured (`aws configure`).

```bash
git clone https://github.com/vaibhavmule/readnode.git && cd readnode
npm install && npm run build -w readnode
npm install -g ./packages/readnode    # puts `readnode` on your PATH
```

Then:

```bash
# 0. Provision the compute (us-east-1 by default: that is where the peers are)
readnode provision --provider aws --username yourname

# 1. Install the read node and wait for it to sync
readnode up

# 2. Open the client
readnode client
```

`--username` takes a Farcaster username. For an ENS name like `alice.eth`, pass
`--fid <number>` instead.

`readnode provision` creates the machine and installs Docker. `readnode up`
installs Snapchain, starts it, and blocks until the node catches up to the head
of the chain. `readnode client` serves the client on
`http://127.0.0.1:3939` — import your seed phrase there, issue an app key, and
you can read the feed, post, follow and react.

Things to expect:

- `up` will sit for **about two to three hours** on the first run. The machine
  is downloading and unpacking a snapshot of the network's state, which ends up
  around 560 GB. Once Snapchain starts, `up` keeps waiting while the node
  catches up from the snapshot to the head of the chain. The snapshot can be up
  to a day old, so this takes anywhere from minutes to around half a day; the
  client can read from the node while it catches up. Ctrl-C is safe at any
  point: run `readnode up` again to keep watching.
- Keep the default region, `us-east-1`. Nearly every Snapchain peer is in AWS
  us-east-1, and a read node fetches blocks from peers one at a time, so
  catch-up speed is set by round-trip time to them. A node in Mumbai closed
  the gap by only about 1.8 seconds per second, so a day-old snapshot took it
  over half a day to catch up; expect much better next to the peers.
- No API key from anyone. You need a cloud account to rent the machine, and the
  cloud bill is the only cost.

---

## What you just built

Two halves that talk to each other:

```
        ┌──────────────────────────────┐
        │  your Snapchain read node    │   reads: feed, casts, reactions
        │  :3381 HTTP   :3383 gRPC     │   writes: relayed to validators
        └──────────────────────────────┘
                    ▲            │
        reads ──────┘            └────── writes
                    │                      │
        ┌──────────────────────────────┐   │
        │  your client  :3939          │   │
        │  holds a scoped app key      │───┘
        └──────────────────────────────┘
```

The rest of this tutorial explains why it is shaped that way.

---

## Before you start: a test account

The client needs the seed phrase of a Farcaster account that already has
storage. Make a new account for this. Do not use your main one.

New accounts made in the Farcaster app sign in with a passkey and never show
you a seed phrase, so the simplest way to get one is to register a fresh FID
onchain. The repo has a script for that. It costs about **$0.20 of ETH on
Optimism** (one FID with one unit of storage, plus gas):

```bash
node packages/readnode/scripts/register-test-account.mjs
# → creates a throwaway wallet, saves its seed phrase to
#   ~/.readnode/test-account.json (mode 0600), prints its address

# send ~0.0005 ETH on Optimism to that address, then:
node packages/readnode/scripts/register-test-account.mjs register
# → calls IdGateway.register(), prints your new FID
```

The seed phrase in `~/.readnode/test-account.json` is the one you import into
the client. The account has no username; the client shows it by FID. If you
already have an account that was created with a seed phrase (an older Warpcast
account, or one you registered yourself), you can use that instead, as long as
you would not mind losing it.

To do the registration by hand, the official
[create an account](https://docs.farcaster.xyz/developers/guides/accounts/create-account)
guide walks through `IdGateway` and the `Bundler`.

---

## Part 1 · Farcaster is two systems

Farcaster keeps **identity onchain** and **data offchain**. Almost every
confusing thing about the protocol comes from that split, so start here.

**Onchain** — a handful of contracts on OP Mainnet (chain id 10). Three things
happen there: creating an account, paying for storage, and authorizing keys.
These are rare events, so they are allowed to be slow and cost gas.

**Offchain** — everything else: posts, follows, reactions, profile edits. This is
Snapchain, a peer-to-peer network of nodes. Fast, cheap, signed.

The bridge between the halves is a signature. A message is only valid if it was
signed by a key that an onchain contract says belongs to that account.

### FIDs

A **FID** is a Farcaster account number. It is a plain incrementing integer: `1`
is the `@farcaster` account. FIDs are issued by the `IdRegistry` contract on
Optimism.

The protocol is full of integer FIDs, but humans want names, so there is a
`fnames` registry that maps names to FIDs. It is offchain and public:

```bash
curl 'https://fnames.farcaster.xyz/transfers?name=farcaster'
curl 'https://fnames.farcaster.xyz/transfers/current?fid=1'
```

The first response gives you the FID. That is exactly what
`readnode provision --username yourname` does — no key, no account.

### Custody addresses

Each FID has a **custody address**: the Ethereum address that owns it. It can
transfer the FID, change recovery, and — this is the part that matters here —
**authorize and revoke keys**.

`IdRegistry` answers both directions:

```solidity
idOf(address)   → the FID owned by this address (0 if none)
custodyOf(fid)  → the address that owns this FID
```

Your seed phrase derives to one Ethereum address. If that address is not the
custody address of the FID you are using, nothing else in this tutorial will
work — you will get signature errors that look like the node is broken. The
client checks this on import and tells you if the match fails.

### App keys (signers)

**You do not sign messages with your custody key.** You sign them with an **app
key**, a separate Ed25519 keypair, and the custody key authorizes it once.

```
custody key (Ethereum, onchain, guarded)
      │  authorizes, once
      ▼
app key (Ed25519, offchain, scoped, expiring)
      │  signs
      ▼
casts, follows, reactions  →  Snapchain
```

A leaked app key can post as you until it is revoked or expires. It cannot
transfer the FID or authorize other keys.

### Storage rent

Writing to Snapchain costs storage, and storage is rented **onchain**, per FID,
in units. Messages of different types consume different amounts — a cast and a
reaction are not the same price, and the exact ratios come from the node itself:

```bash
curl 'http://127.0.0.1:3381/v1/storageLimitsByFid?fid=1'
```

That returns each category with a `limit` and a `used` count.

Two consequences worth internalizing:

1. **Storage is a per-account limit, enforced by the protocol.** An FID with no
   storage cannot write at all. When a category is full, the node prunes the
   oldest messages in that category to make room for new ones.
2. **It is why this tutorial asks for an account that already has storage.**
   Renting storage means sending a transaction on Optimism. The client never
   sends a transaction; it only reads Optimism to look up your FID. (The
   test-account script sends exactly one, `IdGateway.register`, which rents
   the first unit of storage along with the FID.)

### Snapchain messages

A message is the unit of everything offchain. It has three parts:

- **`data`** — the payload. Type (`CAST_ADD`, `REACTION_ADD`, `LINK_ADD`,
  `USER_DATA_ADD`, `KEY_ADD`, …), the `fid` that authored it, a timestamp, the
  body.
- **`hash`** — BLAKE3 over the serialized `data`, truncated to 20 bytes.
- **`signature` + `signer`** — an Ed25519 signature over the **hash**, and the
  public key that produced it.

So the order is: serialize `data`, hash it, sign the hash, attach both. The
signature is never part of what gets hashed.

Timestamps are **seconds since the Farcaster Epoch**, 2021-01-01 00:00:00 UTC —
not Unix time. A raw value like `182822400` is a normal 2026 timestamp. When
you print one, add `1609459200` first.

Over the HTTP API, hashes and public keys arrive as `0x`-prefixed hex and
signatures as base64. Over gRPC they are raw bytes. This trips people up when
they move a fixture from one to the other.

---

## Part 2 · The read node

Every Snapchain node runs the same binary. One config flag decides its role:

```toml
read_node = true    # a read node
read_node = false   # a validator
```

### Read node vs validator

| | Validator | Read node |
| --- | --- | --- |
| Who can run one | holders of a key in the validator set | anyone |
| Consensus | proposes and votes on blocks | never votes; syncs decided blocks from peers |
| Validator set | pulled from the onchain config registry | static, from `validators.toml` |
| `mempoolSize` in `/v1/info` | a real per-shard count | `4294967295` — "not reported" |
| Restarting it | removes a vote from every shard until it is back | safe whenever |

A validator holds a key in the **validator set**, which is permissioned: you
cannot join it by deciding to. A read node is the
role anyone can run: it subscribes to decided blocks, verifies the commit
certificate against the validator set, applies them, and serves the APIs. Same
state, slightly behind, no vote.

That is why this is the role the tutorial uses. It is also why restarting it is
free: no consensus is disturbed.

### Read nodes take writes, and have no mempool

`submitMessage` works on **both** roles. What differs is where the message goes
afterwards:

**Submitted to a validator** — the message enters that validator's mempool for
its shard. The validator also gossips it on the `mempool` topic, so any validator
can include it. A message submitted directly to a validator is still proposed by
that validator even if gossip drops it elsewhere.

**Submitted to a read node** — the read node has **no mempool of its own**. It
routes the message to a shard, validates it against that shard's state, gossips
it on the `mempool` topic, and keeps nothing. The message reaches a block only
when a validator picks it up from gossip. If that gossip is lost, the message is
gone and must be resubmitted.

So: a read node does accept your writes, and it does relay them. It just offers a
weaker guarantee than submitting to a validator directly.

The client reads from `--node-url` and, by default, submits to the same node. If
you have access to a validator's HTTP endpoint, split the two:

```bash
readnode client --submit-url https://<validator>:3381
```

Reads still come from your own node; casts, follows, reactions and the `KEY_ADD`
go to the validator. `--auth` applies to the read node only.

Either way, a `200` from `submitMessage` means **the message validated and was
accepted for relay** — not that it is in a block. To confirm inclusion, watch for
the `MERGE_MESSAGE` event or read the message back:

```bash
curl 'http://127.0.0.1:3381/v1/castsByFid?fid=<you>&pageSize=1&reverse=true'
```

This is also why `mempoolSize: 4294967295` in `/v1/info` is normal on a read
node. That is `u32::MAX`, meaning "not reported". It is not an overflow, and it
is not a symptom of a broken node.

### Why the hardware is what it is

**16 GB RAM / 4 CPU.** The node keeps the full mainnet state in RocksDB.

**2 TB of disk (the default).** The database itself is smaller than that:

```bash
curl -s localhost:3381/v1/info | jq '.dbStats.approxSize'
# ~557 GB
```

The extra space is for the first sync. The snapshot arrives as compressed
chunks, and for a while the chunks and the unpacked database sit on disk side by
side. Snapchain's own downloader keeps a whole second copy in
`.rocks.snapshot/`, about 1.1 TB at peak, so on a 1 TB disk it fills up mid-sync
and the node dies with an unhelpful error.

`readnode` fetches the snapshot itself, before Snapchain first starts, into
`.rocks.readnode/`. It unpacks each shard as soon as that shard has downloaded
and deletes its chunks, so the peak is lower: about **800 GB** on a real run.
1 TB therefore works with `readnode`, but leaves little room for the database to
grow; `--disk-gb 2048` is the safe default.

It fetches the snapshot itself for a second reason. The snapshot bucket
publishes a new snapshot for each shard once a day and deletes the old one
straight away. Snapchain's downloader reads the snapshot list once and then
takes hours to fetch the shards one after another, so a shard that rotates
before its turn returns 404. The node panics, restarts with a non-empty
database, skips the snapshot, and syncs that shard from genesis, which takes
days. `readnode` re-reads the list for each shard, starts a shard over if it
rotates mid-download, and fetches eight chunks at a time. Progress goes to
`/var/log/readnode-snapshot.log`, and `readnode up` prints it.

**Ports.** All three must be reachable from the internet:

| Port | Protocol | Use |
| --- | --- | --- |
| 3381 | TCP | HTTP API |
| 3382 | UDP | gossip, libp2p over QUIC |
| 3383 | TCP | gRPC API |

`3382/UDP` carries gossip between nodes, and it is the easiest one to forget,
because it is not TCP and you will never `curl` it. If you are behind a cloud
firewall *and* a host firewall, open it in both.

### Watching it sync

```bash
readnode status
curl -s localhost:3381/v1/info | jq
```

`blockDelay` is how many seconds a shard's newest block is behind the wall clock.
While the node catches up it counts down. Once every shard is in single digits,
you are in sync. `maxHeight` differs between shards because each shard is its own
chain — do not read a mismatch as a problem.

On a read node, a successful sync shows `Processed decided block` in the logs.
`Decided value with round` is a validator line; if you see it on a read node,
something is misconfigured.

---

## Part 3 · The client

### Step 1 — import the seed phrase

The client takes a BIP-39 seed phrase and derives the custody account from it:
the address, to look up your FID, and the private key, to sign the authorization
in step 2. The phrase is used for that request and never written to disk.

From the custody address it resolves your FID on Optimism with a public RPC
endpoint (no key), then confirms `custodyOf(fid)` is the same address. If it is
not, stop: you are about to authorize a key on an account you do not control.

### Step 2 — issue an app key

This used to require an Optimism transaction to `KeyGateway.add()`. It does not
anymore. Snapchain accepts **gasless signers**: you register the key by
submitting a `KEY_ADD` message to a node. No transaction, no gas, about a second.

A `KEY_ADD` is unusual because it carries **two EIP-712 signatures plus the
message envelope's own signature**, and each does a different job:

1. **`SignedKeyRequest`, from the requesting app.** Binds the app's `requestFid`
   to the key, so an app cannot claim another app's identity. This is
   ABI-encoded into the body's `metadata` field.
2. **`KeyAdd`, from the custody address of the FID receiving the key.** This is
   the actual authorization. It covers the **scopes, the TTL and the nonce**, so
   none of them can be altered in flight.
3. **The envelope signature**, produced by the new Ed25519 key itself — proof
   that whoever is submitting the `KEY_ADD` actually holds the private key. This
   is why `KEY_ADD` is exempt from the usual "the signer must already be
   registered" check.

**The trap.** There are two functions that look interchangeable and are not:

- `getSignedKeyRequestMetadata()` signs the **onchain**
  `Farcaster SignedKeyRequestValidator` domain — chain id 10, with a
  `verifyingContract`.
- `getGaslessSignedKeyRequestMetadata()` signs the **offchain** counterpart.

If you build the metadata with the first one and submit it as a `KEY_ADD`,
Snapchain rejects it. Use `makeKeyAddBody()`, which picks the off-chain variant
for you.

Gasless keys differ from the old onchain ones in three ways:

**Scopes.** Every gasless key declares the message types it may sign. A key
scoped to `CAST_ADD` cannot publish a `LINK_ADD`. This client requests the set it
actually needs:

```
cast:add, cast:remove, reaction:add, reaction:remove,
link:add, link:remove, user-data:add,
verification:add, verification:remove
```

`KEY_ADD` and `KEY_REMOVE` are **never** admissible scopes. A signer cannot mint
or revoke another signer — if that were possible, one leaked app key would be
able to grant itself unlimited successors. Onchain signers predate scoping and
have no scopes.

**Sliding TTL.** Each key carries a TTL of up to 90 days; this client asks for
30. The TTL resets every time the key signs a message that merges, so a key in
use stays alive and an abandoned one expires on its own.

**Nonces.** Each FID has a monotonically increasing user nonce. Every `KEY_ADD`
must carry a nonce strictly greater than the FID's current value, which makes an
intercepted authorization unreplayable. Read the current value first:

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<you>' | jq '.currentUserNonce'
```

Then submit `currentUserNonce + 1`. If you are writing retry logic: **a retry must
re-read the nonce.** Replaying the same signed `KEY_ADD` fails with
`nonce is not greater than stored nonce`, and so does a retry that reused the
old value.

Use `GET /v1/signersByFid`. The older `GetOnChainSignersByFid` returns onchain
keys only and is deprecated — it shows an empty list on an account whose only
keys are gasless.

A single FID can hold up to 1000 active gasless keys, counted separately from
onchain ones. Gasless signers are live on mainnet as of engine version **V16**.

### Step 3 — read, post, follow, react

Reads go to your node:

```bash
curl 'http://127.0.0.1:3381/v1/castsByFid?fid=<you>&pageSize=10&reverse=true'
curl 'http://127.0.0.1:3381/v1/userDataByFid?fid=<you>'
curl 'http://127.0.0.1:3381/v1/linksByFid?fid=<you>&link_type=follow'
curl 'http://127.0.0.1:3381/v1/reactionsByCast?target_fid=<them>&target_hash=0x…&reaction_type=Like'
```

Common parameters: `pageSize`, `pageToken`, `reverse=true`, and
`startTimestamp` / `stopTimestamp` on the endpoints that support them. Paging is
token-based — follow `nextPageToken` until it is empty.

Writes are built, signed with the app key, serialized, and POSTed as raw
protobuf bytes:

```bash
curl -X POST http://127.0.0.1:3381/v1/submitMessage \
  -H 'content-type: application/octet-stream' \
  --data-binary @message.encoded.protobuf
```

`Message.encode(msg).finish()` produces those bytes. Note the content type: the
endpoint does **not** accept JSON.

### Step 4 — include or exclude casts by client

Farcaster does not put a client name in a message, so how do you tell which app
posted a cast?

Through the app key that signed it. Every cast is signed by an app key, and every **gasless** app key carries a `requestFid` — the FID of the app
that requested it, taken from the `SignedKeyRequest` metadata that was verified
when the key was registered.

So: `cast.signer` → the author's key list → `requestFid` → which client.

```bash
curl 'http://127.0.0.1:3381/v1/signersByFid?fid=<author>' | jq '.signers[] | {key, requestFid, scopes, expiresAt}'
```

The client resolves this for every author in your feed and labels each cast. Then
"only show my client" and "hide that client" are simple filters on `requestFid`.

Two limits:

- Keys registered the old way, **onchain**, have no `SignedKeyRequest` metadata
  and therefore no `requestFid`. They can only be identified by their key. The
  client falls back to showing `key:0x…` for those.
- None of this is proof that a human used an app. It says which app's key signed
  the message, which is the strongest claim the protocol actually supports.

---

## Seed phrase safety

The client asks for your seed phrase once, to authorize its app key. Know what
you are handing over before you paste it.

The seed phrase derives your custody address, and the custody address owns your
FID. Whoever has the phrase can transfer the FID, change its recovery address,
and add or revoke any key. Nobody can undo that for you.

So:

- **Use a test account for this tutorial.** See
  [Before you start](#before-you-start-a-test-account), or use an account you
  would not mind losing. Do not paste your main account's seed phrase into
  anything while following a tutorial.
- **Only paste a seed phrase into software from developers you trust** — and,
  ideally, software you can inspect. This client is open source, and the part
  that touches the seed is a few dozen lines.
- **Prefer delegated signer authorization.** This client uses the seed phrase
  to sign one delegation: an app key that is scoped (it cannot add other keys),
  expires after 30 days unused, and can be revoked with a `KEY_REMOVE`. Posting,
  following and reacting use only that key. The seed phrase is needed again only
  if you revoke the key from the client.
- **Never paste a seed phrase into a web page you did not start yourself.** This
  client binds to `127.0.0.1` by default for exactly that reason. If you pass
  `--bind 0.0.0.0`, you have published your seed phrase input box to your
  network.
- **Revoke keys you are done with.** Deleting the signer file does not revoke
  the key: anyone with a copy can keep using it, and each use extends its life.
  Revoke it from the client, which sends a `KEY_REMOVE`. A key nobody uses
  expires after 30 days.

---

## Troubleshooting

**`up` has been running for hours.** Expected on first run. The snapshot is
several hundred GB, and after it Snapchain catches up from the snapshot's age.
`readnode status` shows the countdown; `blockDelay` in single digits means done.
If it is counting down slowly, check the region: far from us-east-1, every
block fetch pays the round trip.

**The node died mid-sync, disk full.** You used a 1 TB disk with Snapchain's own
snapshot downloader, which needs room for a second copy of the state. Use 2 TB,
or let `readnode` fetch the snapshot.

**One shard's `blockDelay` is enormous and barely moving.** That shard is syncing
from genesis, usually because its snapshot rotated during Snapchain's own
download (see *Why the hardware is what it is*). On the node, fetch it again:

```bash
cd ~/snapchain && sudo docker compose down
sudo rm -rf .rocks && sudo readnode-snapshot "$PWD/.rocks"
sudo docker compose up -d
```

**`KEY_ADD` rejected for its nonce** (`nonce is not greater than stored nonce`). Another `KEY_ADD` or `KEY_REMOVE`
landed first. Re-read `currentUserNonce` and submit a higher value. Never retry
with the same nonce.

**`KEY_ADD` rejected for its signature.** The `KeyAdd` signature did not recover the
FID's custody address. Check that the seed phrase you imported derives to the
address that `idOf()` returns.

**`KEY_ADD` rejected for its metadata.** Your metadata may have used the onchain
`SignedKeyRequestValidator` domain. Build it with `makeKeyAddBody()`, which signs
the off-chain domain.

**`KEY_ADD` rejected for its scopes.** `KEY_ADD` and `KEY_REMOVE` can never be scopes. Anything
outside the admissible set is rejected.

**`mempoolSize` is `4294967295`.** Normal on a read node. It means "not
reported".

**The cast was accepted but never appeared.** You got validation, not inclusion.
On a read node, the message depends on gossip reaching a validator. Submit again,
or restart the client with `--submit-url` pointing at a validator for a stronger
guarantee.

**Writes rejected for storage.** The FID has no storage rented. Check
`/v1/storageLimitsByFid`. Storage is rented onchain; this tool does not rent it.

**A subscriber missed events.** Events are pruned after 3 days by default
(`pruning.event_retention`). A subscriber resuming from an event id older than
the retention window gets nothing and must backfill from the message APIs.

---

## Cost

For a one-week run on AWS `m5.xlarge` + 2 TB gp3:

| Line item | Rate | 7 days |
| --- | --- | --- |
| EC2 `m5.xlarge` | $0.192/hr | $32.26 |
| EBS gp3 2 TB | $0.08/GB-month | $37.71 |
| Public IPv4 | $0.005/hr | $0.84 |
| Snapshot download | inbound is free | $0.00 |
| **Total** | | **≈ $70** |

Storage is billed by the calendar, not by usage, so it dominates and it keeps
charging while the instance is stopped. Let it run a full month and the volume
alone is $164. Delete the volume when you are done.

Cheaper shapes for a short run:

- **GCP** — the same machine with `pd-standard` at $0.04/GB-month instead of
  $0.08. About **$52** for the week.
- **Spot EC2** — roughly $0.07/hr, but interruption risk. Survivable here only
  because the database lives on EBS, not on instance store.
- **Run it for three days instead of seven** — about **$30**. Sync takes hours,
  not days, so the node does not need to exist all week.

The number to watch is the disk, not the CPU.

---

## Where the official docs drift

Two things were out of date while this was written, and both are corrected above:

1. `snapchain.farcaster.xyz/guides/writing-messages` notes that its linked
   `hello-world` example **still registers its signer onchain via the key
   gateway**. The gasless flow in that guide's step 3 replaces it and needs no
   ETH.
2. `GetOnChainSignersByFid` returns onchain keys only. Use
   `GetSignersByFid` / `GET /v1/signersByFid`, which returns both kinds in one
   list, plus `currentUserNonce` and the per-FID gasless limits.

Point 1 is a live example in
[`farcasterxyz/hub-monorepo`](https://github.com/farcasterxyz/hub-monorepo). If
you are reading this and it still applies, a pull request is welcome — that
repository is the canonical place for it.

---

## References

The four sources the bounty cites, plus the two pages that superseded parts of
them. Read these when this tutorial and reality disagree.

1. [Farcaster architecture overview](https://docs.farcaster.xyz/learn/architecture/overview)
   — the two systems: onchain registries on Optimism, messages on Snapchain.
2. [Hello world](https://docs.farcaster.xyz/developers/guides/basics/hello-world)
   — the canonical first client. It still registers its signer onchain; see
   *Where the official docs drift*.
3. [Running a Snapchain node](https://snapchain.farcaster.xyz/guides/running-a-node)
   — hardware, ports and the official install script that `readnode up` wraps.
4. [Snapchain HTTP API](https://docs.neynar.com/snapchain/httpapi/httpapi.md)
   — every `/v1/` endpoint the client calls.
5. [Node types](https://snapchain.farcaster.xyz/node-types) — read nodes vs
   validators, and why a read node relays writes.
6. [Writing messages](https://snapchain.farcaster.xyz/guides/writing-messages)
   — the gasless `KEY_ADD` flow used in Part 3.
