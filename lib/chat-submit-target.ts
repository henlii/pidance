/**
 * Resolve the prompt submit target from the current chat identity.
 * New intents never inherit a leftover persisted session id.
 */

export type ChatSubmitTarget =
  | { kind: "persisted"; sessionId: string }
  | { kind: "new"; intentId: string; cwd: string };

export type ChatSubmitIdentity = {
  isNew: boolean;
  intentId: string | null;
  cwd: string | null;
  /** Selected persisted session id (session?.id). Not a leftover ref. */
  persistedSessionId: string | null;
  /** Sid ensured for THIS new intent only. */
  ensuredSessionId: string | null;
};

export type ChatTargetRefs = {
  sessionId: { current: string | null };
  newSessionPromoted: { current: boolean };
  promptSubmitted: { current: boolean };
  ensuringNewSession: { current: Promise<string | null> | null };
};

export function resolveSubmitTarget(identity: ChatSubmitIdentity): ChatSubmitTarget | null {
  if (identity.isNew) {
    if (identity.ensuredSessionId) {
      return { kind: "persisted", sessionId: identity.ensuredSessionId };
    }
    if (identity.intentId && identity.cwd) {
      return { kind: "new", intentId: identity.intentId, cwd: identity.cwd };
    }
    return null;
  }
  if (identity.persistedSessionId) {
    return { kind: "persisted", sessionId: identity.persistedSessionId };
  }
  return null;
}

/**
 * ChatWindow no longer remounts; target-scoped refs must reset whenever
 * the selected session or new-session intent changes.
 */
export function resetChatTargetRefs(
  refs: ChatTargetRefs,
  nextSessionId: string | null,
): void {
  refs.sessionId.current = nextSessionId;
  refs.newSessionPromoted.current = false;
  refs.promptSubmitted.current = false;
  refs.ensuringNewSession.current = null;
}

export type ChatTargetToken =
  | { kind: "new"; intentId: string }
  | { kind: "persisted"; sessionId: string };

export function captureChatTargetToken(identity: {
  isNew: boolean;
  intentId: string | null;
  persistedSessionId: string | null;
}): ChatTargetToken | null {
  if (identity.isNew) {
    if (!identity.intentId) return null;
    return { kind: "new", intentId: identity.intentId };
  }
  if (!identity.persistedSessionId) return null;
  return { kind: "persisted", sessionId: identity.persistedSessionId };
}

export function chatTargetTokenMatches(
  token: ChatTargetToken,
  current: { intentId: string | null; persistedSessionId: string | null },
): boolean {
  if (token.kind === "new") return current.intentId === token.intentId;
  return current.persistedSessionId === token.sessionId;
}

/** 两个完整 target token 是否同为当前导航 target（比较 kind + 具体 id）。 */
export function sameChatTargetToken(a: ChatTargetToken | null, b: ChatTargetToken | null): boolean {
  if (!a || !b) {
    if (!a && !b) return true;
    return false;
  }
  if (a.kind !== b.kind) return false;
  if (a.kind === "new" && b.kind === "new") return a.intentId === b.intentId;
  if (a.kind === "persisted" && b.kind === "persisted") return a.sessionId === b.sessionId;
  return false;
}
