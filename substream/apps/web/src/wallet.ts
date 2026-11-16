import {
  getNetwork,
  isConnected,
  requestAccess,
  signTransaction,
} from "@stellar/freighter-api";
import { Transaction, TransactionBuilder } from "@stellar/stellar-sdk";
import type { SubStreamSigner } from "@substream/sdk";

function networkLabel(network: string): string {
  switch (network.toUpperCase()) {
    case "TESTNET":
      return "Testnet";
    case "PUBLIC":
      return "Mainnet";
    case "FUTURENET":
      return "Futurenet";
    default:
      return network;
  }
}

function passphraseLabel(passphrase: string): string {
  if (passphrase.includes("Test SDF")) return "Testnet";
  if (passphrase.includes("Public Global")) return "Mainnet";
  if (passphrase.includes("Futurenet")) return "Futurenet";
  return "a different network";
}

export async function connectWallet(
  expectedPassphrase?: string,
): Promise<string> {
  const status = await isConnected();
  if (!status.isConnected) {
    throw new Error(
      "Freighter was not detected. Install the Freighter extension and refresh the page.",
    );
  }

  const access = await requestAccess();
  if (access.error) {
    throw new Error(access.error.message);
  }
  if (!access.address) {
    throw new Error("Freighter did not return an address.");
  }

  if (expectedPassphrase) {
    const network = await getNetwork();
    if (network.error) {
      throw new Error(network.error.message);
    }
    if (
      network.networkPassphrase &&
      network.networkPassphrase !== expectedPassphrase
    ) {
      throw new Error(
        `Freighter is on ${networkLabel(network.network)}, but this dApp ` +
          `expects ${passphraseLabel(expectedPassphrase)}. Open Freighter, ` +
          "switch the network in its settings, and connect again.",
      );
    }
  }

  return access.address;
}

export function freighterSigner(
  networkPassphrase: string,
  address: string,
): SubStreamSigner {
  return async (tx: Transaction) => {
    const result = await signTransaction(tx.toXDR(), {
      networkPassphrase,
      address,
    });

    if (result.error) {
      throw new Error(result.error.message);
    }
    if (!result.signedTxXdr) {
      throw new Error("Freighter returned an empty signed transaction.");
    }

    return TransactionBuilder.fromXDR(
      result.signedTxXdr,
      networkPassphrase,
    ) as Transaction;
  };
}
