#!/usr/bin/env node
// Register a fresh Farcaster account (FID + 1 unit of storage) for testing the
// client. The Farcaster app only gives new accounts a passkey, but the client
// needs a seed phrase, so this makes one directly onchain via IdGateway.
//
//   node scripts/register-test-account.mjs            # create wallet / show status
//   node scripts/register-test-account.mjs register   # register once funded
//
// The seed phrase lives in ~/.readnode/test-account.json (mode 0600). It is a
// throwaway: never put a seed phrase for an account you care about here.
// Cost: IdGateway.price() (~0.00008 ETH) plus gas, on Optimism.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ID_GATEWAY_ADDRESS, ID_REGISTRY_ADDRESS, idGatewayABI, idRegistryABI } from "@farcaster/hub-nodejs";
import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { english, generateMnemonic, mnemonicToAccount } from "viem/accounts";
import { optimism } from "viem/chains";

const RPC = process.env.OP_RPC ?? "https://mainnet.optimism.io";
const dir = join(homedir(), ".readnode");
const file = join(dir, "test-account.json");

if (!existsSync(file)) {
  mkdirSync(dir, { recursive: true });
  const mnemonic = generateMnemonic(english);
  const { address } = mnemonicToAccount(mnemonic);
  writeFileSync(file, `${JSON.stringify({ mnemonic, address, createdAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  console.log(`Created a test wallet; seed phrase saved to ${file}`);
}

const saved = JSON.parse(readFileSync(file, "utf8"));
const account = mnemonicToAccount(saved.mnemonic);
const pub = createPublicClient({ chain: optimism, transport: http(RPC) });

const [balance, price, existing] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.readContract({ address: ID_GATEWAY_ADDRESS, abi: idGatewayABI, functionName: "price" }),
  pub.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: "idOf", args: [account.address] }),
]);

console.log(`Address:  ${account.address}`);
console.log(`Balance:  ${formatEther(balance)} ETH on Optimism`);
console.log(`Price:    ${formatEther(price)} ETH for an FID with 1 unit of storage`);

if (existing > 0n) {
  console.log(`FID:      ${existing} (already registered)`);
  console.log(`\nImport the seed phrase from ${file} into \`readnode client\`.`);
  process.exit(0);
}

if (process.argv[2] !== "register") {
  console.log(`\nSend ~0.0005 ETH on Optimism to ${account.address}, then rerun with \`register\`.`);
  process.exit(0);
}

if (balance < price) {
  console.error(`\nNot enough ETH: need ${formatEther(price)} plus gas.`);
  process.exit(1);
}

const wallet = createWalletClient({ account, chain: optimism, transport: http(RPC) });
// Recovery is the custody address itself; IdGateway refunds any overpayment.
const hash = await wallet.writeContract({
  address: ID_GATEWAY_ADDRESS,
  abi: idGatewayABI,
  functionName: "register",
  args: [account.address],
  value: price,
});
console.log(`\nSent ${hash}, waiting for it to land...`);
const receipt = await pub.waitForTransactionReceipt({ hash });
if (receipt.status !== "success") {
  console.error(`Transaction reverted: https://optimistic.etherscan.io/tx/${hash}`);
  process.exit(1);
}
const fid = await pub.readContract({ address: ID_REGISTRY_ADDRESS, abi: idRegistryABI, functionName: "idOf", args: [account.address] });
console.log(`Registered FID ${fid}: https://optimistic.etherscan.io/tx/${hash}`);
console.log(`\nImport the seed phrase from ${file} into \`readnode client\`.`);
