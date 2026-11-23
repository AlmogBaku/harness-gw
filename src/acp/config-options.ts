import {
  SessionConfigOption,
  type SessionConfigSelect,
  type SessionConfigSelectGroup,
  type SessionConfigSelectOption,
  type SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk/experimental/v2/unstable"

import type { SessionModelsResponse } from "../../protocol"

import type { ConfigOptionsOf, ConfigWriteOf } from "./types"

const MODEL_CONFIG_ID = "model"
const THOUGHT_CONFIG_ID = "thought_level"
/** The thought level a Session runs at while the provider reports none. */
const DEFAULT_EFFORT = ""
/** The group a current model the catalog does not list is offered in. */
const CURRENT_GROUP = { groupId: "current", name: "Current" }

/**
 * One ACP group per provider, in the order the catalog first names them, each
 * model once. ACP requires the current value to be one of the values, so a
 * current model the catalog does not list, as a switch reported mid-turn may
 * name, leads in a group of its own, under its id.
 */
function modelGroupsOf({
  selectedId,
  options,
}: SessionModelsResponse): SessionConfigSelectGroup[] {
  const groups = new Map<string, SessionConfigSelectGroup>()
  const listed = new Set<string>()
  for (const { id, label, group } of options) {
    if (listed.has(id)) continue
    listed.add(id)
    const known = groups.get(group)
    if (known) known.options.push({ value: id, name: label })
    else
      groups.set(group, {
        groupId: group,
        name: group,
        options: [{ value: id, name: label }],
      })
  }
  return [
    ...(listed.has(selectedId)
      ? []
      : [
          {
            ...CURRENT_GROUP,
            options: [{ value: selectedId, name: selectedId }],
          },
        ]),
    ...groups.values(),
  ]
}

/**
 * The selected model's thought levels, each once, from lowest to highest as
 * ACP asks, with the current one where the ladder lacks it: the provider's
 * own default, which reports no effort and is a choice of its own rather than
 * a claim to one of the ladder's ids, leads it; an effort it reports off the
 * ladder, whose rank nothing tells, follows it under its id. The default is
 * offered only while it holds, so choosing it asks the provider for no
 * change.
 */
function effortChoicesOf(
  current: string,
  efforts: NonNullable<SessionModelsResponse["options"][number]["efforts"]>
): SessionConfigSelectOption[] {
  const ladder = new Map<string, SessionConfigSelectOption>()
  // ACP requires a name; an effort the provider left unnamed goes by its id.
  for (const { id, name } of efforts)
    if (!ladder.has(id)) ladder.set(id, { value: id, name: name ?? id })
  if (ladder.has(current)) return [...ladder.values()]
  if (current === DEFAULT_EFFORT)
    return [{ value: current, name: "Default" }, ...ladder.values()]
  return [...ladder.values(), { value: current, name: current }]
}

export const configOptionsOf = ((models) => {
  const options: SessionConfigOption[] = []
  // ACP refuses a select with no choices, so an empty catalog offers none.
  if (models.options.length)
    options.push({
      type: "select",
      configId: MODEL_CONFIG_ID,
      name: "Model",
      category: "model",
      currentValue: models.selectedId,
      options: modelGroupsOf(models),
    })
  const efforts = models.options.find(
    (option) => option.id === models.selectedId
  )?.efforts
  if (efforts?.length) {
    const current = models.effortId ?? DEFAULT_EFFORT
    options.push({
      type: "select",
      configId: THOUGHT_CONFIG_ID,
      name: "Thought level",
      category: "thought_level",
      currentValue: current,
      options: effortChoicesOf(current, efforts),
    })
  }
  return options
}) satisfies ConfigOptionsOf

export const configWriteOf = ((configId, value) => {
  if (typeof value !== "string") return undefined
  if (configId === MODEL_CONFIG_ID) return { selectedId: value }
  if (configId === THOUGHT_CONFIG_ID) return { effortId: value }
  return undefined
}) satisfies ConfigWriteOf

/** Every value a select offers, whether flat or in groups. */
function selectValues({ options }: SessionConfigSelect) {
  const entries: ReadonlyArray<
    SessionConfigSelectOption | SessionConfigSelectGroup
  > = options
  return entries.flatMap((entry) =>
    "groupId" in entry ? entry.options.map(({ value }) => value) : [entry.value]
  )
}

/**
 * Whether `options` offers what a `session/set_config_option` request asks:
 * an option its `configId` names, the value `type` that option takes, and one
 * of its values. ACP refuses anything else with `-32602`, changing nothing.
 */
export function offers(
  options: readonly SessionConfigOption[],
  {
    configId,
    type,
    value,
  }: Pick<SetSessionConfigOptionRequest, "configId" | "type" | "value">
) {
  const option = options.find((offered) => offered.configId === configId)
  if (!option) return false
  if (SessionConfigOption.isSelect(option))
    return (
      type === "id" &&
      typeof value === "string" &&
      selectValues(option).includes(value)
    )
  if (SessionConfigOption.isBoolean(option))
    return type === "boolean" && typeof value === "boolean"
  return false
}
