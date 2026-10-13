import { runWireContract } from "../../acp/wire-contract"
import { inviteSessionKey } from "../../core/invite-key"
import { coordinatedRuntime } from "../create-coordinator"
import { composeOpenCodeRuntime } from "./factory"
import {
  fakeOpenCode,
  fakeOpenCodeClient,
  PROJECT_DIRECTORY,
} from "./test-utils/fake-opencode"

runWireContract(
  "OpenCode",
  () => {
    const opencode = fakeOpenCode()
    return {
      config: {
        id: "opencode-contract",
        kind: "opencode",
        baseUrl: "http://127.0.0.1:4096",
        directory: PROJECT_DIRECTORY,
        username: "operator",
        passwordFile: "/run/secrets/opencode-password",
      },
      runtimeFactory: async (config, limits, { logger, mcpServerOverrides }) =>
        coordinatedRuntime(
          config.id,
          composeOpenCodeRuntime({
            client: fakeOpenCodeClient(opencode),
            logger,
            mcpServerOverrides,
          }),
          limits,
          logger
        ),
      agentId: opencode.scope.agentId,
      folder: PROJECT_DIRECTORY,
      turn: opencode.turn,
      // OpenCode finds an invited Session by its title.
      async invite(ref, said) {
        opencode.storeSession(inviteSessionKey(ref), said)
        return opencode.scope.sessionId
      },
      rewinds: () => opencode.reverts(),
    }
  },
  {
    gaps: {
      forkJoinsNewSession:
        "pending: forking through OpenCode's older route needs the live OpenCode check",
      // OpenCode's `task` tool appears to run only on its older prompt path, so
      // the fake cannot honestly spawn a child through a gateway turn.
      childAnnouncedBeforeItsEvents:
        "pending: whether gateway turns spawn children needs the live OpenCode check",
      // The Session reports rewind unavailable (`native-rewind-unproven`),
      // which the row checks in its place.
      rewindReplacesTurn:
        "pending: rewind through OpenCode's revert needs the live OpenCode check",
      // Every question and permission carries a presentable form, so the
      // adapter holds none back, and OpenCode lists each pending one
      // (`GET /api/session/{sessionID}/question` and `…/permission`), so a
      // restarted gateway presents it again rather than losing it.
      heldAndLostQuestions:
        "OpenCode holds no question back and lists every pending one",
      // OpenCode reports edits as `patch` parts and `session.diff` events
      // (`SnapshotFileDiff`), which the adapter does not map yet.
      diffAddedWithGitPatchOrNone: "the adapter maps no OpenCode file change",
      // `Session.cost` exists, but the pinned SDK reads no context window, so
      // the adapter reports no usage to carry it (`opencode/adapter.ts:466`).
      costInUsageUpdate: "the adapter reads no OpenCode usage to carry a cost",
      // `Session.title` and `Session.time` are required: OpenCode stores and
      // titles a Session as it creates it.
      unsavedSessionUndated: "OpenCode stores every Session at creation",
      // `ProviderConfig` model `variants` are not mapped to efforts yet
      // (`opencode/adapter.ts:454`), so no thought level is offered.
      thoughtLevelDefault: "the adapter offers no OpenCode thought level",
      // OpenCode streams every part it stores (`message.part.updated`) and
      // has no setting that withholds tool or reasoning parts.
      quietStreamPassedThrough: "OpenCode has no quieter stream",
    },
  }
)
