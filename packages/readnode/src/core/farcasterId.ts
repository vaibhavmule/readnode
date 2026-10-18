import { ID_REGISTRY_ADDRESS, idRegistryABI } from "@farcaster/hub-nodejs";
import {
  createPublicClient,
  getAddress,
  http,
  type Address,
  type PublicClient,
} from "viem";
import { optimism } from "viem/chains";

export const PUBLIC_OPTIMISM_RPC = "https://mainnet.optimism.io";

export function optimismClient(rpcUrl: string = PUBLIC_OPTIMISM_RPC): PublicClient {
  return createPublicClient({ chain: optimism, transport: http(rpcUrl) }) as PublicClient;
}

export async function fidForAddress(
  address: Address,
  rpcUrl?: string,
): Promise<number> {
  const client = optimismClient(rpcUrl);
  const fid = (await client.readContract({
    address: ID_REGISTRY_ADDRESS,
    abi: idRegistryABI,
    functionName: "idOf",
    args: [getAddress(address)],
  })) as bigint;
  return Number(fid);
}

export async function custodyAddressForFid(
  fid: number,
  rpcUrl?: string,
): Promise<Address> {
  const client = optimismClient(rpcUrl);
  const address = (await client.readContract({
    address: ID_REGISTRY_ADDRESS,
    abi: idRegistryABI,
    functionName: "custodyOf",
    args: [BigInt(fid)],
  })) as Address;
  return address;
}

export interface CustodyCheck {
  fid: number;
  address: Address;
  custodyAddress: Address;
  matches: boolean;
}

export async function checkCustody(
  address: Address,
  rpcUrl?: string,
): Promise<CustodyCheck> {
  const fid = await fidForAddress(address, rpcUrl);
  if (fid === 0) {
    return {
      fid,
      address: getAddress(address),
      custodyAddress: getAddress(address),
      matches: false,
    };
  }
  const custodyAddress = await custodyAddressForFid(fid, rpcUrl);
  return {
    fid,
    address: getAddress(address),
    custodyAddress: getAddress(custodyAddress),
    matches: getAddress(address) === getAddress(custodyAddress),
  };
}
