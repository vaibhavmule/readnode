import {
  ClientDirectory,
  clientIdFor,
  isAllowed,
  type ClientFilter,
  type NodeMessage,
  type SnapchainNode,
} from "../core/index.js";

export interface Profile {
  fid: number;
  username?: string;
  displayName?: string;
  bio?: string;
  pfpUrl?: string;
}

export interface FeedEntry {
  fid: number;
  hash: string;
  timestamp: number;
  text: string;
  parent?: { fid: number; hash: string };
  author: Profile;
  clientId: string;
  clientLabel: string;
  clientSource?: string;
  isOwn: boolean;
  likes?: number;
  recasts?: number;
}

export interface FeedOptions {
  limit?: number;
  filter?: ClientFilter;
  includeReactions?: boolean;
  perAuthor?: number;
  maxAuthors?: number;
}

const USER_DATA = {
  PFP: "USER_DATA_TYPE_PFP",
  DISPLAY: "USER_DATA_TYPE_DISPLAY",
  BIO: "USER_DATA_TYPE_BIO",
  USERNAME: "USER_DATA_TYPE_USERNAME",
};

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function next(): Promise<void> {
    const index = cursor;
    cursor += 1;
    const item = items[index];
    if (item === undefined) return;
    results[index] = await worker(item);
    await next();
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

export class FeedBuilder {
  readonly node: SnapchainNode;
  readonly directory: ClientDirectory;
  private readonly profiles = new Map<number, Profile>();
  private readonly resolvedSigners = new Set<number>();

  constructor(node: SnapchainNode, directory: ClientDirectory) {
    this.node = node;
    this.directory = directory;
  }

  async profile(fid: number): Promise<Profile> {
    const cached = this.profiles.get(fid);
    if (cached) return cached;

    const profile: Profile = { fid };
    try {
      const page = await this.node.userDataByFid(fid);
      for (const message of page.messages) {
        const body = message.data.userDataBody;
        if (!body) continue;
        if (body.type === USER_DATA.USERNAME) profile.username = body.value;
        if (body.type === USER_DATA.DISPLAY) profile.displayName = body.value;
        if (body.type === USER_DATA.BIO) profile.bio = body.value;
        if (body.type === USER_DATA.PFP) profile.pfpUrl = body.value;
      }
    } catch {
      // profile is best-effort
    }

    this.profiles.set(fid, profile);
    return profile;
  }

  async resolveClients(fid: number): Promise<void> {
    if (this.resolvedSigners.has(fid)) return;
    this.resolvedSigners.add(fid);
    try {
      const response = await this.node.signersByFid(fid);
      for (const signer of response.signers) {
        const signerKey = signer.key.toLowerCase();
        this.directory.register({
          id: clientIdFor(signerKey, signer.requestFid),
          signerKey,
          requestFid: signer.requestFid,
          source: signer.source,
          scopes: signer.scopes ?? [],
          expiresAt: signer.expiresAt,
        });
      }
    } catch {
      // signers are best-effort
    }
  }

  async following(fid: number, maxAuthors: number): Promise<number[]> {
    const page = await this.node.linksByFid(fid, { pageSize: maxAuthors, reverse: true });
    return page.messages
      .map((message) => message.data.linkBody?.targetFid)
      .filter((target): target is number => typeof target === "number");
  }

  async build(fid: number, options: FeedOptions = {}): Promise<FeedEntry[]> {
    const limit = options.limit ?? 25;
    const perAuthor = options.perAuthor ?? 10;
    const maxAuthors = options.maxAuthors ?? 100;
    const filter = options.filter ?? { include: [], exclude: [] };

    const followed = await this.following(fid, maxAuthors);
    const authors = [fid, ...followed.filter((target) => target !== fid)];

    const pages = await mapLimit(authors, 8, async (author) => {
      try {
        const page = await this.node.castsByFid(author, {
          pageSize: perAuthor,
          reverse: true,
        });
        return page.messages;
      } catch {
        return [];
      }
    });

    const casts = pages
      .flat()
      .filter((message) => message.data.castAddBody != null)
      .sort((a, b) => b.data.timestamp - a.data.timestamp)
      .slice(0, limit);

    await mapLimit([...new Set(casts.map((c) => c.data.fid))], 6, (author) =>
      this.resolveClients(author),
    );

    const entries = await mapLimit(casts, 8, async (message) => {
      const author = await this.profile(message.data.fid);
      const body = message.data.castAddBody;
      const clientId = this.directory.idOf(message);
      const entry: FeedEntry = {
        fid: message.data.fid,
        hash: message.hash,
        timestamp: message.data.timestamp,
        text: body?.text ?? "",
        parent: body?.parentCastId,
        author,
        clientId,
        clientLabel: this.directory.labelFor(clientId),
        clientSource: this.directory.get(message.signer)?.source,
        isOwn: message.data.fid === fid,
      };
      return entry;
    });

    const visible = entries.filter((entry) => isAllowed(filter, entry.clientId));

    if (options.includeReactions) {
      await mapLimit(visible, 6, async (entry) => {
        const [likes, recasts] = await Promise.all([
          this.reactionCount(entry.fid, entry.hash, "Like"),
          this.reactionCount(entry.fid, entry.hash, "Recast"),
        ]);
        entry.likes = likes;
        entry.recasts = recasts;
      });
    }

    return visible;
  }

  private async reactionCount(
    targetFid: number,
    targetHash: string,
    type: string,
  ): Promise<number> {
    try {
      const page = await this.node.reactionsByCast(targetFid, targetHash, type, {
        pageSize: 200,
      });
      return page.messages.filter((m: NodeMessage) => m.data.reactionBody != null).length;
    } catch {
      return 0;
    }
  }
}
