export interface FnameTransfer {
  id: number;
  timestamp: number;
  username: string;
  owner: string;
  from: number;
  to: number;
}

export async function resolveFidFromUsername(username: string): Promise<number> {
  const name = username.replace(/^@/, "");
  const response = await fetch(
    `https://fnames.farcaster.xyz/transfers?name=${encodeURIComponent(name)}`,
  );
  if (!response.ok) {
    throw new Error(`fnames lookup failed: ${response.status} ${response.statusText}`);
  }
  const body = (await response.json()) as { transfers?: FnameTransfer[] };
  const transfers = body.transfers ?? [];
  const latest = transfers[transfers.length - 1];
  if (!latest) {
    throw new Error(`No fname registration found for ${name}`);
  }
  return latest.to;
}

export interface FnameRecord {
  fid: number;
  username: string;
}

export async function resolveUsernameFromFid(fid: number): Promise<FnameRecord | null> {
  const response = await fetch(
    `https://fnames.farcaster.xyz/transfers/current?fid=${fid}`,
  );
  if (!response.ok) return null;
  const body = (await response.json()) as { transfer?: FnameTransfer };
  if (!body.transfer) return null;
  return { fid, username: body.transfer.username };
}
