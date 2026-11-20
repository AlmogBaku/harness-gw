/**
 * A guest browser on the in-process ACP harness: an invitation to the
 * Session the harness's invitations address, redeemed over the guest
 * listener's own connection, on the operator harness's runtime and channels.
 */
import { methods } from "@agentclientprotocol/sdk/experimental/v2/unstable"

import {
  ACP_PROTOCOL_VERSION,
  HGW_AUTH_METHOD_INVITE,
  HGW_META_KEY,
} from "../../../protocol/acp"
import {
  AGENT,
  connectClient,
  type ClientAnswers,
  type harness,
} from "../../acp/test-harness"
import { createGuestInvitationService } from "../../auth/guest-invitation"
import { AttachmentStageRegistry } from "../../core/attachment-stages"
import { createGuestConnection } from "../acp"

/** The reference every invitation names. */
export const GUEST_REF = "guest-ref"

type Operator = Awaited<ReturnType<typeof harness>>

/** One invitation to the invited Session, which every tab it opens acts as. */
export async function invite(test: Operator) {
  const invitations = createGuestInvitationService({
    issuer: "aos-invite",
    audience: "aos-guest",
    deploymentId: "deployment-a",
    runtimeId: test.runtimeInstance.id,
    keys: [{ id: "current", secret: new Uint8Array(32).fill(7) }],
  })
  const { token } = await invitations.issue({ agentId: AGENT, ref: GUEST_REF })
  return { invitations, token }
}

export type Invitation = Awaited<ReturnType<typeof invite>>

/** A guest browser that redeemed an invitation to the invited Session. */
export async function connectGuest(
  test: Operator,
  answers: ClientAnswers = {},
  invitation?: Invitation
) {
  const { invitations, token } = invitation ?? (await invite(test))
  const context = createGuestConnection(
    {
      runtimeInstance: test.runtimeInstance,
      invitations,
      attachmentStages: new AttachmentStageRegistry(),
      channels: test.channels,
      catalog: test.catalog,
      guestActiveExecutions: 2,
      logger: test.logs.logger,
    },
    "guest-connection"
  )
  const { connection, recorder } = connectClient(context, {
    name: "aos-guest-browser",
    ...answers,
  })
  await connection.agent.request(methods.agent.initialize, {
    protocolVersion: ACP_PROTOCOL_VERSION,
    info: { name: "aos-guest-browser", version: "1" },
    capabilities: {
      elicitation: { form: {} },
      _meta: { [HGW_META_KEY]: { historyPages: true } },
    },
  })
  await connection.agent.request(methods.agent.auth.login, {
    methodId: HGW_AUTH_METHOD_INVITE,
    _meta: { [HGW_META_KEY]: { token } },
  })
  return {
    agent: connection.agent,
    recorder,
    close: () => connection.close(),
  }
}
