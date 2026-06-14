/**
 * A small, accessible toggle switch.
 *
 * The knob is a flex child of an `items-center` track, so it stays vertically
 * centered without pixel-fiddling, and the on/off offsets are symmetric.
 */
interface SwitchProps {
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  size?: "sm" | "md";
}

const SIZES = {
  sm: {
    track: "h-5 w-9",
    knob: "h-4 w-4",
    on: "translate-x-[18px]",
    off: "translate-x-0.5",
  },
  md: {
    track: "h-6 w-11",
    knob: "h-5 w-5",
    on: "translate-x-[22px]",
    off: "translate-x-0.5",
  },
} as const;

export function Switch({
  checked,
  onChange,
  disabled = false,
  label,
  size = "md",
}: SwitchProps) {
  const s = SIZES[size];
  const interactive = Boolean(onChange) && !disabled;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={!interactive}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex shrink-0 items-center rounded-full transition-colors ${s.track} ${
        checked ? "bg-accent" : "bg-slate-300 dark:bg-slate-600"
      } ${interactive ? "cursor-pointer" : "cursor-not-allowed opacity-70"}`}
    >
      <span
        className={`inline-block transform rounded-full bg-white shadow-sm transition-transform ${s.knob} ${
          checked ? s.on : s.off
        }`}
      />
    </button>
  );
}
