import type { NodeMessage, SignerRecord, SnapchainNode } from "./node.js";

export interface ClientIdentity {
  id: string;
  signerKey: string;
  requestFid?: number;
  source: string;
  scopes: number[];
  expiresAt?: number;
  label?: string;
}

export interface ClientFilter {
  include: string[];
  exclude: string[];
}

export function clientIdFor(signerKey: string, requestFid?: number): string {
  if (requestFid !== undefined) return `fid:${requestFid}`;
  return `key:${signerKey.toLowerCase()}`;
}

function identityFromSigner(signer: SignerRecord): ClientIdentity {
  const signerKey = signer.key.toLowerCase();
  const id = clientIdFor(signerKey, signer.requestFid);
  return {
    id,
    signerKey,
    requestFid: signer.requestFid,
    source: signer.source,
    scopes: signer.scopes ?? [],
    expiresAt: signer.expiresAt,
  };
}

export class ClientDirectory {
  private readonly bySignerKey = new Map<string, ClientIdentity>();
  private readonly labels = new Map<string, string>();

  register(identity: ClientIdentity): void {
    this.bySignerKey.set(identity.signerKey, identity);
  }

  get(signerKey: string): ClientIdentity | undefined {
    return this.bySignerKey.get(signerKey.toLowerCase());
  }

  all(): ClientIdentity[] {
    return [...this.bySignerKey.values()];
  }

  setLabel(id: string, label: string): void {
    this.labels.set(id, label);
  }

  labelFor(id: string): string {
    return this.labels.get(id) ?? id;
  }

  idOf(message: NodeMessage): string {
    return clientIdFor(message.signer, this.get(message.signer)?.requestFid);
  }
}

export async function resolveAuthorClients(
  node: SnapchainNode,
  fid: number,
  directory: ClientDirectory,
): Promise<ClientIdentity[]> {
  const response = await node.signersByFid(fid);
  const resolved = response.signers.map(identityFromSigner);
  for (const identity of resolved) {
    directory.register(identity);
  }
  return resolved;
}

export function isAllowed(filter: ClientFilter, id: string): boolean {
  if (filter.exclude.includes(id)) return false;
  if (filter.include.length > 0) return filter.include.includes(id);
  return true;
}

export function filterCasts(
  messages: NodeMessage[],
  directory: ClientDirectory,
  filter: ClientFilter,
): NodeMessage[] {
  return messages.filter((message) => isAllowed(filter, directory.idOf(message)));
}
