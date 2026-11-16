import { Address, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export function addressToScVal(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

export function i128ToScVal(value: bigint | number | string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "i128" });
}

export function u64ToScVal(value: bigint | number | string): xdr.ScVal {
  return nativeToScVal(BigInt(value), { type: "u64" });
}

export function u32ToScVal(value: number): xdr.ScVal {
  return nativeToScVal(value, { type: "u32" });
}

export function boolToScVal(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: "bool" });
}

export function fromScVal<T>(value: xdr.ScVal): T {
  return scValToNative(value) as T;
}
