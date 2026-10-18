export interface NodeAuth {
  username: string;
  password: string;
}

export interface ShardInfo {
  shardId: number;
  maxHeight: number;
  numMessages: number;
  blockDelay: number;
  mempoolSize: number;
}

export interface NodeInfo {
  version: string;
  numShards: number;
  peer_id?: string;
  dbStats?: {
    numMessages: number;
    numFidRegistrations: number;
    approxSize: number;
  };
  shardInfos: ShardInfo[];
}

export interface CastAddBody {
  text: string;
  embeds: unknown[];
  embedsDeprecated?: unknown[];
  mentions: number[];
  mentionsPositions: number[];
  parentCastId?: { fid: number; hash: string };
  parentUrl?: string;
  type?: string;
}

export interface NodeMessage {
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
    castAddBody?: CastAddBody;
    castRemoveBody?: { targetHash: string };
    reactionBody?: {
      type: string;
      targetCastId?: { fid: number; hash: string };
      targetUrl?: string;
    };
    linkBody?: { type: string; targetFid: number };
    userDataBody?: { type: string; value: string };
  };
  hash: string;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  signer: string;
}

export interface MessagesPage {
  messages: NodeMessage[];
  nextPageToken: string;
}

export interface SignerRecord {
  source: string;
  key: string;
  keyType: number;
  fid: number;
  addedAt?: number;
  lastUsedAt?: number;
  ttl?: number;
  expiresAt?: number;
  scopes: number[];
  requestFid?: number;
  nonce?: number;
}

export interface SignersResponse {
  signers: SignerRecord[];
  nextPageToken: string;
  gaslessSignerCount: number;
  gaslessSignerLimit: number;
  currentUserNonce: number;
  requesterFidNonces?: Record<string, number>;
}

export interface PageOptions {
  pageSize?: number;
  pageToken?: string;
  reverse?: boolean;
}

export interface StorageLimit {
  limit: number;
  used: number;
}

export interface StorageLimitsResponse {
  limits: Record<string, StorageLimit>;
}

function toQuery(
  params: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export class SnapchainNode {
  readonly baseUrl: string;
  readonly auth?: NodeAuth;

  constructor(baseUrl: string, auth?: NodeAuth) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.auth = auth;
  }

  private headers(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (contentType) headers["content-type"] = contentType;
    if (this.auth) {
      const token = Buffer.from(
        `${this.auth.username}:${this.auth.password}`,
      ).toString("base64");
      headers.authorization = `Basic ${token}`;
    }
    return headers;
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}${toQuery(params)}`, {
      headers: this.headers(),
    });
    return this.parse<T>(response);
  }

  private async parse<T>(response: Response): Promise<T> {
    const body = await response.text();
    if (!response.ok) {
      let detail = body;
      try {
        const parsed = JSON.parse(body) as { details?: string; errCode?: string };
        detail = parsed.details ?? parsed.errCode ?? body;
      } catch {
        detail = body;
      }
      throw new Error(`${response.status} ${response.statusText}: ${detail}`);
    }
    return JSON.parse(body) as T;
  }

  async info(): Promise<NodeInfo> {
    return this.get<NodeInfo>("/v1/info");
  }

  async blockDelaySeconds(): Promise<number> {
    const info = await this.info();
    return Math.max(...info.shardInfos.map((shard) => shard.blockDelay), 0);
  }

  async castsByFid(
    fid: number,
    options: PageOptions & { startTimestamp?: number; stopTimestamp?: number } = {},
  ): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/castsByFid", {
      fid,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
      startTimestamp: options.startTimestamp,
      stopTimestamp: options.stopTimestamp,
    });
  }

  async castById(fid: number, hash: string): Promise<NodeMessage> {
    return this.get<NodeMessage>("/v1/castById", { fid, hash });
  }

  async castsByParent(fid: number, hash: string, options: PageOptions = {}): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/castsByParent", {
      fid,
      hash,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async userDataByFid(fid: number, options: PageOptions = {}): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/userDataByFid", {
      fid,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async linksByFid(fid: number, options: PageOptions = {}): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/linksByFid", {
      fid,
      link_type: "follow",
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async linksByTargetFid(targetFid: number, options: PageOptions = {}): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/linksByTargetFid", {
      target_fid: targetFid,
      link_type: "follow",
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async reactionsByFid(
    fid: number,
    reactionType: string,
    options: PageOptions = {},
  ): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/reactionsByFid", {
      fid,
      reaction_type: reactionType,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async reactionsByCast(
    targetFid: number,
    targetHash: string,
    reactionType: string,
    options: PageOptions = {},
  ): Promise<MessagesPage> {
    return this.get<MessagesPage>("/v1/reactionsByCast", {
      target_fid: targetFid,
      target_hash: targetHash,
      reaction_type: reactionType,
      pageSize: options.pageSize,
      pageToken: options.pageToken,
      reverse: options.reverse,
    });
  }

  async signersByFid(fid: number): Promise<SignersResponse> {
    return this.get<SignersResponse>("/v1/signersByFid", { fid });
  }

  async storageLimitsByFid(fid: number): Promise<StorageLimitsResponse> {
    return this.get<StorageLimitsResponse>("/v1/storageLimitsByFid", { fid });
  }

  async submitMessage(bytes: Uint8Array): Promise<NodeMessage> {
    const response = await fetch(`${this.baseUrl}/v1/submitMessage`, {
      method: "POST",
      headers: this.headers("application/octet-stream"),
      body: bytes as unknown as RequestInit["body"],
    });
    return this.parse<NodeMessage>(response);
  }
}
