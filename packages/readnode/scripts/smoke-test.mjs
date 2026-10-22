#!/usr/bin/env node
// End-to-end check of `readnode client` against a real node, driving the same
// HTTP API the UI uses: import the seed phrase, issue a gasless app key, post,
// follow, react, then read the feed and filter it by client. Every write is
// confirmed by reading it back from the node, not just by the submit's 200.
//
//   readnode client &                          # in another terminal
//   node scripts/smoke-test.mjs [--client http://127.0.0.1:3939] [--follow <fid>]
//
// Uses the test account in ~/.readnode/test-account.json. It really posts.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? fallback : process.argv[i + 1];
};
const CLIENT = arg("--client", "http://127.0.0.1:3939");
const TARGET = Number(arg("--follow", "1"));
const { mnemonic } = JSON.parse(readFileSync(join(homedir(), ".readnode", "test-account.json"), "utf8"));

async function api(path, body, method = body ? "POST" : "GET") {
  const res = await fetch(CLIENT + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json;
}

let NODE;
async function node(path) {
  const res = await fetch(`${NODE}/v1/${path}`);
  return res.ok ? res.json() : null;
}

async function until(label, check, seconds = 180) {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) {
      console.log(`  ok  ${label} (${((Date.now() - start) / 1000).toFixed(0)} s)`);
      return value;
    }
    if (Date.now() - start > seconds * 1000) throw new Error(`timed out: ${label}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const state = await api("/api/session", { mnemonic });
NODE = state.nodeUrl;
const fid = state.fid;
console.log(`node ${NODE}, fid ${fid}, custody ${state.custodyAddress}`);
if (!state.custodyMatches) throw new Error("custody address does not own this FID");
const casts = state.storage?.find((s) => s.name === "CASTS");
if (!casts?.limit) throw new Error("node shows no storage for this FID yet (still syncing?)");
console.log(`  ok  seed imported, custody matches, ${casts.limit} cast slots`);

const withSigner = state.signer ? state : await api("/api/signer", { mnemonic });
const key = withSigner.signer.publicKey;
await until(`app key ${key.slice(0, 10)}… registered (requestFid ${withSigner.signer.requestFid})`, async () =>
  (await node(`signersByFid?fid=${fid}`))?.signers?.some((s) => s.key.toLowerCase() === key.toLowerCase()),
);

const text = `Hello from readnode: posted through my own Snapchain read node, ${new Date().toISOString().slice(0, 16)}Z`;
const { hash: castHash } = await api("/api/cast", { text });
await until(`cast ${castHash.slice(0, 10)}… on the node`, () => node(`castById?fid=${fid}&hash=${castHash}`));

await api("/api/follow", { fid: TARGET });
await until(`follow of fid ${TARGET} on the node`, async () =>
  (await node(`linksByFid?fid=${fid}&link_type=follow&reverse=true&pageSize=100`))?.messages?.some(
    (m) => m.data.linkBody.targetFid === TARGET,
  ),
);

const theirs = (await node(`castsByFid?fid=${TARGET}&pageSize=1&reverse=true`))?.messages?.[0];
if (theirs) {
  await api("/api/react", { fid: TARGET, hash: theirs.hash, type: "Like" });
  await until(`like of ${theirs.hash.slice(0, 10)}… on the node`, async () =>
    (await node(`reactionsByFid?fid=${fid}&reaction_type=Like&reverse=true&pageSize=100`))?.messages?.some(
      (m) => m.data.reactionBody.targetCastId.hash === theirs.hash,
    ),
  );
}

const { entries } = await api("/api/feed?limit=50");
const own = entries.find((e) => e.hash === castHash);
if (!own) throw new Error("own cast missing from the feed");
console.log(`  ok  feed has ${entries.length} casts from ${new Set(entries.map((e) => e.clientId)).size} clients; ours is ${own.clientId}`);

await api("/api/filter", { include: [own.clientId], exclude: [] });
const included = (await api("/api/feed?limit=50")).entries;
await api("/api/filter", { include: [], exclude: [own.clientId] });
const excluded = (await api("/api/feed?limit=50")).entries;
await api("/api/filter", { include: [], exclude: [] });
if (!included.length || !included.every((e) => e.clientId === own.clientId)) throw new Error("include filter leaked");
if (excluded.some((e) => e.clientId === own.clientId)) throw new Error("exclude filter leaked");
console.log(`  ok  include ${own.clientId}: ${included.length} casts; exclude it: ${excluded.length} casts`);

console.log("\nAll checks passed.");
