/** `@harness-gw/sdk`: the browser client for the gateway's ACP and HTTP APIs. */
export {
  acpSocketUrl,
  createAcpConnection,
  isAuthenticationRequired,
  SILENT_LOGGER,
  type AcpConnectionOptions,
  type OwnerInspector,
  type PageSignals,
} from "./connection"
export type {
  AcpConnection,
  AcpConnectionOutage,
  AcpConnectionStatus,
  AcpHistoryPage,
  AcpPendingRequest,
  AcpSessionListener,
  AcpSessionReplayListener,
  AcpSessionState,
  AcpSessionUpdateListener,
} from "./types"
export {
  createAcpWorkspaceClient,
  type AcpWorkspaceClient,
  type AcpWorkspaceClientOptions,
} from "./acp-workspace-client"
export {
  createAcpComposerStore,
  foldTurnUsage,
  projectModels,
  type AcpModelProjection,
  type AcpTurnUsage,
} from "./acp-workspace-client-composer"
export {
  createAcpApprovals,
  isSettledApproval,
  type AcpApproval,
  type AcpApprovalOption,
  type AcpApprovals,
} from "./acp-approvals"
export { createAcpInteractions } from "./acp-interactions"
export { subscribeHgwNotification } from "./hgw-notification"
export { acpDebugEnabled, createAcpLogger, frameFields } from "./log"
export { PART_GRACE_MS } from "./limits"
export * from "./hgw-client"
export * from "./workspace"
export {
  backoffDelay,
  type LogFields,
  type Logger,
  type OwnerKind,
} from "../lifecycle"
