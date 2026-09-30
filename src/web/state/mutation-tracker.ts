import type { Revision } from "../../domain/policy.ts";

export interface MutationIdentity {
  readonly idempotencyKey: string;
  readonly baseRevision: Revision;
}

export interface MutationTracker {
  readonly acquire: (signature: string, baseRevision: Revision) => MutationIdentity;
  readonly release: (signature: string) => void;
  readonly isRetained: (signature: string) => boolean;
}

export const mutationSignature = (parts: readonly string[]): string => parts.join("|");

export const createMutationTracker = (createKey: () => string): MutationTracker => {
  const identities = new Map<string, MutationIdentity>();
  return {
    acquire: (signature, baseRevision) => {
      const existing = identities.get(signature);
      if (existing !== undefined) {
        return existing;
      }
      const created: MutationIdentity = { idempotencyKey: createKey(), baseRevision };
      identities.set(signature, created);
      return created;
    },
    release: (signature) => {
      identities.delete(signature);
    },
    isRetained: (signature) => identities.has(signature),
  };
};
