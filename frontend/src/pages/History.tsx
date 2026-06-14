import { FileText } from "lucide-react";
import { Link } from "react-router-dom";

/** Placeholder route so the sidebar link resolves; run history is a v2 idea. */
export function HistoryPage() {
  return (
    <div className="animate-fade-in">
      <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
        History
      </h1>
      <div className="card mt-8 flex flex-col items-center gap-3 p-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          <FileText size={26} />
        </div>
        <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          No saved runs yet
        </p>
        <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
          Persistent run history is on the roadmap. For now, start a fresh
          evaluation from the upload screen.
        </p>
        <Link
          to="/"
          className="mt-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition hover:bg-accent-fg"
        >
          New evaluation
        </Link>
      </div>
    </div>
  );
}
