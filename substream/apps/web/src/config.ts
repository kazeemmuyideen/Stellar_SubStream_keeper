import { Networks } from "@stellar/stellar-sdk";

const networkPassphrase =
  import.meta.env.VITE_NETWORK_PASSPHRASE || Networks.TESTNET;

export const config = {
  contractId: import.meta.env.VITE_CONTRACT_ID || "",
  rpcUrl:
    import.meta.env.VITE_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase,
  defaultToken: import.meta.env.VITE_TOKEN_ADDRESS || "",
  indexerUrl: import.meta.env.VITE_INDEXER_URL || "",
  networkLabel: networkPassphrase.includes("Test SDF")
    ? "Stellar Testnet"
    : networkPassphrase.includes("Public Global")
      ? "Stellar Mainnet"
      : "Custom network",
  explorerBase: networkPassphrase.includes("Public Global")
    ? "https://stellar.expert/explorer/public/tx"
    : "https://stellar.expert/explorer/testnet/tx",
};
