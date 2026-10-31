import { useCallback, useState } from "react";
import type { ReactElement } from "react";

import type { ModelSelection } from "../../shared/contracts";
import type { WispTemplateEntry } from "../../shared/wisp-template";
import type { NewCircle, NewWisp, Wisp } from "@/chat-data";
import { CreateCirclePanel } from "@/components/create-circle-panel";
import { CreateWispPanel, type CreatePanelStatus } from "@/components/create-wisp-panel";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type CreateKind = "wisp" | "circle";

interface CreateChatDialogProps {
  /** Resolves with the new Wisp's conversation ID, or null when it could not be created. */
  onCreate: (
    wisp: NewWisp,
    options: { notifyOnUpdatesEnabled: boolean; model: ModelSelection | null },
  ) => Promise<string | null>;
  /** Resolves true once the circle exists; with it, the dialog offers a circle as well as a Wisp. */
  onCreateCircle?: (circle: NewCircle) => Promise<boolean>;
  /** The Wisps a new circle can gather. */
  wisps?: ReadonlyArray<Wisp>;
  /** Opens the templates, for someone who wants a Wisp ready for a job; without it they aren't offered. */
  onOpenTemplates?: () => void;
  /** The button that opens the dialog; without it, `open` and `onOpenChange` control it. */
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** A template the new Wisp starts from. */
  template?: WispTemplateEntry;
}

const TITLES: Record<CreateKind, string> = { wisp: "Create new Wisp", circle: "Create new circle" };
const IDLE: CreatePanelStatus = { description: "", saving: false, done: false };

/** Creates a Wisp or a circle; both drafts are kept while switching between them, and dropped on close. */
function CreateChatDialog({
  onCreate,
  onCreateCircle,
  wisps = [],
  onOpenTemplates,
  trigger,
  open: controlledOpen,
  onOpenChange,
  template,
}: CreateChatDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  const [kind, setKind] = useState<CreateKind>("wisp");
  // A new key remounts both panels, which clears their drafts.
  const [draftKey, setDraftKey] = useState(0);
  const [statuses, setStatuses] = useState<Record<CreateKind, CreatePanelStatus>>({ wisp: IDLE, circle: IDLE });
  const saving = statuses.wisp.saving || statuses.circle.saving;
  const status = statuses[kind];
  const switchable = Boolean(onCreateCircle) && !statuses.wisp.done;

  const onWispStatus = useCallback(
    (next: CreatePanelStatus) => setStatuses((current) => ({ ...current, wisp: next })),
    [],
  );
  const onCircleStatus = useCallback(
    (next: CreatePanelStatus) => setStatuses((current) => ({ ...current, circle: next })),
    [],
  );

  function setOpen(nextOpen: boolean) {
    setUncontrolledOpen(nextOpen);
    onOpenChange?.(nextOpen);
    if (nextOpen) return;
    setKind("wisp");
    setDraftKey((key) => key + 1);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (saving) return;
        setOpen(nextOpen);
      }}
    >
      {trigger ? <DialogTrigger render={trigger} /> : null}

      <DialogContent
        mobileFullscreen
        // Held at the top rather than centered, so the header and its tabs stay put as the height follows each panel.
        viewportClassName="items-start pt-[min(12dvh,96px)]"
        className="flex max-h-[calc(100dvh-min(12dvh,96px)-16px)] max-w-[530px] flex-col"
      >
        {/* The tabs live in the header, so the root only gives them and the panels one state. */}
        <Tabs
          className="contents"
          value={kind}
          onValueChange={(value) => {
            if (!saving) setKind(value as CreateKind);
          }}
        >
          <DialogHeader className="flex-none">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <DialogTitle>{TITLES[kind]}</DialogTitle>
              {switchable ? (
                <TabsList className="flex-none" aria-label="What to create">
                  <TabsTrigger value="wisp" disabled={saving}>
                    Wisp
                  </TabsTrigger>
                  <TabsTrigger value="circle" disabled={saving}>
                    Circle
                  </TabsTrigger>
                </TabsList>
              ) : null}
            </div>
            <DialogDescription>
              {kind === "circle" && wisps.length === 0
                ? "A circle gathers Wisps you already have."
                : status.description}
            </DialogDescription>
          </DialogHeader>
          <TabsContent className="flex min-h-0 flex-1 flex-col" value="wisp" keepMounted>
            <CreateWispPanel
              // Starting from another template is a new draft.
              key={`${draftKey}:${template?.id ?? ""}`}
              {...(template ? { template: template.template } : {})}
              active={open}
              onCreate={onCreate}
              onStatusChange={onWispStatus}
              onDone={() => setOpen(false)}
              {...(onOpenTemplates
                ? {
                    onOpenTemplates: () => {
                      setOpen(false);
                      onOpenTemplates();
                    },
                  }
                : {})}
            />
          </TabsContent>
          {onCreateCircle ? (
            <TabsContent className="flex min-h-0 flex-1 flex-col" value="circle" keepMounted>
              {wisps.length > 0 ? (
                <CreateCirclePanel
                  key={draftKey}
                  wisps={wisps}
                  onCreate={onCreateCircle}
                  onStatusChange={onCircleStatus}
                  onDone={() => setOpen(false)}
                />
              ) : (
                <div className="flex flex-col items-start gap-3 px-1">
                  <p className="m-0 text-base text-dim">Create a Wisp first, then bring it into a circle.</p>
                  <Button variant="outline" type="button" onClick={() => setKind("wisp")}>
                    Create a Wisp
                  </Button>
                </div>
              )}
            </TabsContent>
          ) : null}
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

export { CreateChatDialog };
export type { CreateChatDialogProps };
