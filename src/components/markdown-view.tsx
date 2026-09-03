import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";

const markdownComponents: Components = {
  a: ({ node: _node, ...props }) => <a className="text-blue underline underline-offset-2" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote
      className="my-1.5 border-l-2 border-black/15 pl-2.5 text-dim first:mt-0 last:mb-0 dark:border-white/15"
      {...props}
    />
  ),
  code: ({ node: _node, ...props }) => (
    <code
      className="rounded-[4px] bg-black/[0.05] px-[5px] py-px font-mono text-[12px] dark:bg-white/[0.08]"
      {...props}
    />
  ),
  pre: ({ node: _node, ...props }) => (
    <pre
      className={cn(
        "my-1.5 overflow-x-auto rounded-lg bg-black/[0.055] p-2.5 leading-[1.5] first:mt-0 last:mb-0 dark:bg-white/[0.07]",
        "[&>code]:rounded-none [&>code]:bg-transparent [&>code]:p-0",
      )}
      {...props}
    />
  ),
  h1: ({ node: _node, ...props }) => (
    <h1 className="mb-1 mt-2.5 text-[14.5px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  h2: ({ node: _node, ...props }) => (
    <h2 className="mb-1 mt-2.5 text-[13.5px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  h3: ({ node: _node, ...props }) => (
    <h3 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  h4: ({ node: _node, ...props }) => (
    <h4 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  h5: ({ node: _node, ...props }) => (
    <h5 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  h6: ({ node: _node, ...props }) => (
    <h6 className="mb-1 mt-2 text-[13px] font-semibold first:mt-0 last:mb-0" {...props} />
  ),
  img: ({ node: _node, ...props }) => <img className="max-w-full rounded-lg" {...props} />,
  ol: ({ node: _node, ...props }) => (
    <ol className="my-1.5 ml-5 list-decimal space-y-0.5 first:mt-0 last:mb-0" {...props} />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="my-1.5 ml-5 list-disc space-y-0.5 first:mt-0 last:mb-0" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  p: ({ node: _node, ...props }) => <p className="my-1.5 first:mt-0 last:mb-0" {...props} />,
  hr: ({ node: _node, ...props }) => <hr className="my-2.5 border-black/[0.08] dark:border-white/[0.08]" {...props} />,
  strong: ({ node: _node, ...props }) => <strong className="font-[650]" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-2 overflow-x-auto first:mt-0 last:mb-0">
      <table className="w-full border-collapse text-left" {...props} />
    </div>
  ),
  th: ({ node: _node, ...props }) => (
    <th
      className="border-b border-black/20 px-2 py-1 font-semibold whitespace-nowrap dark:border-white/20"
      {...props}
    />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-black/[0.07] px-2 py-1 align-top dark:border-white/[0.07]" {...props} />
  ),
};

function MarkdownView({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  );
}

export { MarkdownView };
