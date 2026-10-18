# Farcaster Client Bounty — balajis.eth ($2,048)
Source: https://farcaster.xyz/balajis.eth/0x50184b62 (posted Oct 17, 2026, 8:17 PM IST)
Deadline: 7 days exactly from post time (Oct 24, 2026, 8:17 PM IST)
Prizes: $2,048 1st, $512 2nd, $128 honorable mentions (USDC to Farcaster wallet)

## Goal: get it down to 3 commands (quickstart + detailed tutorial)
0. Provision compute via script
1. Set up a Snapchain read node (runs on its own, no API keys)
2. Create a client that reads from that node

## Client must
- Read from own read node; writes go via the read node, which relays to validators (explain how)
- Import existing seed phrase (account with storage)
- Issue its own app key (gasless `KEY_ADD`, no Optimism tx — see clarification 2)
- Read feed, post casts, follow, react, include/exclude casts from other clients

## Clarifications (balajis.eth, ~3h after the post; cc @10xchris.eth)
1. Read nodes *do* take writes and forward them to validators (docs updated the week before: snapchain.farcaster.xyz/node-types).
2. App keys are gasless — no Optimism transaction (snapchain.farcaster.xyz/guides/writing-messages, updated ~2 months earlier).
3. It is a *developer* tutorial: treat seed phrases like `rm -rf`. Say: use a test account, only paste seed phrases into software from devs you trust, prefer delegated signer authorization.
- Outdated docs found along the way → PRs to github.com/farcasterxyz repos (not AI slop). "Will definitely help with prize-winning."

## Tutorial must
- Mobile + desktop friendly microsite, quickstart at top
- Explain: FIDs, custody addresses, app keys, Snapchain messages, read nodes vs validators, storage rent
- NOT AI slop
- Extras: Chinese translation, 59s vertical video

## To qualify
- At least one other human runs the tutorial end to end and publicly vouches on Farcaster

## Submit (reply to the post with 3 URLs)
1. Microsite (quickstart + tutorial)
2. GitHub repo, MIT licensed
3. Voucher's public Farcaster endorsement

## Prior art
- https://github.com/0xterricola/farcaster-wallet-client (won 10xchris.eth's client bounty)

## Citations from the post
1. https://docs.farcaster.xyz/learn/architecture/overview
2. https://docs.farcaster.xyz/developers/guides/basics/hello-world
3. https://snapchain.farcaster.xyz/guides/running-a-node
4. https://docs.neynar.com/snapchain/httpapi/httpapi.md
