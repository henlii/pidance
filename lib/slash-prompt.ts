/**
 * Pi AgentSession.prompt() executes extension slash commands immediately,
 * even while the main run is streaming. Pidance must not busy-reject those
 * prompts before they reach the SDK.
 */
export function isImmediateSlashPrompt(message: string): boolean {
  return message.trim().startsWith("/");
}
