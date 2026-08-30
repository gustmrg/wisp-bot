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
      className="relative h-5 w-[34px] shrink-0 rounded-[10px] bg-[#c8c8c8] data-[on=true]:bg-[#262626] dark:bg-[#383838] dark:data-[on=true]:bg-[#e8e8e8]"
    >
      <span
        className={cn(
          "absolute top-[3px] left-[3px] size-3.5 rounded-full bg-[#606060] transition-[left,background-color] duration-[140ms] dark:bg-[#aaaaaa]",
          checked && "left-[17px] bg-white dark:bg-[#111111]",
        )}
      />
    </button>
  );
}

export { ToggleSwitch };
export type { ToggleSwitchProps };
