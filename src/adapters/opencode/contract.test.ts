import { captureLogs } from "../../../test/support/log-capture"
import { runServerRuntimeContract } from "../../core/runtime-contract"
import { composeOpenCodeRuntime } from "./factory"
import { fakeOpenCode, fakeOpenCodeClient } from "./test-utils/fake-opencode"

runServerRuntimeContract(
  "OpenCode",
  () => {
    const opencode = fakeOpenCode()
    const { runtime, engine, close } = composeOpenCodeRuntime({
      client: fakeOpenCodeClient(opencode),
      logger: captureLogs().logger,
    })
    return {
      ...opencode,
      runtime,
      records: () => engine!.retainedRecords,
      close,
    }
  },
  {
    callerErrors: [
      "runtime_authentication_required",
      "invalid_request",
      "revision_conflict",
    ],
    gaps: {
      typedMessageFields:
        "capability: OpenCode history carries no correction or turn error code",
      forkLeavesOriginal:
        "pending: forking through OpenCode's older route needs the live OpenCode check",
      // OpenCode's `task` tool appears to run only on its older prompt path, so
      // the fake cannot honestly spawn a child through a gateway turn.
      childAnnouncedFirst:
        "pending: whether gateway turns spawn children needs the live OpenCode check",
      // The list's filter on `parentID` is proven over the fake in adapter.test.ts.
      childrenStayUnlisted:
        "pending: whether gateway turns spawn children needs the live OpenCode check",
      rewindAsReported:
        "pending: rewind through OpenCode's revert needs the live OpenCode check",
    },
  }
)
