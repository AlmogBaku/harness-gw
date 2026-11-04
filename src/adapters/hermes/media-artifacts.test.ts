import { describe, expect, it } from "vitest"

import {
  HermesMediaTextFilter,
  projectHermesAttachedImages,
  projectHermesMediaText,
  publishedArtifact,
} from "./media-artifacts"

const imagePath = "/home/alice/.hermes/images/upload_20260920_024035_1.png"

describe("Hermes native media projection", () => {
  it("redacts a MEDIA line naming a sensitive file without granting an artifact", () => {
    const filter = new HermesMediaTextFilter()
    const output = [
      filter.write("MEDIA:"),
      filter.write("/home/alice/.hermes/auth.json"),
      filter.finish(),
    ].join("")

    expect(output).toBe("[Media unavailable]")
    expect(filter.takeArtifacts()).toEqual([])
  })

  it("turns an assistant MEDIA line into one artifact and drops it from prose", () => {
    const reportPath = "/home/alice/reports/q3 summary.pdf"
    const filter = new HermesMediaTextFilter()
    const streamed = [
      filter.write("The report is ready.\nMEDIA:`/home/alice/rep"),
      filter.write("orts/q3 summary.pdf`\nMEDIA:/home/alice/reports/q3"),
      filter.write(" summary.pdf\nMEDIA:/home/alice/data.bin\nAnything else?"),
      filter.finish(),
    ].join("")
    const artifacts = filter.takeArtifacts()

    expect(streamed).toBe(
      "The report is ready.\nMEDIA:/home/alice/reports/q3 summary.pdf\nAnything else?"
    )
    expect(artifacts.map(({ descriptor }) => descriptor)).toEqual([
      {
        id: expect.stringMatching(/^hermes-media-[a-f0-9]{32}$/u),
        filename: "q3 summary.pdf",
        mimeType: "application/pdf",
        source: { type: "provider", reference: artifacts[0]?.descriptor.id },
      },
      {
        id: expect.stringMatching(/^hermes-media-[a-f0-9]{32}$/u),
        filename: "data.bin",
        source: { type: "provider", reference: artifacts[1]?.descriptor.id },
      },
    ])
    expect(
      JSON.stringify(artifacts.map(({ descriptor }) => descriptor))
    ).not.toContain("/home/")
    expect(artifacts[0]?.reference).toBe(reportPath)
  })

  it("derives the same MEDIA-line id live, on replay, and on a read", () => {
    const text = "Chart attached.\nMEDIA:/home/alice/reports/chart.png"
    const live = new HermesMediaTextFilter()
    for (const chunk of text.match(/.{1,5}/gsu) ?? []) live.write(chunk)
    live.finish()
    const [streamed] = live.takeArtifacts()
    const replayed = projectHermesMediaText(text)

    expect(replayed.text).toBe("Chart attached.")
    expect(replayed.artifacts.map(({ descriptor }) => descriptor)).toEqual([
      streamed?.descriptor,
    ])
    expect(
      publishedArtifact(
        [{ role: "assistant", content: text }],
        streamed!.descriptor.id
      )
    ).toEqual({
      reference: "/home/alice/reports/chart.png",
      filename: "chart.png",
    })
  })

  it("preserves blank lines that delimit Markdown blocks", () => {
    const markdown = [
      "- Last list item",
      "",
      "**Candidates:**",
      "",
      "| # | Idea |",
      "|---|---|",
      "| 1 | DevTools |",
      "",
      "**Pick:** DevTools",
    ].join("\n")

    expect(projectHermesMediaText(markdown).text).toBe(markdown)
  })
})

describe("Hermes attached image directives", () => {
  it("projects an attached image as an opaque artifact, never as prose", () => {
    const projected = projectHermesAttachedImages(
      `do u see it?\n@image:${imagePath}`
    )

    expect(projected.text).toBe("do u see it?")
    expect(projected.artifacts).toHaveLength(1)
    expect(projected.artifacts[0]).toMatchObject({
      reference: imagePath,
      descriptor: {
        filename: "upload_20260920_024035_1.png",
        mimeType: "image/png",
      },
    })
    expect(projected.artifacts[0]?.descriptor.id).toMatch(
      /^hermes-media-[a-f0-9]{32}$/u
    )
    expect(projected.artifacts[0]?.descriptor.source).toEqual({
      type: "provider",
      reference: projected.artifacts[0]?.descriptor.id,
    })
    expect(JSON.stringify(projected.artifacts[0]?.descriptor)).not.toContain(
      "/home/"
    )
  })

  it("reads the model-only image form a mid-turn compaction persists as the same image", () => {
    const other = imagePath.replace("_1.png", "_2.png")
    const block = (path: string) =>
      `[The user attached an image: ${path.split("/").at(-1)}]\n[Examine it with the vision_analyze tool using image_url: ${path}]`
    const projected = projectHermesAttachedImages(
      `${block(imagePath)}\n\n${block(other)}\n\nthese images bg is not transparent!`
    )

    expect(projected.text).toBe("these images bg is not transparent!")
    expect(projected.artifacts.map(({ descriptor }) => descriptor.id)).toEqual(
      [
        ...projectHermesAttachedImages(
          `x\n@image:${imagePath}\n@image:${other}`
        ).artifacts,
      ].map(({ descriptor }) => descriptor.id)
    )
    expect(projected.artifacts).toHaveLength(2)
  })

  it("keeps a directive out of the prose even when it grants no artifact", () => {
    const projected = projectHermesAttachedImages(
      "check this\n@image:/home/alice/.hermes/images/notes.txt"
    )

    expect(projected.text).toBe("check this")
    expect(projected.artifacts).toEqual([])
  })

  it("grants one artifact per attached reference", () => {
    const projected = projectHermesAttachedImages(
      `two refs\n@image:${imagePath}\n@image:${imagePath}`
    )

    expect(projected.artifacts).toHaveLength(1)
  })

  it("resolves an attached image through its opaque artifact id", () => {
    const rows = [
      {
        role: "user",
        text: `do u see it?\n@image:${imagePath}`,
      },
    ]
    const [image] = projectHermesAttachedImages(String(rows[0]!.text)).artifacts

    expect(publishedArtifact(rows, image!.descriptor.id)).toEqual({
      reference: imagePath,
      filename: "upload_20260920_024035_1.png",
    })
    expect(
      publishedArtifact(rows, "hermes-media-" + "0".repeat(32))
    ).toBeUndefined()
  })

  it("refuses an attached image no durable user row carries", () => {
    const [image] = projectHermesAttachedImages(`@image:${imagePath}`).artifacts

    expect(
      publishedArtifact(
        [{ role: "assistant", text: `@image:${imagePath}` }],
        image!.descriptor.id
      )
    ).toBeUndefined()
  })
})
