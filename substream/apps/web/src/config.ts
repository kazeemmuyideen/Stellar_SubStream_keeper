import { Networks } from "@stellar/stellar-sdk";

const networkPassphrase =
  import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

function maxFee(): number {
  const raw = import.meta.env.VITE_MAX_FEE?.trim();
  if (!raw) return 20_000_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 100_000_000) {
    throw new Error("VITE_MAX_FEE must be an integer between 1 and 100000000");
  }
  return value;
}

export const config = {
  contractId: import.meta.env.VITE_CONTRACT_ID || "",
  rpcUrl:
    import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase,
  defaultToken: import.meta.env.VITE_TOKEN_ADDRESS || "",
  indexerUrl: import.meta.env.VITE_INDEXER_URL || "",
  maxFee: maxFee(),
  networkLabel: networkPassphrase.includes("Test SDF")
    ? "Stellar Testnet"
    : networkPassphrase.includes("Public Global")
      ? "Stellar Mainnet"
      : "Custom network",
  explorerBase: networkPassphrase.includes("Public Global")
    ? "https://stellar.expert/explorer/public/tx"
    : "https://stellar.expert/explorer/testnet/tx",
  explorerContractBase: networkPassphrase.includes("Public Global")
    ? "https://stellar.expert/explorer/public/contract"
    : "https://stellar.expert/explorer/testnet/contract",
  e2eFixtures:
    import.meta.env.DEV && import.meta.env.VITE_E2E_FIXTURES === "1",
};
