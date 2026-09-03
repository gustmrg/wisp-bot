import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
  checked: boolean;
  label: string;
  onChange: () => void;
}

function ToggleSwitch({ checked, label, onChange }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-on={checked}
      onClick={onChange}
      className="relative h-5 w-[34px] shrink-0 rounded-[10px] bg-input data-[on=true]:bg-primary"
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
