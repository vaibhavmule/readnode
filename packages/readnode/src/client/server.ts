import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLIENT_SCOPES,
  ClientDirectory,
  Publisher,
  SIGNER_TTL_SECONDS,
  SnapchainNode,
  checkCustody,
  custodyAccountFromMnemonic,
  describeScopes,
  registerGaslessSigner,
  revokeGaslessSigner,
  signerFromPrivateKey,
  type ClientFilter,
  type GaslessSigner,
  type NodeAuth,
} from "../core/index.js";
import { FeedBuilder, type Profile } from "./feed.js";
import { loadSigner, saveSigner } from "../state.js";

export interface ClientServerOptions {
  nodeUrl: string;
  /** Validator (or other node) to submit writes to. Defaults to the read node. */
  submitUrl?: string;
  port: number;
  host?: string;
  nodeAuth?: NodeAuth;
  opRpcUrl?: string;
  fid?: number;
}

interface Session {
  custodyAddress?: string;
  fid?: number;
  custodyMatches?: boolean;
  storage?: Record<string, { limit: number; used: number }>;
}

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > 1024 * 1024) throw new Error("Request body too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

export async function runClientServer(options: ClientServerOptions): Promise<void> {
  const node = new SnapchainNode(options.nodeUrl, options.nodeAuth);
  // --auth belongs to the read node; a separate submit endpoint gets none.
  const submitNode = options.submitUrl ? new SnapchainNode(options.submitUrl) : node;
  const directory = new ClientDirectory();
  const feed = new FeedBuilder(node, directory);
  const session: Session = {};
  let filter: ClientFilter = { include: [], exclude: [] };

  const stored = await loadSigner();
  let signer: GaslessSigner | null = stored
    ? {
        privateKey: Buffer.from(stored.privateKey.replace(/^0x/, ""), "hex"),
        publicKey: Buffer.from(stored.publicKey.replace(/^0x/, ""), "hex"),
        publicKeyHex: stored.publicKey,
        scopes: stored.scopes as GaslessSigner["scopes"],
        ttl: stored.ttl,
        expiresAt: stored.expiresAt,
        requestFid: stored.requestFid,
        nonce: 0,
        keyAddHash: "restored",
      }
    : null;

  function requireSigner(): GaslessSigner {
    if (!signer) throw new Error("No app key yet. Import your seed phrase first.");
    return signer;
  }

  function requireFid(): number {
    if (!session.fid) throw new Error("No FID loaded. Import your seed phrase first.");
    return session.fid;
  }

  function publisher(): Publisher {
    const active = requireSigner();
    return new Publisher({
      node: submitNode,
      fid: requireFid(),
      signer: signerFromPrivateKey(active.privateKey),
    });
  }

  async function statePayload(): Promise<unknown> {
    return {
      nodeUrl: options.nodeUrl,
      submitUrl: options.submitUrl ?? options.nodeUrl,
      custodyAddress: session.custodyAddress ?? null,
      fid: session.fid ?? null,
      custodyMatches: session.custodyMatches ?? null,
      storage: session.storage ?? null,
      scopes: CLIENT_SCOPES.map((scope) => scope as number),
      scopeNames: describeScopes(CLIENT_SCOPES),
      signer: signer
        ? {
            publicKey: signer.publicKeyHex,
            requestFid: signer.requestFid,
            scopes: describeScopes(signer.scopes as number[]),
            expiresAt: signer.expiresAt,
            ttlSeconds: signer.ttl,
            keyAddHash: signer.keyAddHash,
          }
        : null,
      filter,
      clients: directory.all().map((client) => ({
        ...client,
        label: directory.labelFor(client.id),
      })),
    };
  }

  async function handleApi(
    pathname: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<boolean> {
    const method = request.method ?? "GET";

    if (pathname === "/api/health" && method === "GET") {
      try {
        const info = await node.info();
        sendJson(response, 200, {
          ok: true,
          version: info.version,
          shardInfos: info.shardInfos,
        });
      } catch (error) {
        sendJson(response, 200, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return true;
    }

    if (pathname === "/api/state" && method === "GET") {
      sendJson(response, 200, await statePayload());
      return true;
    }

    if (pathname === "/api/session" && method === "POST") {
      const body = await readBody(request);
      const mnemonic = String(body.mnemonic ?? "");
      if (!mnemonic) throw new Error("Seed phrase is required.");
      const custody = custodyAccountFromMnemonic(mnemonic);
      session.custodyAddress = custody.address;
      try {
        const check = await checkCustody(custody.address, options.opRpcUrl);
        session.fid = check.fid > 0 ? check.fid : options.fid;
        session.custodyMatches = check.fid > 0 ? check.matches : undefined;
      } catch {
        session.fid = options.fid;
        session.custodyMatches = undefined;
      }
      if (session.fid) {
        try {
          const limits = await node.storageLimitsByFid(session.fid);
          session.storage = limits.limits;
        } catch {
          session.storage = undefined;
        }
      }
      sendJson(response, 200, await statePayload());
      return true;
    }

    if (pathname === "/api/session" && method === "DELETE") {
      session.custodyAddress = undefined;
      session.fid = undefined;
      session.custodyMatches = undefined;
      session.storage = undefined;
      sendJson(response, 200, await statePayload());
      return true;
    }

    if (pathname === "/api/signer" && method === "POST") {
      const fid = requireFid();
      if (!session.custodyAddress) {
        throw new Error("Import a seed phrase before issuing an app key.");
      }
      const body = await readBody(request);
      const mnemonic = String(body.mnemonic ?? "");
      if (!mnemonic) throw new Error("Seed phrase is required to authorize the app key.");
      const custody = custodyAccountFromMnemonic(mnemonic);
      signer = await registerGaslessSigner({ node, submitNode, fid, custody });
      await saveSigner({
        fid,
        privateKey: `0x${Buffer.from(signer.privateKey).toString("hex")}`,
        publicKey: signer.publicKeyHex,
        requestFid: signer.requestFid,
        scopes: signer.scopes as number[],
        ttl: signer.ttl,
        expiresAt: signer.expiresAt,
      });
      sendJson(response, 200, await statePayload());
      return true;
    }

    if (pathname === "/api/signer" && method === "DELETE") {
      const active = requireSigner();
      if (!session.custodyAddress) throw new Error("Import your seed phrase first.");
      const body = await readBody(request);
      const mnemonic = String(body.mnemonic ?? "");
      if (!mnemonic) throw new Error("Seed phrase is required to revoke the app key.");
      const custody = custodyAccountFromMnemonic(mnemonic);
      const result = await revokeGaslessSigner({
        node,
        submitNode,
        fid: requireFid(),
        custody,
        privateKey: active.privateKey,
      });
      signer = null;
      sendJson(response, 200, { revoked: true, hash: result.hash });
      return true;
    }

    if (pathname === "/api/feed" && method === "GET") {
      const url = new URL(request.url ?? "/", "http://localhost");
      const limit = Number(url.searchParams.get("limit") ?? 25);
      const includeReactions = url.searchParams.get("reactions") === "1";
      const entries = await feed.build(requireFid(), {
        limit,
        includeReactions,
        filter,
      });
      sendJson(response, 200, { entries, filter });
      return true;
    }

    if (pathname === "/api/cast" && method === "POST") {
      const body = await readBody(request);
      const text = String(body.text ?? "").trim();
      if (!text) throw new Error("Cast text is empty.");
      const parent =
        body.parentFid !== undefined && body.parentHash !== undefined
          ? { fid: Number(body.parentFid), hash: String(body.parentHash) }
          : undefined;
      const message = await publisher().cast(text, parent);
      sendJson(response, 200, { hash: message.hash });
      return true;
    }

    if (pathname === "/api/follow" && method === "POST") {
      const body = await readBody(request);
      const target = Number(body.fid);
      if (!target) throw new Error("Target FID is required.");
      const message = await publisher().follow(target);
      sendJson(response, 200, { hash: message.hash });
      return true;
    }

    if (pathname === "/api/unfollow" && method === "POST") {
      const body = await readBody(request);
      const target = Number(body.fid);
      if (!target) throw new Error("Target FID is required.");
      const message = await publisher().unfollow(target);
      sendJson(response, 200, { hash: message.hash });
      return true;
    }

    if (pathname === "/api/react" && method === "POST") {
      const body = await readBody(request);
      const type = body.type === "Recast" ? "REACTION_TYPE_RECAST" : "REACTION_TYPE_LIKE";
      const message = await publisher().react(
        { fid: Number(body.fid), hash: String(body.hash) },
        type as never,
      );
      sendJson(response, 200, { hash: message.hash });
      return true;
    }

    if (pathname === "/api/profile" && method === "GET") {
      const url = new URL(request.url ?? "/", "http://localhost");
      const fid = Number(url.searchParams.get("fid") ?? 0);
      if (!fid) throw new Error("fid is required.");
      const profile: Profile = await feed.profile(fid);
      const identity = await node.signersByFid(fid).catch(() => null);
      sendJson(response, 200, {
        profile,
        signers: identity?.signers ?? [],
        followers: (await node.linksByTargetFid(fid, { pageSize: 1 })).messages.length,
      });
      return true;
    }

    if (pathname === "/api/filter" && method === "POST") {
      const body = await readBody(request);
      filter = {
        include: Array.isArray(body.include) ? (body.include as string[]) : [],
        exclude: Array.isArray(body.exclude) ? (body.exclude as string[]) : [],
      };
      sendJson(response, 200, { filter });
      return true;
    }

    if (pathname === "/api/label" && method === "POST") {
      const body = await readBody(request);
      directory.setLabel(String(body.id), String(body.label));
      sendJson(response, 200, await statePayload());
      return true;
    }

    return false;
  }

  const server = createServer((request, response) => {
    void (async () => {
      let pathname = "/";
      try {
        const url = new URL(request.url ?? "/", "http://localhost");
        pathname = url.pathname;

        if (pathname.startsWith("/api/")) {
          const handled = await handleApi(pathname, request, response);
          if (!handled) sendJson(response, 404, { error: "Unknown endpoint" });
          return;
        }

        const file = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
        if (file.includes("..")) {
          sendJson(response, 400, { error: "Bad path" });
          return;
        }
        const contents = await readFile(join(PUBLIC_DIR, file));
        response.writeHead(200, {
          "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
        });
        response.end(contents);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const status = message.includes("ENOENT") ? 404 : 400;
        if (pathname.startsWith("/api/")) {
          sendJson(response, status, { error: message });
        } else {
          response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
          response.end(message);
        }
      }
    })();
  });

  const bind = options.host ?? "127.0.0.1";
  await new Promise<void>((resolve) => {
    server.listen(options.port, bind, resolve);
  });

  process.stdout.write(
    `\nreadnode client  →  http://${bind}:${options.port}\nreading from     →  ${options.nodeUrl}\nwriting to       →  ${options.submitUrl ?? `${options.nodeUrl} (relayed to validators)`}\n\n`,
  );
  process.stdout.write("Press Ctrl-C to stop.\n");
}
