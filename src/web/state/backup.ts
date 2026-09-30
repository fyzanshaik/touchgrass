import { Either, Schema } from "effect";
import { BackupResponse } from "../../contracts/api.ts";
import { Policy } from "../../domain/policy.ts";
import type { ParseResult } from "./parse-result.ts";

export const parseBackupPolicy = (text: string): ParseResult<Policy> => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "The selected file is not valid JSON." };
  }
  const backup = Schema.decodeUnknownEither(BackupResponse)(value);
  if (Either.isRight(backup)) {
    return { ok: true, value: backup.right.policy };
  }
  const policy = Schema.decodeUnknownEither(Policy)(value);
  if (Either.isRight(policy)) {
    return { ok: true, value: policy.right };
  }
  return { ok: false, message: "The selected file is not a Touchgrass policy backup." };
};
