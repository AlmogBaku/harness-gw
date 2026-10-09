import type { GuestInvitationService } from "../auth/guest-invitation"
import {
  InvitationLinkError,
  issueInvitationLink,
} from "../auth/invitation-link"
import type { ServerRuntime } from "../core/runtime"
import { boundedJson, errorResponse } from "./http"
import type { GatewayRouteApp } from "./types"

export const GUEST_INVITATIONS_PATH = "/api/v1/guest-invitations"

export function registerInvitationRoutes(
  app: GatewayRouteApp,
  options: {
    guestPublicOrigin: string
    invitations: GuestInvitationService
    runtime: ServerRuntime
  }
) {
  app.post(GUEST_INVITATIONS_PATH, async (context) => {
    const input = await boundedJson(context.req.raw)
    if (input === undefined)
      return errorResponse(
        "invalid_request",
        400,
        "Body must be a JSON object (content-type: application/json, at most 16 KiB)."
      )
    try {
      const invitation = await issueInvitationLink(input, {
        invitations: options.invitations,
        publicOrigin: options.guestPublicOrigin,
      })
      const catalog = await options.runtime.listAgents()
      if (
        !catalog.agents.some(({ summary }) => summary.id === invitation.agentId)
      )
        return errorResponse(
          "not_found",
          404,
          `agent: no Agent named ${invitation.agentId}`
        )
      return context.json({ url: invitation.url }, 201)
    } catch (error) {
      if (error instanceof InvitationLinkError)
        return errorResponse("invalid_request", 400, error.message)
      throw error
    }
  })
}
