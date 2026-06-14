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
    <div className="card flex items-center gap-3 px-4 py-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent">
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
