/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CONTRACT_ID?: string;
  readonly VITE_RPC_URL?: string;
  readonly VITE_NETWORK_PASSPHRASE?: string;
  readonly VITE_TOKEN_ADDRESS?: string;
  readonly VITE_INDEXER_URL?: string;
  readonly VITE_MAX_FEE?: string;
  readonly VITE_E2E_FIXTURES?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
