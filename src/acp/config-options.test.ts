import { describe, expect, it } from "vitest"

import type { SessionModelsResponse } from "../../protocol"
import { configOptionsOf, configWriteOf, offers } from "./config-options"

const models: SessionModelsResponse = {
  selectedId: "sonnet",
  effortId: "medium",
  options: [
    {
      id: "sonnet",
      label: "Sonnet",
      group: "Anthropic",
      efforts: [{ id: "low" }, { id: "medium" }, { id: "high" }],
    },
    { id: "haiku", label: "Haiku", group: "Anthropic" },
  ],
}

describe("configOptionsOf", () => {
  it("offers the model catalog as one selector grouped by provider", () => {
    expect(configOptionsOf(models)[0]).toEqual({
      type: "select",
      configId: "model",
      name: "Model",
      category: "model",
      currentValue: "sonnet",
      options: [
        {
          groupId: "Anthropic",
          name: "Anthropic",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "haiku", name: "Haiku" },
          ],
        },
      ],
    })
  })

  it("keeps providers in first-seen order and their models in catalog order", () => {
    const interleaved: SessionModelsResponse = {
      selectedId: "sonnet",
      options: [
        { id: "sonnet", label: "Sonnet", group: "Anthropic" },
        { id: "gpt", label: "GPT", group: "OpenAI" },
        { id: "haiku", label: "Haiku", group: "Anthropic" },
      ],
    }

    expect(configOptionsOf(interleaved)[0]).toMatchObject({
      options: [
        {
          groupId: "Anthropic",
          options: [
            { value: "sonnet", name: "Sonnet" },
            { value: "haiku", name: "Haiku" },
          ],
        },
        { groupId: "OpenAI", options: [{ value: "gpt", name: "GPT" }] },
      ],
    })
  })

  it("offers the efforts of the selected model as the thought level", () => {
    expect(configOptionsOf(models)[1]).toEqual({
      type: "select",
      configId: "thought_level",
      name: "Thought level",
      category: "thought_level",
      currentValue: "medium",
      options: [
        { value: "low", name: "low" },
        { value: "medium", name: "medium" },
        { value: "high", name: "high" },
      ],
    })
  })

  it("carries the name a provider gave an effort", () => {
    const named: SessionModelsResponse = {
      selectedId: "sonnet",
      effortId: "low",
      options: [
        {
          id: "sonnet",
          label: "Sonnet",
          group: "Anthropic",
          efforts: [{ id: "turbo", name: "Turbo" }, { id: "low" }],
        },
      ],
    }

    expect(configOptionsOf(named)[1]).toMatchObject({
      options: [
        { value: "turbo", name: "Turbo" },
        { value: "low", name: "low" },
      ],
    })
  })

  it("offers the provider default as the current thought level while it applies", () => {
    const { effortId, ...withoutEffort } = models
    void effortId

    expect(configOptionsOf(withoutEffort)[1]).toMatchObject({
      configId: "thought_level",
      currentValue: "",
      options: [
        { value: "", name: "Default" },
        { value: "low", name: "low" },
        { value: "medium", name: "medium" },
        { value: "high", name: "high" },
      ],
    })
  })

  it.each([
    ["a model that reports no efforts", "haiku"],
    ["a selection outside the catalog", "opus"],
  ])("omits the thought level for %s", (_label, selectedId) => {
    expect(configOptionsOf({ ...models, selectedId })).toHaveLength(1)
  })

  // ACP requires the current value to be one of an option's values.
  it("lists a current model the catalog does not, leading in a group of its own under its id", () => {
    expect(configOptionsOf({ ...models, selectedId: "opus" })[0]).toMatchObject(
      {
        currentValue: "opus",
        options: [
          {
            groupId: "current",
            name: "Current",
            options: [{ value: "opus", name: "opus" }],
          },
          { groupId: "Anthropic" },
        ],
      }
    )
  })

  it("lists a current effort off the selected model's ladder, leading under its id", () => {
    expect(configOptionsOf({ ...models, effortId: "max" })[1]).toMatchObject({
      currentValue: "max",
      options: [
        { value: "max", name: "max" },
        { value: "low", name: "low" },
        { value: "medium", name: "medium" },
        { value: "high", name: "high" },
      ],
    })
  })

  // ACP requires each value once within its option, across groups too.
  it("lists each model and each effort once, however often the catalog names it", () => {
    const [sonnet, haiku] = models.options
    const repeated = configOptionsOf({
      ...models,
      options: [
        { ...sonnet!, efforts: [...sonnet!.efforts!, { id: "low" }] },
        haiku!,
        { ...haiku!, group: "Elsewhere" },
      ],
    })

    expect(repeated).toMatchObject([
      {
        options: [
          {
            groupId: "Anthropic",
            options: [
              { value: "sonnet", name: "Sonnet" },
              { value: "haiku", name: "Haiku" },
            ],
          },
        ],
      },
      {
        options: [
          { value: "low", name: "low" },
          { value: "medium", name: "medium" },
          { value: "high", name: "high" },
        ],
      },
    ])
  })

  // ACP refuses a select with no choices.
  it("offers no selector for an empty catalog", () => {
    expect(configOptionsOf({ selectedId: "sonnet", options: [] })).toEqual([])
  })
})

describe("configWriteOf", () => {
  it.each([
    ["model", "haiku", { selectedId: "haiku" }],
    ["thought_level", "high", { effortId: "high" }],
  ])("writes %s", (configId, value, expected) => {
    expect(configWriteOf(configId, value)).toEqual(expected)
  })

  it.each([
    ["an unknown option", "mode", "plan"],
    ["a non-string model", "model", 3],
    ["a missing thought level", "thought_level", undefined],
  ])("refuses %s", (_label, configId, value) => {
    expect(configWriteOf(configId, value)).toBeUndefined()
  })
})

describe("offers", () => {
  const offered = configOptionsOf(models)
  const { effortId, ...withoutEffort } = models
  void effortId

  it.each([
    ["a model in its provider's group", offered, "model", "haiku"],
    ["an effort of the selected model", offered, "thought_level", "high"],
    [
      "the default while no effort is set",
      configOptionsOf(withoutEffort),
      "thought_level",
      "",
    ],
  ])("takes %s", (_label, options, configId, value) => {
    expect(offers(options, { configId, type: "id", value })).toBe(true)
  })

  // ACP refuses an unknown option, a type it does not take, and a value it
  // does not offer, all alike.
  it.each([
    ["an unknown option", offered, "mode", "id", "plan"],
    ["a custom value type", offered, "model", "_vendor", "haiku"],
    ["a boolean for a select", offered, "model", "boolean", true],
    ["a value of another type", offered, "model", "id", 3],
    ["a model the catalog does not offer", offered, "model", "id", "opus"],
    ["an effort off the ladder", offered, "thought_level", "id", "max"],
    [
      "an effort for a model that reports none",
      configOptionsOf({ ...models, selectedId: "haiku" }),
      "thought_level",
      "id",
      "low",
    ],
    ["the default once an effort is set", offered, "thought_level", "id", ""],
  ] as const)("refuses %s", (_label, options, configId, type, value) => {
    expect(offers(options, { configId, type, value })).toBe(false)
  })
})
