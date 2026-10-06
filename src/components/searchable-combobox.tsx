import { useRef, useState } from "react";
import { Combobox } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, SearchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { settingsSelect } from "@/lib/ui-classes";
import { cn } from "@/lib/utils";

interface SearchableOption {
  value: string;
  label: string;
  /** Secondary line shown under the label and matched by search. */
  description?: string;
}

interface SearchableComboboxProps {
  id: string;
  value: string;
  options: SearchableOption[];
  onChange: (value: string) => void;
  searchLabel: string;
  searchPlaceholder: string;
  emptyText: string;
  disabled?: boolean;
  className?: string;
}

function searchText(option: SearchableOption): string {
  return `${option.label} ${option.description ?? ""} ${option.value}`.replaceAll("_", " ");
}

/** A select-like trigger whose popup can be filtered, for long option lists. */
function SearchableCombobox({
  id,
  value,
  options,
  onChange,
  searchLabel,
  searchPlaceholder,
  emptyText,
  disabled = false,
  className,
}: SearchableComboboxProps) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { contains } = Combobox.useFilter({ sensitivity: "base" });
  const selectedOption = options.find((option) => option.value === value) ?? null;

  return (
    <Combobox.Root
      items={options}
      value={selectedOption}
      isItemEqualToValue={(item, selected) => item.value === selected.value}
      onValueChange={(option) => {
        if (option) onChange(option.value);
      }}
      inputValue={query}
      onInputValueChange={setQuery}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      filter={(option, search) => contains(searchText(option), search.trim().replaceAll("_", " "))}
      disabled={disabled}
      autoHighlight
    >
      <Combobox.Trigger
        id={id}
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn(settingsSelect, "justify-between gap-2 font-normal", className)}
          />
        }
      >
        <span className="min-w-0 truncate">
          <Combobox.Value />
        </span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-dim" />
      </Combobox.Trigger>
      <Combobox.Portal>
        <Combobox.Positioner side="bottom" align="end" sideOffset={4} collisionPadding={12} className="z-50">
          <Combobox.Popup
            initialFocus={inputRef}
            className="flex max-h-(--available-height) w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10"
          >
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <SearchIcon className="size-4 shrink-0 text-dim" aria-hidden="true" />
              <Combobox.Input
                ref={inputRef}
                aria-label={searchLabel}
                placeholder={searchPlaceholder}
                render={
                  <Input className="h-8 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent" />
                }
              />
            </div>
            <Combobox.Empty className="px-3 text-base text-dim not-empty:py-5">{emptyText}</Combobox.Empty>
            <Combobox.List className="max-h-64 min-h-0 overflow-y-auto overscroll-contain p-1 empty:p-0">
              {(option: SearchableOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="flex cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-base outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                >
                  <span className="min-w-0 flex-1 break-words">
                    {option.label}
                    {option.description ? (
                      <span className="block break-all text-sm text-dim">{option.description}</span>
                    ) : null}
                  </span>
                  <span className="flex size-4 shrink-0 items-center justify-center">
                    <Combobox.ItemIndicator>
                      <CheckIcon aria-hidden="true" className="size-4" />
                    </Combobox.ItemIndicator>
                  </span>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}

export { SearchableCombobox };
export type { SearchableOption };
