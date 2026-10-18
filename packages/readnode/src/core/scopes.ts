import { MessageType } from "@farcaster/hub-nodejs";

export const CLIENT_SCOPES: MessageType[] = [
  MessageType.CAST_ADD,
  MessageType.CAST_REMOVE,
  MessageType.REACTION_ADD,
  MessageType.REACTION_REMOVE,
  MessageType.LINK_ADD,
  MessageType.LINK_REMOVE,
  MessageType.USER_DATA_ADD,
  MessageType.VERIFICATION_ADD_ETH_ADDRESS,
  MessageType.VERIFICATION_REMOVE,
];

export const SIGNER_TTL_SECONDS = 30 * 24 * 60 * 60;

export const SCOPE_NAMES: Record<number, string> = {
  [MessageType.CAST_ADD]: "cast:add",
  [MessageType.CAST_REMOVE]: "cast:remove",
  [MessageType.REACTION_ADD]: "reaction:add",
  [MessageType.REACTION_REMOVE]: "reaction:remove",
  [MessageType.LINK_ADD]: "link:add",
  [MessageType.LINK_REMOVE]: "link:remove",
  [MessageType.USER_DATA_ADD]: "user-data:add",
  [MessageType.VERIFICATION_ADD_ETH_ADDRESS]: "verification:add",
  [MessageType.VERIFICATION_REMOVE]: "verification:remove",
  [MessageType.USERNAME_PROOF]: "username:proof",
  [MessageType.FRAME_ACTION]: "frame:action",
  [MessageType.LINK_COMPACT_STATE]: "link:compact",
};

export function describeScopes(scopes: number[]): string[] {
  return scopes.map((scope) => SCOPE_NAMES[scope] ?? `unknown:${scope}`);
}
