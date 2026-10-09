import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { WispBackendError } from "./backend-error.js";

/** Most pages one read returns, so a long document is read in steps. */
export const MAX_PDF_PAGES_PER_READ = 20;
/** Most page images one read attaches; each one costs the model input tokens. */
export const MAX_PDF_PAGE_IMAGES_PER_READ = 5;
/** Text budget for one read, kept under the tool output limit so the page notes survive. */
const MAX_PDF_TEXT_BYTES = 48_000;
const MAX_PDF_FILE_BYTES = 100 * 1024 * 1024;
/** Pages with fewer visible characters than this are treated as scans and rendered. */
const MIN_PAGE_TEXT_CHARACTERS = 40;
/** Longest side of a rendered page; providers scale larger images down anyway. */
const MAX_PAGE_IMAGE_EDGE = 1568;
const PDF_SIGNATURE = "%PDF-";
/** The specification lets the signature start anywhere in the first kilobyte. */
const SIGNATURE_WINDOW_BYTES = 1024;

export interface PdfReadOptions {
  /** First page to return, starting at 1. */
  offset?: number;
  /** Most pages to return, capped at MAX_PDF_PAGES_PER_READ. */
  limit?: number;
  /** Whether the current model accepts images; pages without text are rendered only then. */
  supportsImages: boolean;
  signal?: AbortSignal;
}

export type PdfContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface PdfReadResult {
  content: PdfContentBlock[];
  details: { pdf: { pageCount: number; firstPage: number; lastPage: number; renderedPages: number[] } };
}

export async function isPdfFile(filePath: string): Promise<boolean> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return false;
  try {
    const buffer = Buffer.alloc(SIGNATURE_WINDOW_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(PDF_SIGNATURE, 0, "latin1");
  } finally {
    await handle.close();
  }
}

/**
 * Reads a PDF page by page: the text of each page, and an image of each page
 * without text (usually a scan) when the model can see images. Parsing runs
 * with XFA forms and font loading disabled; the file is never executed.
 */
export async function readPdf(filePath: string, options: PdfReadOptions): Promise<PdfReadResult> {
  const { size } = await stat(filePath);
  if (size > MAX_PDF_FILE_BYTES) {
    throw new WispBackendError("invalid_request", "This PDF is larger than 100 MB and cannot be read.");
  }
  const pdfjs = await loadPdfjs();
  const assets = pdfjsAssetDirectory();
  const task = pdfjs.getDocument({
    data: new Uint8Array(await readFile(filePath)),
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    verbosity: 0,
    cMapUrl: `${path.join(assets, "cmaps")}${path.sep}`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(assets, "standard_fonts")}${path.sep}`,
    wasmUrl: `${path.join(assets, "wasm")}${path.sep}`,
    iccUrl: `${path.join(assets, "iccs")}${path.sep}`,
  });
  const abort = () => void task.destroy();
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const document = await task.promise.catch((error: unknown) => {
      throw describePdfError(error);
    });
    const pageCount = document.numPages;
    const firstPage = Math.max(1, Math.floor(options.offset ?? 1));
    if (firstPage > pageCount) {
      throw new WispBackendError(
        "invalid_request",
        `Page ${firstPage} is beyond the end of this PDF (${pageCount} ${pageCount === 1 ? "page" : "pages"}).`,
      );
    }
    const pageLimit = Math.min(
      MAX_PDF_PAGES_PER_READ,
      Math.max(1, Math.floor(options.limit ?? MAX_PDF_PAGES_PER_READ)),
    );
    const sections: string[] = [];
    const images: PdfContentBlock[] = [];
    const renderedPages: number[] = [];
    let textBytes = 0;
    let lastPage = firstPage - 1;
    let unreadable = 0;
    for (let number = firstPage; number <= Math.min(pageCount, firstPage + pageLimit - 1); number += 1) {
      throwIfAborted(options.signal);
      const page = await document.getPage(number);
      try {
        const text = await pageText(page);
        let section: string;
        if (visibleCharacters(text) >= MIN_PAGE_TEXT_CHARACTERS) {
          section = `--- Page ${number} ---\n${text}`;
        } else if (options.supportsImages && images.length < MAX_PDF_PAGE_IMAGES_PER_READ) {
          images.push({ type: "image", data: await renderPage(page), mimeType: "image/png" });
          renderedPages.push(number);
          section = `--- Page ${number} (no text layer; attached as image ${images.length}) ---${text ? `\n${text}` : ""}`;
        } else if (options.supportsImages) {
          // Out of images for this read: stop so the next read starts at this page.
          break;
        } else {
          unreadable += 1;
          section = `--- Page ${number} (no text layer; likely scanned) ---${text ? `\n${text}` : ""}`;
        }
        const bytes = Buffer.byteLength(section, "utf8");
        if (sections.length > 0 && textBytes + bytes > MAX_PDF_TEXT_BYTES) {
          if (renderedPages.at(-1) === number) {
            images.pop();
            renderedPages.pop();
          }
          break;
        }
        sections.push(section);
        textBytes += bytes;
        lastPage = number;
      } finally {
        page.cleanup();
      }
    }
    const notes = [
      `PDF document, ${pageCount} ${pageCount === 1 ? "page" : "pages"}. Showing ${firstPage === lastPage ? `page ${firstPage}` : `pages ${firstPage}–${lastPage}`}.`,
    ];
    if (unreadable > 0) {
      notes.push(
        "[Pages without a text layer are likely scanned. The current model does not support images, so their content cannot be read.]",
      );
    }
    if (lastPage < pageCount) notes.push(`[More pages remain. Continue with offset=${lastPage + 1}.]`);
    return {
      content: [{ type: "text", text: [notes[0], ...sections, ...notes.slice(1)].join("\n\n") }, ...images],
      details: { pdf: { pageCount, firstPage, lastPage, renderedPages } },
    };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await task.destroy().catch(() => undefined);
  }
}

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs", { with: { "resolution-mode": "import" }});
type PdfPage = Awaited<ReturnType<Awaited<ReturnType<Pdfjs["getDocument"]>["promise"]>["getPage"]>>;

let pdfjsModule: Promise<Pdfjs> | undefined;

function loadPdfjs(): Promise<Pdfjs> {
  pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsModule;
}

function pdfjsAssetDirectory(): string {
  return path.dirname(require.resolve("pdfjs-dist/package.json"));
}

async function pageText(page: PdfPage): Promise<string> {
  const content = await page.getTextContent();
  let text = "";
  for (const item of content.items) {
    if (!("str" in item)) continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function visibleCharacters(text: string): number {
  return text.replace(/\s/gu, "").length;
}

async function renderPage(page: PdfPage): Promise<string> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(MAX_PAGE_IMAGE_EDGE / Math.max(base.width, base.height), 3);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.max(1, Math.floor(viewport.width)), Math.max(1, Math.floor(viewport.height)));
  const context = canvas.getContext("2d");
  // Scans often have no background of their own; a transparent page reads as black to some models.
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({
    canvas: canvas as unknown as HTMLCanvasElement,
    canvasContext: context as unknown as CanvasRenderingContext2D,
    viewport,
  }).promise;
  return (await canvas.encode("png")).toString("base64");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Operation aborted");
}

function describePdfError(error: unknown): WispBackendError {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return new WispBackendError("invalid_request", "This PDF is password-protected and cannot be read.");
  }
  return new WispBackendError("invalid_request", "This PDF is damaged or not a valid PDF file.");
}
