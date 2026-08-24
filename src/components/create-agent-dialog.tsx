import { useState } from "react"
import type { FormEvent } from "react"
import { PlusIcon } from "lucide-react"

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
import { WISP_COLORS, Wisp } from "@/components/wisp"
import { cn } from "@/lib/utils"

interface NewAgent {
  color: string
  description: string
  model: string
  name: string
  provider: string
}

interface CreateAgentDialogProps {
  compact?: boolean
  onCreate: (agent: NewAgent) => void
}

const WISP_COLOR_NAMES = [
  "Emerald",
  "Amber",
  "Violet",
  "Blue",
  "Coral",
  "Teal",
] as const
const DEFAULT_COLOR = WISP_COLORS[0]

const PROVIDERS = [
  {
    label: "OpenAI",
    value: "openai",
    models: [
      { label: "GPT-5.6 Sol", value: "gpt-5.6-sol" },
      { label: "GPT-5.6 Terra", value: "gpt-5.6-terra" },
      { label: "GPT-5.6 Luna", value: "gpt-5.6-luna" },
    ],
  },
  {
    label: "Anthropic",
    value: "anthropic",
    models: [
      { label: "Claude Opus 5", value: "claude-opus-5" },
      { label: "Claude Sonnet 5", value: "claude-sonnet-5" },
      { label: "Claude Haiku 4.5", value: "claude-haiku-4-5" },
    ],
  },
  {
    label: "Google",
    value: "google",
    models: [
      { label: "Gemini 3.7 Flash", value: "gemini-3.7-flash" },
      { label: "Gemini 3.6 Flash", value: "gemini-3.6-flash" },
      { label: "Gemini 3.5 Flash-Lite", value: "gemini-3.5-flash-lite" },
    ],
  },
] as const

const DEFAULT_PROVIDER = PROVIDERS[0]
const DEFAULT_MODEL = DEFAULT_PROVIDER.models[1]

function CreateAgentDialog({
  compact = false,
  onCreate,
}: CreateAgentDialogProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [color, setColor] = useState<string>(DEFAULT_COLOR)
  const [provider, setProvider] = useState<string>(DEFAULT_PROVIDER.value)
  const [model, setModel] = useState<string>(DEFAULT_MODEL.value)
  const selectedProvider =
    PROVIDERS.find((option) => option.value === provider) ?? DEFAULT_PROVIDER
  const previewName = name.trim() || "New agent"
  const previewDescription =
    description.trim() || "Describe what this agent is responsible for."

  function resetForm() {
    setName("")
    setDescription("")
    setColor(DEFAULT_COLOR)
    setProvider(DEFAULT_PROVIDER.value)
    setModel(DEFAULT_MODEL.value)
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)

    if (!nextOpen) {
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
      model,
      name: trimmedName,
      provider,
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
            aria-label={compact ? "Create agent" : undefined}
            className={cn(!compact && "w-full justify-start")}
            title={compact ? "Create agent" : undefined}
          />
        }
      >
        <PlusIcon data-icon="inline-start" />
        {compact ? null : "Create agent"}
      </DialogTrigger>

      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create a new agent</DialogTitle>
          <DialogDescription>
            Give your agent an identity. You can change its responsibilities
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
                {WISP_COLORS.map((wispColor, index) => (
                  <ToggleGroupItem
                    aria-label={WISP_COLOR_NAMES[index]}
                    key={wispColor}
                    value={wispColor}
                  >
                    <span
                      aria-hidden="true"
                      className="size-full rounded-full border border-foreground/10"
                      style={{ backgroundColor: wispColor }}
                    />
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <FieldDescription>
                This color identifies the agent throughout the app.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-description">Description</FieldLabel>
              <Textarea
                id="agent-description"
                maxLength={240}
                placeholder="What should this agent take care of?"
                value={description}
                onChange={(event) =>
                  setDescription(event.currentTarget.value)
                }
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="agent-provider">Provider</FieldLabel>
              <Select
                id="agent-provider"
                items={PROVIDERS}
                required
                value={provider}
                onValueChange={(value) => {
                  const nextProvider =
                    PROVIDERS.find(
                      (option) => option.value === value,
                    ) ?? DEFAULT_PROVIDER

                  setProvider(nextProvider.value)
                  setModel(nextProvider.models[0].value)
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a provider" />
                </SelectTrigger>
                <SelectContent>
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
                required
                value={model}
                onValueChange={(value) => {
                  if (value) {
                    setModel(value)
                  }
                }}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a model" />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {selectedProvider.models.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <FieldDescription>
                Models available for {selectedProvider.label}.
              </FieldDescription>
            </Field>
          </FieldGroup>

          <DialogFooter>
            <DialogClose
              render={<Button variant="outline" type="button" />}
            >
              Cancel
            </DialogClose>
            <Button type="submit" disabled={!name.trim()}>
              Create agent
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export { CreateAgentDialog }
export type { NewAgent }
