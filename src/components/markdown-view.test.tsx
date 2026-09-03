import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownView } from "@/components/markdown-view";

const sample = `Sim! Dentro do ambiente eu consigo usar ferramentas:

| Ferramenta | O que faz | Como usar |
|------------|----------|------------|
| **\`ls\`** | lista o conteúdo de um diretório | \`ls({ path: "src" })\` |
| **\`grep\`** | busca texto | \`grep({ pattern: "async" })\` |

- **negrito** em lista
- item com \`código inline\`

\`\`\`ts
const x = 1;
\`\`\`

### Heading

> citação

Parágrafo com [link](https://example.com) e quebra de linha simples
na segunda linha.`;

describe("MarkdownView static render", () => {
  it("renders GFM tables, lists, code, headings, quotes and breaks", () => {
    const html = renderToStaticMarkup(<MarkdownView text={sample} />);
    expect(html).toContain("<table");
    expect(html).toContain("<th");
    expect((html.match(/<strong class="font-\[650\]">/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("<ul");
    expect(html).toContain("<pre");
    expect(html).toContain("<h3");
    expect(html).toContain("<blockquote");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<br");
  });

  it("keeps loose ordered-list markers with their first paragraph", () => {
    const html = renderToStaticMarkup(<MarkdownView text={"1. First item\n\n2. Second item"} />);

    expect(html).toContain("[&amp;&gt;p]:my-0");
    expect(html).toContain("[&amp;&gt;p:first-child]:inline");
    expect(html).toContain(">First item</p>");
    expect(html).toContain(">Second item</p>");
  });
});
