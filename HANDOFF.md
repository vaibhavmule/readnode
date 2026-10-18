# Handoff

State of the `readnode` submission as of the first build. Read the
**Not verified** section before trusting anything.

---

## Status at a glance

| | |
| --- | --- |
| Deadline | Oct 24, 2026, 20:17 IST (7 days from post) |
| Repo | local only, 1 commit on `main`, no remote |
| Code | ~2,500 lines TS + ~2,400 lines UI/site |
| Verified against | a mock node. **Not against Snapchain, Optimism, or any cloud.** |
| Voucher | not recruited — this is the qualification bar |

---

## What exists

`readnode` is a CLI with three commands and a local client:

```
readnode provision --provider aws --username yourname
readnode up
readnode client
```

- **Protocol core** (`packages/readnode/src/core/`) — gasless `KEY_ADD`
  construction, scoped/TTL/nonced signers, message builders, Snapchain HTTP
  client, `requestFid` client-identity resolution, Optimism custody checks
- **Providers** — aws / gcp / hetzner / ssh / local, all with `--dry-run`
- **Client** — Express-free `node:http` server + plain HTML/CSS/JS UI
- **Tutorial** — `docs/tutorial.md`, `docs/tutorial.zh-CN.md`, `docs/video-59s.md`
- **Microsite** — `site/`, builds to `site/dist/` for Cloudflare Pages

## Run it locally

```bash
npm install
npm run build

node packages/readnode/dist/cli.js --help
node packages/readnode/dist/cli.js provision --provider aws --fid 1356870 --dry-run
node packages/readnode/dist/cli.js status --node-url http://127.0.0.1:3381
node packages/readnode/dist/cli.js client --node-url http://127.0.0.1:3381

npm run build -w readnode-site      # → site/dist/index.html + site/dist/zh/
```

Nothing above spends money. `--dry-run` prints every provider API call.

---

## Verified

- **Gasless `KEY_ADD`, offline.** Custody derives to `0xf39F…2266` from the
  standard test mnemonic; body carries a 65-byte custody EIP-712 signature and
  288-byte `SignedKeyRequest` metadata; encodes as message type 16; 998 bytes;
  hash round-trips.
- **Client end-to-end against a mock Snapchain node.** `/api/health`,
  `/api/session`, `/api/feed`, and include/exclude filtering all behave.
  `requestFid` resolution correctly turned client A into `fid:111`, and left an
  onchain signer as `key:0xbbb…` (onchain keys have no request metadata — that is
  correct, not a bug).
- **CLI + provisioning.** Full AWS plan prints under `--dry-run`; generated
  `cloud-init.sh` passes `bash -n`.
- **Typecheck + build** clean across both workspaces.
- **Site build.** 22 headings, quickstart at the top, both locales.

## Not verified — the honest list

1. **No real Snapchain node has ever been contacted.** Reads, writes,
   `submitMessage`, and sync behaviour are untested against real infrastructure.
2. **No real Optimism RPC call.** `checkCustody()` and `fidForAddress()` have
   never run against mainnet.
3. **Provider CLIs never executed** — only dry-run. `aws` / `gcloud` / `hcloud`
   flag names may have drifted.
4. **`up`'s install path never ran.** The Snapchain bootstrap is interactive by
   default; I pre-seed `.env` with `AGREE_NO_REWARDS_FOR_ME` and
   `HUB_OPERATOR_FID` so it should not prompt — unconfirmed.
5. **A real `KEY_ADD` has never been submitted**, so the two-signature body has
   never survived Snapchain's own validation.
6. **Microsite not deployed.** The hero's GitHub link is a placeholder.

7. **Tutorial claims to check on the real-box run** (stated in the copy, not yet
   observed):
   - the read-node vs validator table: validator set from the onchain registry
     vs `validators.toml`; "restarting removes a vote"
   - Troubleshooting error strings, especially `nonce is not greater than stored
     nonce`; the other headings were reworded to describe the rejection instead
   - storage: no-storage FID rejected; full category prunes oldest messages
   - snapshot size and the ~1.1 TB peak; `Processed decided block` log line
   - test-account section: the Farcaster app's signup cost and where it shows
     the recovery phrase

---

## Queued changes (offered, not started)

1. **Wallet-signer path.** Let the client generate the keypair, hand out an
   EIP-712 payload, and accept a signature back, so the custody key never enters
   the client at all. This is the literal reading of Balaji's *"use delegated
   signer authorization whenever possible"*. `makeKeyAddBody` already takes a
   separate `requestSigner`, so this is one route plus a UI panel.
2. **ENS fallback for `--username`.** `balajis.eth` returns *no such fname* from
   the fnames registry because `.eth` names live elsewhere. The judge's own
   handle breaks the flag. At minimum the error should say "use `--fid`".
3. **Seed phrase re-entry on revoke.** `DELETE /api/signer` asks for the mnemonic
   again, so the DOM holds it for the whole session. Fine, but it undercuts the
   "used once" story the tutorial tells.

---

## Remaining work, ranked

