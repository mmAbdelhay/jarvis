// A ready-made owner.json for tests: an owner password already set, hashed
// at a tiny scrypt cost so a bridge test can start listening without paying
// N=2^17 on every case. The file records its own params, so the real
// verify path reads it exactly as it would a production file.

import { scryptSync } from "node:crypto";
import type { OwnerHashParams } from "./owner.js";

export const OWNER_TEST_PASSWORD = "owner test password";
export const OWNER_TEST_HASH_PARAMS: OwnerHashParams = { N: 2 ** 4, r: 8, p: 1 };

/** owner.json text with `password` set and no passkeys. */
export function ownerFileWithPassword(password: string = OWNER_TEST_PASSWORD): string {
  const salt = Buffer.alloc(16, 7);
  const { N, r, p } = OWNER_TEST_HASH_PARAMS;
  const hash = scryptSync(password, salt, 64, { N, r, p }).toString("hex");
  return `${JSON.stringify(
    {
      version: 1,
      password: { hash, salt: salt.toString("hex"), N, r, p },
      passkeys: [],
      credentialsVersion: 1,
    },
    null,
    2,
  )}\n`;
}
