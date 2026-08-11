export {
  serializeJsonLine,
  attachJsonlLineReader,
  JsonlLineBuffer,
} from "./framing";
export {
  MessageAssembler,
  type AssemblerAgentEvent,
  type AssistantMessageEventLike,
} from "./message-assembler";
export {
  resolveRuntimeBinary,
  readPiVersion,
  configureRuntimeEnv,
  getAgentRuntimeMode,
  type ResolvedRuntimeBinary,
  type RuntimeBinarySource,
} from "./resolve-binary";
export {
  PiRpcProcess,
  type RpcCommand,
  type RpcResponse,
  type StartRpcProcessOptions,
  type RpcProcessExitInfo,
} from "./rpc-process";
export {
  ExternalRpcSession,
  type ExternalSessionOptions,
  type NavigationActions as ExternalNavigationActions,
} from "./external-session";
export {
  buildRuntimeInfo,
  type RuntimeInfo,
  type RuntimeCapabilityFlags,
} from "./runtime-info";
export {
  buildUpgradeSnapshot,
  listRuntimeSlots,
  resolveUpgradePolicy,
  resolveFromSlots,
  resolveSlotBinary,
  defaultSlotsRoot,
  type RuntimeSlot,
  type RuntimeUpgradePolicy,
  type RuntimeUpgradeSnapshot,
} from "./runtime-upgrade";
export { quiesceRpcProcess, type QuiesceTarget, type QuiesceOptions } from "./session-quiesce";
export { switchRuntimeSlot, type SwitchRuntimeResult } from "./runtime-switch";

export {
  PI_RPC_COMMANDS_0_83,
  UNSUPPORTED_RPC_COMMANDS,
  PI_RPC_GET_STATE_FIELDS,
  LEGACY_FAKE_STATE_FIELDS,
  isPiRpcCommand,
  isUnsupportedRpcCommand,
  unsupportedCommand,
  isUnsupportedResult,
  type PiRpcCommandName,
  type UnsupportedCommandResult,
} from "./rpc-capabilities";
export {
  projectRpcAgentState,
  type ProjectedAgentState,
  type ProjectRpcStateInput,
  type ContextUsageSnapshot,
  type QueuedMessagesSnapshot,
} from "./project-rpc-state";
