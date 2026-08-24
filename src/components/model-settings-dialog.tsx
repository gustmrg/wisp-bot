import { useState } from "react"
import { Settings2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PROVIDERS, type ModelDefaults } from "@/components/model-options"

interface ModelSettingsDialogProps {
  defaults: ModelDefaults
  onSave: (defaults: ModelDefaults) => void
}

function ModelSettingsDialog({ defaults, onSave }: ModelSettingsDialogProps) {
  const [open, setOpen] = useState(false)
  const [provider, setProvider] = useState(defaults.provider)
  const [model, setModel] = useState(defaults.model)
  const selectedProvider = PROVIDERS.find((item) => item.value === provider) ?? PROVIDERS[0]

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen)
    if (nextOpen) {
      setProvider(defaults.provider)
      setModel(defaults.model)
    }
  }

  function handleSave() {
    onSave({ provider, model })
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="ghost" size="sm" type="button" className="ml-auto" aria-label="Open settings" />}
      >
        <Settings2Icon data-icon="inline-start" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Global model settings</DialogTitle>
          <DialogDescription>
            These defaults apply to every new Wisp unless you choose an override.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="default-provider">Default provider</FieldLabel>
            <Select
              id="default-provider"
              items={PROVIDERS}
              value={provider}
              onValueChange={(value) => {
                const nextProvider = PROVIDERS.find((item) => item.value === value) ?? PROVIDERS[0]
                setProvider(nextProvider.value)
                setModel(nextProvider.models[0].value)
              }}
            >
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{PROVIDERS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="default-model">Default model</FieldLabel>
            <Select id="default-model" items={selectedProvider.models} value={model} onValueChange={(value) => value && setModel(value)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{selectedProvider.models.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
            <FieldDescription>New Wisps use this provider and model by default.</FieldDescription>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" onClick={handleSave}>Save settings</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ModelSettingsDialog }
