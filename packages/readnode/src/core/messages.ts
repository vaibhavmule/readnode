import {
  CastType,
  FarcasterNetwork,
  Message,
  UserDataType,
  makeCastAdd,
  makeCastRemove,
  makeLinkAdd,
  makeLinkRemove,
  makeReactionAdd,
  makeReactionRemove,
  makeUserDataAdd,
  type HubAsyncResult,
  type NobleEd25519Signer,
  type ReactionType,
} from "@farcaster/hub-nodejs";
import { hexToBytes } from "viem";
import type { NodeMessage, SnapchainNode } from "./node.js";
import { unwrap } from "./result.js";

export interface CastTarget {
  fid: number;
  hash: string;
}

function toCastId(target: CastTarget): { fid: number; hash: Uint8Array } {
  return { fid: target.fid, hash: hexToBytes(target.hash as `0x${string}`) };
}

export interface PublisherConfig {
  node: SnapchainNode;
  fid: number;
  signer: NobleEd25519Signer;
  network?: FarcasterNetwork;
}

export class Publisher {
  readonly node: SnapchainNode;
  readonly fid: number;
  readonly signer: NobleEd25519Signer;
  readonly network: FarcasterNetwork;

  constructor(config: PublisherConfig) {
    this.node = config.node;
    this.fid = config.fid;
    this.signer = config.signer;
    this.network = config.network ?? FarcasterNetwork.MAINNET;
  }

  private async submit(
    result: HubAsyncResult<Message>,
  ): Promise<NodeMessage> {
    const message = unwrap(await result);
    return this.node.submitMessage(Message.encode(message).finish());
  }

  private dataOptions() {
    return { fid: this.fid, network: this.network };
  }

  async cast(text: string, parent?: CastTarget): Promise<NodeMessage> {
    return this.submit(
      makeCastAdd(
        {
          text,
          embeds: [],
          embedsDeprecated: [],
          mentions: [],
          mentionsPositions: [],
          type: CastType.CAST,
          parentCastId: parent ? toCastId(parent) : undefined,
        },
        this.dataOptions(),
        this.signer,
      ),
    );
  }

  async deleteCast(targetHash: string): Promise<NodeMessage> {
    return this.submit(
      makeCastRemove(
        { targetHash: hexToBytes(targetHash as `0x${string}`) },
        this.dataOptions(),
        this.signer,
      ),
    );
  }

  async react(target: CastTarget, type: ReactionType): Promise<NodeMessage> {
    return this.submit(
      makeReactionAdd(
        { type, targetCastId: toCastId(target) },
        this.dataOptions(),
        this.signer,
      ),
    );
  }

  async unreact(target: CastTarget, type: ReactionType): Promise<NodeMessage> {
    return this.submit(
      makeReactionRemove(
        { type, targetCastId: toCastId(target) },
        this.dataOptions(),
        this.signer,
      ),
    );
  }

  async follow(targetFid: number): Promise<NodeMessage> {
    return this.submit(
      makeLinkAdd({ type: "follow", targetFid }, this.dataOptions(), this.signer),
    );
  }

  async unfollow(targetFid: number): Promise<NodeMessage> {
    return this.submit(
      makeLinkRemove({ type: "follow", targetFid }, this.dataOptions(), this.signer),
    );
  }

  async setUserData(type: UserDataType, value: string): Promise<NodeMessage> {
    return this.submit(
      makeUserDataAdd({ type, value }, this.dataOptions(), this.signer),
    );
  }

  async setDisplayName(value: string): Promise<NodeMessage> {
    return this.setUserData(UserDataType.DISPLAY, value);
  }

  async setBio(value: string): Promise<NodeMessage> {
    return this.setUserData(UserDataType.BIO, value);
  }

  async setPfp(value: string): Promise<NodeMessage> {
    return this.setUserData(UserDataType.PFP, value);
  }
}
