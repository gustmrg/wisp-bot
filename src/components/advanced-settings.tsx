import type { ReactNode } from "react";

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

/** Settings most people leave alone, folded under "Advanced"; it starts open when one of them holds a value. */
export function AdvancedSettings({
  defaultOpen = false,
  className,
  children,
}: {
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Accordion defaultValue={defaultOpen ? ["advanced"] : []} className={className}>
      <AccordionItem value="advanced">
        <AccordionTrigger className="py-2 text-xs font-normal text-dim">Advanced</AccordionTrigger>
        <AccordionContent keepMounted>{children}</AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}
