import type { HubResult } from "@farcaster/hub-nodejs";

export function unwrap<T>(result: HubResult<T>): T {
  if (result.isErr()) {
    throw new Error(result.error.message);
  }
  return result.value;
}

export function unwrapOrNull<T>(result: HubResult<T>): T | null {
  return result.isErr() ? null : result.value;
}
