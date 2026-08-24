import { useState } from "react"
import type { FormEvent } from "react"
import {
  CpuIcon,
  PlusIcon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import { Textarea } from "@/components/ui/textarea"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { AVATAR_COLORS, Wisp } from "@/components/wisp"
import type { AgentSettings, ReasoningEffort } from "@/chat-data"
import {
  DEFAULT_MODEL_DEFAULTS,
  PROVIDERS,
  REASONING_EFFORT_LABELS,
  type ModelDefaults,
} from "@/components/model-options"
import { cn } from "@/lib/utils"

type NewAgent = Pick<
  AgentSettings,
  | "description"
  | "isGroup"
  | "model"
  | "name"
  | "notifyOnUpdatesEnabled"
  | "provider"
  | "reasoningEffort"
> & {
  color: string
}

interface CreateAgentDialogProps {
  compact?: boolean
  defaults?: ModelDefaults
  onCreate: (agent: NewAgent) => void
}

const DEFAULT_COLOR = AVATAR_COLORS[0].value

function CreateAgentDialog({
  compact = false,
  defaults = DEFAULT_MODEL_DEFAULTS,
  onCreate,
}: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState<string>(DEFAULT_COLOR)
  const [overrideSettings, setOverrideSettings] = useState(false)
  const [provider, setProvider] = useState<string>(defaults.provider)
  const [model, setModel] = useState<string>(defaults.model)
  const [reasoningEffort, setReasoningEffort] = useState<
    "default" | ReasoningEffort
  >("default")
  const selectedProvider =
    PROVIDERS.find((option) => option.value === provider) ?? PROVIDERS[0]
  const selectedModel =
    selectedProvider.models.find((option) => option.value === model) ??
    selectedProvider.models[0]
  const defaultProvider =
    PROVIDERS.find((option) => option.value === defaults.provider) ?? PROVIDERS[0]
  const defaultModel =
    defaultProvider.models.find((option) => option.value === defaults.model) ??
    defaultProvider.models[0]
  const displayedProvider = overrideSettings
    ? selectedProvider
    : defaultProvider
  const displayedModel = overrideSettings ? selectedModel : defaultModel
  const reasoningEffortOptions: ReadonlyArray<{
    label: string
    value: "default" | ReasoningEffort
  }> = [
    { label: "Provider default", value: "default" },
    ...selectedModel.reasoningEfforts.map((effort) => ({
      label: REASONING_EFFORT_LABELS[effort],
      value: effort,
    })),
  ]
  const previewName = name.trim() || "New Wisp"
  const previewDescription =
    description.trim() || "Describe what this Wisp is responsible for."

  function resetForm() {
    setName("")
    setDescription("")
    setColor(DEFAULT_COLOR)
    setOverrideSettings(false)
    setProvider(defaults.provider)
    setModel(defaults.model)
    setReasoningEffort("default")
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)

    if (nextOpen) {
      setProvider(defaults.provider)
      setModel(defaults.model)
    } else {
      resetForm()
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const trimmedName = name.trim()

    if (!trimmedName) {
      return
    }

    onCreate({
      color,
      description: description.trim(),
      isGroup: false,
      model: overrideSettings ? model : defaults.model,
      name: trimmedName,
      notifyOnUpdatesEnabled: true,
      provider: overrideSettings ? provider : defaults.provider,
      ...(overrideSettings && reasoningEffort !== "default"
        ? { reasoningEffort }
        : {}),
    })
    setOpen(false)
    resetForm()
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size={compact ? "icon-sm" : "sm"}
            type="button"
            aria-label={compact ? "Create Wisp" : undefined}
            className={cn(!compact && "w-full justify-start")}
            title={compact ? "Create Wisp" : undefined}
          />
        }
      >
        <PlusIcon data-icon="inline-start" />
        {compact ? null : "Create Wisp"}
      </DialogTrigger>

      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Create a new Wisp</DialogTitle>
          <DialogDescription>
            Give your Wisp an identity. You can change its responsibilities
            later.
          </DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-5" onSubmit={handleSubmit}>
          <div className="flex items-center gap-4 rounded-xl bg-muted/50 p-4">
            <Wisp
              aria-hidden="true"
              className="size-16"
              color={color}
              name={previewName}
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">{previewName}</div>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                {previewDescription}
              </p>
            </div>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="agent-name">Name</FieldLabel>
              <Input
                id="agent-name"
                autoFocus
                maxLength={64}
                placeholder="e.g. Research assistant"
                required
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
              />
            </Field>

            <Field>
              <FieldLabel id="agent-color-label">Wisp color</FieldLabel>
              <ToggleGroup
                aria-labelledby="agent-color-label"
                value={[color]}
                onValueChange={(colors) => {
                  if (colors[0]) {
                    setColor(colors[0])
                  }
                }}
              >
                {AVATAR_COLORS.map((avatarColor) => (
                  <ToggleGroupItem
                    aria-label={avatarColor.label}
                    key={avatarColor.id}
                    value={avatarColor.value}
                  >
                    <span
                      aria-hidden="true"
                      className="size-full rounded-full border border-foreground/10"
                      style={{ backgroundColor: avatarColor.value }}
                    />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>
                This color identifies the Wisp throughout the app.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-description">Description</FieldLabel>
              <Textarea
                id="agent-description"
                maxLength={240}
                placeholder="What should this Wisp take care of?"
                value={description}
                onChange={(event) =>
                  setDescription(event.currentTarget.value)
                }
              />
            </Field>

            <Item variant="outline" className="items-start">
              <ItemMedia variant="icon">
                <CpuIcon aria-hidden="true" />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle>Model &amp; provider</ItemTitle>
                <ItemDescription className="truncate">
                  {displayedProvider.label} · {displayedModel.label} ·{" "}
                  {overrideSettings ? "Custom" : "App default"}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  aria-controls="agent-model-options"
                  aria-expanded={overrideSettings}
                  size="sm"
                  type="button"
                  variant="ghost"
                  onClick={() => setOverrideSettings((current) => !current)}
                >
                  {overrideSettings ? (
                    <RotateCcwIcon data-icon="inline-start" />
                  ) : (
                    <SlidersHorizontalIcon data-icon="inline-start" />
                  )}
                  {overrideSettings ? "Use defaults" : "Customize"}
                </Button>
              </ItemActions>

              {overrideSettings ? (
                <ItemFooter id="agent-model-options">
                  <FieldGroup className="grid w-full sm:grid-cols-3">
                    <Field>
                      <FieldLabel htmlFor="agent-provider">Provider</FieldLabel>
                      <Select
                        id="agent-provider"
                        items={PROVIDERS}
                        value={provider}
                        onValueChange={(value) => {
                          const nextProvider =
                            PROVIDERS.find(
                              (option) => option.value === value,
                            ) ?? PROVIDERS[0]

                          setProvider(nextProvider.value)
                          setModel(nextProvider.models[0].value)
                          setReasoningEffort("default")
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a provider" />
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          alignItemWithTrigger={false}
                          side="bottom"
                        >
                          <SelectGroup>
                            {PROVIDERS.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="agent-model">Model</FieldLabel>
                      <Select
                        id="agent-model"
                        items={selectedProvider.models}
                        value={model}
                        onValueChange={(value) => {
                          if (value) {
                            setModel(value)
                            setReasoningEffort("default")
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Select a model" />
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          alignItemWithTrigger={false}
                          side="bottom"
                        >
                          <SelectGroup>
                            {selectedProvider.models.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>

                    <Field>
                      <FieldLabel htmlFor="agent-reasoning-effort">
                        Reasoning
                      </FieldLabel>
                      <Select
                        id="agent-reasoning-effort"
                        items={reasoningEffortOptions}
                        value={reasoningEffort}
                        onValueChange={(value) => {
                          if (value) {
                            setReasoningEffort(value)
                          }
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Provider default" />
                        </SelectTrigger>
                        <SelectContent
                          align="start"
                          alignItemWithTrigger={false}
                          side="bottom"
                        >
                          <SelectGroup>
                            {reasoningEffortOptions.map((option) => (
                              <SelectItem key={option.value} value={option.value}>
                                {option.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </Field>
                  </FieldGroup>
                </ItemFooter>
              ) : null}
            </Item>
          </FieldGroup>

          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" type="button" />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!name.trim()}>
              Create Wisp
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { CreateAgentDialog }
export type { NewAgent }
