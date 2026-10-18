import { mnemonicToAccount, type HDAccount } from "viem/accounts";

const ALLOWED_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function normalizeMnemonic(input: string): string {
  const mnemonic = input.trim().toLowerCase().replace(/\s+/g, " ");
  const words = mnemonic.split(" ");
  if (!ALLOWED_WORD_COUNTS.has(words.length)) {
    throw new Error(
      `Seed phrase must be 12, 15, 18, 21 or 24 words, received ${words.length}`,
    );
  }
  return mnemonic;
}

export function custodyAccountFromMnemonic(mnemonic: string): HDAccount {
  return mnemonicToAccount(normalizeMnemonic(mnemonic));
}
