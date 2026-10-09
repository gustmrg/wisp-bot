/** A page with a line of text, or without text, like a scanned page holding only an image. */
export type PdfFixturePage = { text: string } | { scan: true };

/** Builds a small, valid PDF in memory, so tests need no binary fixtures. */
export function buildPdf(pages: ReadonlyArray<PdfFixturePage>): Buffer {
  const objects: string[] = [];
  const add = (body: string) => objects.push(body);
  const catalog = add("");
  const pageTree = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids: number[] = [];
  for (const page of pages) {
    let content: string;
    let resources: string;
    if ("text" in page) {
      content = `BT /F1 12 Tf 72 720 Td (${page.text.replace(/[()\\]/gu, "\\$&")}) Tj ET`;
      resources = `<< /Font << /F1 ${font} 0 R >> >>`;
    } else {
      const pixels = Buffer.alloc(16 * 16, 0x80).toString("hex");
      const image = add(
        `<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${pixels.length + 1} >>\nstream\n${pixels}>\nendstream`,
      );
      content = "q 400 0 0 400 100 300 cm /Im1 Do Q";
      resources = `<< /XObject << /Im1 ${image} 0 R >> >>`;
    }
    const stream = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    kids.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] /Contents ${stream} 0 R /Resources ${resources} >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] =
    `<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(" ")}] /Count ${kids.length} >>`;

  let output = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output, "latin1"));
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output, "latin1");
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output, "latin1");
}
