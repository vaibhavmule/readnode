import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ReadnodeState {
  provider?: string;
  instanceName?: string;
  host?: string;
  sshKey?: string;
  nodeUrl?: string;
  fid?: number;
  signerPublicKey?: string;
  requestFid?: number;
  createdAt?: string;
}

export interface SignerState {
  fid: number;
  privateKey: string;
  publicKey: string;
  requestFid: number;
  scopes: number[];
  ttl: number;
  expiresAt: number;
}

export const STATE_DIR =
  process.env.READNODE_HOME ?? join(homedir(), ".readnode");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const SIGNER_PATH = join(STATE_DIR, "signer.json");

export async function loadState(): Promise<ReadnodeState> {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf8")) as ReadnodeState;
  } catch {
    return {};
  }
}

export async function saveState(patch: ReadnodeState): Promise<ReadnodeState> {
  const next = { ...(await loadState()), ...patch };
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

export async function loadSigner(): Promise<SignerState | null> {
  try {
    return JSON.parse(await readFile(SIGNER_PATH, "utf8")) as SignerState;
  } catch {
    return null;
  }
}

export async function saveSigner(signer: SignerState): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(SIGNER_PATH, `${JSON.stringify(signer, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
