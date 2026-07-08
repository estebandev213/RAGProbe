import type { ReactNode } from "react";

/** Small labelled metric card used in the progress header strip. */
export function StatCard({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-5">
      <div className="flex h-14 w-14 shrink-0 items-center justify-center text-accent">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="font-medium text-slate-800 dark:text-slate-100">
          {label}
        </p>
        <p className="truncate text-sm text-slate-400">{value}</p>
      </div>
    </div>
  );
}
