import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { isPdfFile, MAX_PDF_PAGE_IMAGES_PER_READ, readPdf } from "../backend/pdf-reader.js";
import { buildPdf, type PdfFixturePage } from "./helpers/pdf-fixture.js";

const INVOICE_TEXT = "Invoice 42 issued to Example Company for consulting services";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64").slice(0, 4);

async function writePdf(pages: ReadonlyArray<PdfFixturePage>, name = "document.pdf"): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pdf-"));
  const file = path.join(directory, name);
  await writeFile(file, buildPdf(pages));
  return file;
}

function text(result: Awaited<ReturnType<typeof readPdf>>): string {
  const block = result.content[0];
  return block?.type === "text" ? block.text : "";
}

describe("readPdf", () => {
  it("returns page text and attaches pages without text as images for vision models", async () => {
    const file = await writePdf([{ text: INVOICE_TEXT }, { scan: true }]);

    const result = await readPdf(file, { supportsImages: true });

    expect(text(result)).toContain("PDF document, 2 pages. Showing pages 1–2.");
    expect(text(result)).toContain(`--- Page 1 ---\n${INVOICE_TEXT}`);
    expect(text(result)).toContain("--- Page 2 (no text layer; attached as image 1) ---");
    expect(result.content).toHaveLength(2);
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(result.content[1]?.type === "image" && result.content[1].data.startsWith(PNG_SIGNATURE)).toBe(true);
    expect(result.details.pdf).toEqual({ pageCount: 2, firstPage: 1, lastPage: 2, renderedPages: [2] });
  });

  it("explains scanned pages instead of rendering them when the model cannot see images", async () => {
    const file = await writePdf([{ text: INVOICE_TEXT }, { scan: true }]);

    const result = await readPdf(file, { supportsImages: false });

    expect(result.content).toHaveLength(1);
    expect(text(result)).toContain(INVOICE_TEXT);
    expect(text(result)).toContain("--- Page 2 (no text layer; likely scanned) ---");
    expect(text(result)).toContain("The current model does not support images");
  });

  it("reads a page range and says where to continue", async () => {
    const file = await writePdf(
      Array.from({ length: 4 }, (_, index) => ({ text: `${INVOICE_TEXT}, page ${index + 1}` })),
    );

    const result = await readPdf(file, { offset: 2, limit: 2, supportsImages: true });

    expect(text(result)).toContain("Showing pages 2–3.");
    expect(text(result)).not.toContain("page 1\n");
    expect(text(result)).toContain(`${INVOICE_TEXT}, page 3`);
    expect(text(result)).not.toContain(`${INVOICE_TEXT}, page 4`);
    expect(text(result)).toContain("Continue with offset=4.");
    await expect(readPdf(file, { offset: 5, supportsImages: true })).rejects.toMatchObject({
      code: "invalid_request",
      message: expect.stringContaining("beyond the end"),
    });
  });

  it("caps the images in one read and continues from the first page left out", async () => {
    const file = await writePdf(
      Array.from({ length: MAX_PDF_PAGE_IMAGES_PER_READ + 2 }, () => ({ scan: true }) as const),
    );

    const result = await readPdf(file, { supportsImages: true });

    expect(result.content.filter(({ type }) => type === "image")).toHaveLength(MAX_PDF_PAGE_IMAGES_PER_READ);
    expect(result.details.pdf.lastPage).toBe(MAX_PDF_PAGE_IMAGES_PER_READ);
    expect(text(result)).toContain(`Continue with offset=${MAX_PDF_PAGE_IMAGES_PER_READ + 1}.`);
  });

  it("rejects a damaged PDF with a readable error", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "wisp-pdf-"));
    const file = path.join(directory, "broken.pdf");
    await writeFile(file, "%PDF-1.4\nthis is not a real document");

    await expect(readPdf(file, { supportsImages: true })).rejects.toMatchObject({
      code: "invalid_request",
      message: "This PDF is damaged or not a valid PDF file.",
    });
  });
});

describe("isPdfFile", () => {
  it("recognizes PDFs by their content, not their name", async () => {
    const pdf = await writePdf([{ text: INVOICE_TEXT }], "renamed.txt");
    const directory = path.dirname(pdf);
    const notPdf = path.join(directory, "fake.pdf");
    await writeFile(notPdf, "plain text");

    await expect(isPdfFile(pdf)).resolves.toBe(true);
    await expect(isPdfFile(notPdf)).resolves.toBe(false);
    await expect(isPdfFile(path.join(directory, "missing.pdf"))).resolves.toBe(false);
  });
});
