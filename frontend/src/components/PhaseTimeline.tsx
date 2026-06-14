import { Check } from "lucide-react";
import { Fragment } from "react";

export type PhaseState = "completed" | "active" | "pending";

export interface PhaseView {
  label: string;
  state: PhaseState;
  caption: string;
  time?: string;
}

function lineClass(done: boolean): string {
  return done
    ? "border-accent"
    : "border-slate-300 border-dashed dark:border-slate-600";
}

/** Horizontal five-step stepper for the run lifecycle (§6.7). */
export function PhaseTimeline({ phases }: { phases: PhaseView[] }) {
  const last = phases.length - 1;
  return (
    <div className="flex">
      {phases.map((phase, index) => {
        const number = index + 1;
        const leftDone = index > 0 && phases[index - 1].state === "completed";
        const rightDone = phase.state === "completed";
        return (
          <Fragment key={phase.label}>
            <div className="flex flex-1 flex-col items-center">
              <div className="flex w-full items-center">
                <div
                  className={`flex-1 border-t-2 ${index === 0 ? "border-transparent" : lineClass(leftDone)}`}
                />
                <div
                  className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
                    phase.state === "completed"
                      ? "bg-accent text-white"
                      : phase.state === "active"
                        ? "bg-accent text-white ring-4 ring-accent-soft dark:ring-accent/20"
                        : "bg-slate-200 text-slate-400 dark:bg-slate-700 dark:text-slate-500"
                  }`}
                >
                  {phase.state === "completed" ? <Check size={18} /> : number}
                </div>
                <div
                  className={`flex-1 border-t-2 ${index === last ? "border-transparent" : lineClass(rightDone)}`}
                />
              </div>
              <p
                className={`mt-3 text-sm font-semibold ${
                  phase.state === "active"
                    ? "text-accent"
                    : phase.state === "completed"
                      ? "text-slate-700 dark:text-slate-200"
                      : "text-slate-400"
                }`}
              >
                {phase.label}
              </p>
              <p className="mt-0.5 text-xs text-slate-400">{phase.caption}</p>
              {phase.time && (
                <p className="font-mono text-xs text-slate-400">{phase.time}</p>
              )}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}
