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
