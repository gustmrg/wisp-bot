import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AppLinkProvider } from "@/components/app-link";
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
    expect((html.match(/<strong class="font-semibold">/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toContain("<ul");
    expect(html).toContain("<pre");
    expect(html).toContain("<h3");
    expect(html).toContain("<blockquote");
    expect(html).toContain('href="https://example.com" target="_blank" rel="noreferrer noopener"');
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

describe("MarkdownView app links", () => {
  it("turns a wisp:// link into a button that opens its screen", async () => {
    const open = vi.fn();
    const user = userEvent.setup();
    render(
      <AppLinkProvider value={open}>
        <MarkdownView text="Open [AI Model settings](wisp://settings/model) or [Skills](wisp://wisp/skills)." />
      </AppLinkProvider>,
    );

    await user.click(screen.getByRole("button", { name: "AI Model settings" }));
    await user.click(screen.getByRole("button", { name: "Skills" }));

    expect(open.mock.calls).toEqual([
      [{ scope: "settings", section: "model" }],
      [{ scope: "wisp", section: "skills" }],
    ]);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows app links as text where nothing can open them", () => {
    const html = renderToStaticMarkup(<MarkdownView text="See [Storage](wisp://settings/storage)." />);

    expect(html).toContain('<span class="font-medium">Storage</span>');
    expect(html).not.toContain("wisp:");
  });

  it("drops wisp:// links to screens that do not exist", () => {
    const html = renderToStaticMarkup(<MarkdownView text="See [Billing](wisp://settings/billing)." />);

    expect(html).toContain(">Billing</a>");
    expect(html).not.toContain("wisp:");
  });
});
