import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
  checked: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}

function ToggleSwitch({ checked, label, onChange, disabled = false }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-on={checked}
      disabled={disabled}
      onClick={onChange}
      className="relative h-5 w-[34px] shrink-0 rounded-[10px] bg-input disabled:cursor-not-allowed disabled:opacity-50 data-[on=true]:bg-primary"
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] size-3.5 rounded-full bg-dim transition-[left,background-color] duration-[140ms]",
          checked && "left-[17px] bg-primary-foreground",
        )}
      />
    </button>
  );
}

export { ToggleSwitch };
export type { ToggleSwitchProps };