1. **Run it end to end on a real box.** Everything downstream is cheap; only the
   cloud + Snapchain path is unproven, and all three commands depend on it.
   ~$70, expect a several-hour first sync.
2. **Recruit the voucher.** Balaji: more vouchers is the strongest signal. The
   voucher must create a node *and* a client, not just read the tutorial.
3. Wallet-signer path (strengthens the security section materially).
4. Deploy the microsite to Cloudflare Pages — free, and the node's HTTP API can
   be fronted by a Tunnel so `:3381` is never exposed raw.
5. Upstream PR to `farcasterxyz/hub-monorepo` — the `hello-world` example still
   registers its signer onchain. Balaji said this "will definitely help with
   prize-winning".
6. Record the 59s video from `docs/video-59s.md`.

---

## Protocol facts worth not re-deriving

Hard-won, and several contradict older documentation.

**Read nodes vs validators**

- Both roles accept `submitMessage`. A validator keeps it in its mempool and
  proposes it; a read node validates, gossips, and **keeps nothing**. Success
  means "validated for relay", not "in a block". Watch `MERGE_MESSAGE`.
- `mempoolSize: 4294967295` in `/v1/info` means "not reported" on a read node.
  It is not an overflow.
- Ports: **3381 TCP** HTTP, **3382 UDP** gossip (libp2p/QUIC), **3383 TCP** gRPC.
  All three must be internet-reachable; `3382/UDP` is the easy one to miss.
- **2 TB of disk is required, not advised.** The DB is ~550 GB
  (`.rocks/`), but `.rocks.snapshot/` holds a second copy during
  download+decompress → ~1.1 TB peak. 1 TB dies mid-sync.

**Gasless app keys**

- Registered by submitting a `KEY_ADD` message to a node. No transaction, no gas,
  ~1 second. Live on mainnet since engine **V16**.
- Three signatures: `SignedKeyRequest` from the requesting app (ABI-encoded into
  `metadata`), `KeyAdd` from the **custody** address, and the envelope signed by
  the new Ed25519 key itself — which is why `KEY_ADD` is exempt from the usual
  "signer must already be registered" check.
- **Trap:** `getSignedKeyRequestMetadata()` signs the **onchain** domain
  (chainId 10, `verifyingContract`) and Snapchain *rejects* it. Use
  `makeKeyAddBody()` / `getGaslessSignedKeyRequestMetadata()`.
- Scopes: `MAX_KEY_ADD_SCOPES = 16`; `KEY_ADD`/`KEY_REMOVE` are **never**
  admissible. TTL max 90 days, sliding, refreshed on use. 1000 gasless keys per
  FID. Nonce strictly greater than `currentUserNonce` — **and a retry must
  re-read the nonce**, or you get `nonce is not greater than stored nonce`.
- Read nonces from `GET /v1/signersByFid`. `GetOnChainSignersByFid` is deprecated
  and returns onchain keys only — an empty list on a gasless-only account.

**Client identity (the "filter by client" requirement)**

- There is no client name in a message. The real mechanism: `cast.signer` →
  author's key list → `Signer.requestFid`, the *verified* `requestFid` from the
  `SignedKeyRequest` metadata. That identifies which app asked for the key.
- Onchain keys have no request metadata, so they can only be identified by key.
  The client degrades to `key:0x…` for those.

**Misc**

- Timestamps are seconds since the **Farcaster epoch** (2021-01-01 UTC) —
  add `1609459200` before printing.
- The hash is over `data` only; the signature is attached after.
- HTTP responses: hashes/keys hex `0x…`, signatures base64. gRPC returns raw bytes.
- `submitMessage` wants `content-type: application/octet-stream` and raw protobuf.
- Storage limits are per category — `/v1/storageLimitsByFid?fid=`. Storage is
  rented onchain; this tool deliberately does not rent it.
- Events are pruned after 3 days by default, so a lagging subscriber must
  backfill from the message APIs.
- `@farcaster/hub-nodejs@0.17.0` re-exports `@farcaster/core@0.20.0`, which is
  where the whole gasless API actually lives.
- Farcaster's own node is now `crackle.farcaster.xyz:3383` (password-gated),
  replacing `hoyt.farcaster.xyz` in the older docs.

---

## File map

```
packages/readnode/
  src/core/        signer.ts (gasless KEY_ADD) · node.ts (HTTP client)
                   clients.ts (requestFid identity) · messages.ts · custody.ts
                   farcasterId.ts (Optimism) · scopes.ts · result.ts
  src/commands/    provision · up · status · client
  src/client/      feed.ts · server.ts
  src/             providers.ts · cloud-init.ts · state.ts · exec.ts · fnames.ts
  public/          index.html · app.js · styles.css
docs/              tutorial.md · tutorial.zh-CN.md · video-59s.md
site/              build.mjs · template.html · public/styles.css
```

Secrets: `~/.readnode/signer.json` holds the **app key** (mode `0600`).
`state.json` holds provider/host/FID. **No seed phrase is ever written to disk** —
`mnemonic` appears in only `custody.ts` and three request handlers, none of which
persist.
