import { runClientServer } from "../client/server.js";
import { loadState } from "../state.js";
import type { NodeAuth } from "../core/index.js";

export interface ClientFlags {
  nodeUrl?: string;
  port?: number;
  bind?: string;
  auth?: string;
  opRpc?: string;
  fid?: number;
}

function parseAuth(value: string): NodeAuth {
  const index = value.indexOf(":");
  if (index === -1) throw new Error("--auth must be username:password");
  return { username: value.slice(0, index), password: value.slice(index + 1) };
}

export async function client(flags: ClientFlags): Promise<void> {
  const state = await loadState();
  const nodeUrl = flags.nodeUrl ?? state.nodeUrl ?? "http://127.0.0.1:3381";

  await runClientServer({
    nodeUrl,
    port: flags.port ?? 3939,
    host: flags.bind,
    nodeAuth: flags.auth ? parseAuth(flags.auth) : undefined,
    opRpcUrl: flags.opRpc,
    fid: flags.fid ?? state.fid,
  });
}
