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
        "pending: OpenCode forks only if the live check of its older route passes",
      childAnnouncedFirst:
        "pending: the live check decides whether gateway turns spawn children",
      childrenStayUnlisted:
        "pending: the OpenCode lane filters children by parentID",
      compactionStoredAsRow:
        "pending: the OpenCode lane stores its compaction as a compaction row",
      rewindAsReported:
        "pending: OpenCode reports no rewind until revert passes the live check",
    },
  }
)
