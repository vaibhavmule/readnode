import {
  FarcasterNetwork,
  Message,
  NobleEd25519Signer,
  ViemLocalEip712Signer,
  getFarcasterTime,
  makeKeyAdd,
  makeKeyAddBody,
  makeKeyRemoveBody,
  makeKeyRemoveBodySelfRevoke,
  makeKeyRemove,
  type MessageType,
} from "@farcaster/hub-nodejs";
import { toHex } from "viem";
import { toAccount, type HDAccount, type LocalAccount } from "viem/accounts";
import { randomBytes } from "node:crypto";
import type { SnapchainNode, NodeMessage } from "./node.js";
import { unwrap } from "./result.js";
import { CLIENT_SCOPES, SIGNER_TTL_SECONDS } from "./scopes.js";

export interface GaslessSigner {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  publicKeyHex: string;
  scopes: MessageType[];
  ttl: number;
  expiresAt: number;
  requestFid: number;
  nonce: number;
  keyAddHash: string;
}

export interface RegisterSignerOptions {
  node: SnapchainNode;
  fid: number;
  custody: HDAccount;
  scopes?: MessageType[];
  ttl?: number;
  privateKey?: Uint8Array;
  requestFid?: number;
  requestCustody?: HDAccount;
}

export function generateSignerPrivateKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

export async function signerPublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
  const signer = new NobleEd25519Signer(Buffer.from(privateKey));
  return unwrap(await signer.getSignerKey());
}

export function signerFromPrivateKey(privateKey: Uint8Array): NobleEd25519Signer {
  return new NobleEd25519Signer(Buffer.from(privateKey));
}

export async function registerGaslessSigner(
  options: RegisterSignerOptions,
): Promise<GaslessSigner> {
  const { node, fid, custody } = options;
  const scopes = options.scopes ?? CLIENT_SCOPES;
  const ttl = options.ttl ?? SIGNER_TTL_SECONDS;
  const privateKey = options.privateKey ?? generateSignerPrivateKey();
  const requestFid = options.requestFid ?? fid;

  const signer = signerFromPrivateKey(privateKey);
  const publicKey = unwrap(await signer.getSignerKey());

  const existing = await node.signersByFid(fid);
  const nonce = (existing.currentUserNonce ?? 0) + 1;
  const deadline = unwrap(getFarcasterTime()) + 60 * 60;

  const body = unwrap(
    await makeKeyAddBody(
      {
        fid: BigInt(fid),
        key: publicKey,
        scopes,
        ttl,
        nonce,
        deadline,
        requestFid: BigInt(requestFid),
      },
      new ViemLocalEip712Signer(toAccount(custody as LocalAccount)),
      options.requestCustody
        ? new ViemLocalEip712Signer(toAccount(options.requestCustody as LocalAccount))
        : undefined,
    ),
  );

  const message = unwrap(
    await makeKeyAdd(body, { fid, network: FarcasterNetwork.MAINNET }, signer),
  );

  const submitted = await node.submitMessage(Message.encode(message).finish());

  return {
    privateKey,
    publicKey,
    publicKeyHex: toHex(publicKey),
    scopes,
    ttl,
    expiresAt: Math.floor(Date.now() / 1000) + ttl,
    requestFid,
    nonce,
    keyAddHash: submitted.hash,
  };
}

export async function revokeGaslessSigner(options: {
  node: SnapchainNode;
  fid: number;
  custody?: HDAccount;
  privateKey: Uint8Array;
  selfRevoke?: boolean;
  requestFid?: number;
}): Promise<NodeMessage> {
  const { node, fid, privateKey } = options;
  const signer = signerFromPrivateKey(privateKey);
  const key = unwrap(await signer.getSignerKey());
  const existing = await node.signersByFid(fid);

  const nonce = options.selfRevoke
    ? (existing.requesterFidNonces?.[options.requestFid ?? fid] ?? 0) + 1
    : (existing.currentUserNonce ?? 0) + 1;

  const deadline = unwrap(getFarcasterTime()) + 60 * 60;

  const body = options.selfRevoke
    ? unwrap(await makeKeyRemoveBodySelfRevoke({ key, nonce, deadline }))
    : unwrap(
        await makeKeyRemoveBody(
          { fid: BigInt(fid), key, nonce, deadline },
          new ViemLocalEip712Signer(toAccount(options.custody as LocalAccount)),
        ),
      );

  const message = unwrap(
    await makeKeyRemove(body, { fid, network: FarcasterNetwork.MAINNET }, signer),
  );

  return node.submitMessage(Message.encode(message).finish());
}
