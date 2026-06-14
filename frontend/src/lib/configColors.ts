/**
 * One shared color per config, assigned by leaderboard rank.
 *
 * The leaderboard, the recommendation banner, and the breakdown chart all key
 * off the same ordering, so a config wears one consistent color across the whole
 * report. `hex` feeds recharts (which needs a literal fill); the Tailwind classes
 * style the table bars, badges, and legend dots.
 */

export interface ConfigColor {
  hex: string;
  bar: string;
  text: string;
  soft: string;
  dot: string;
}

const CONFIG_COLORS: ConfigColor[] = [
  {
    hex: "#2563eb",
    bar: "bg-blue-500",
    text: "text-blue-600",
    soft: "bg-blue-100",
    dot: "bg-blue-500",
  },
  {
    hex: "#7c3aed",
    bar: "bg-violet-500",
    text: "text-violet-600",
    soft: "bg-violet-100",
    dot: "bg-violet-500",
  },
  {
    hex: "#ea580c",
    bar: "bg-orange-500",
    text: "text-orange-600",
    soft: "bg-orange-100",
    dot: "bg-orange-500",
  },
  {
    hex: "#059669",
    bar: "bg-emerald-500",
    text: "text-emerald-600",
    soft: "bg-emerald-100",
    dot: "bg-emerald-500",
  },
  {
    hex: "#e11d48",
    bar: "bg-rose-500",
    text: "text-rose-600",
    soft: "bg-rose-100",
    dot: "bg-rose-500",
  },
  {
    hex: "#0891b2",
    bar: "bg-cyan-500",
    text: "text-cyan-600",
    soft: "bg-cyan-100",
    dot: "bg-cyan-500",
  },
];

/** The color slot for a config at the given leaderboard position. */
export function configColor(index: number): ConfigColor {
  return CONFIG_COLORS[index % CONFIG_COLORS.length];
}
