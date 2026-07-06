import {
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  FileText,
  FlaskConical,
  HelpCircle,
  Layers,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { ApiRequestError, deleteRun, listRuns, renameRun } from "../api/client";
import { formatAge, formatDateTime } from "../lib/format";
import type { RunSummary } from "../types";

const MENU_WIDTH = 168;
const MENU_HEIGHT = 84;

/** "1 doc" / "3 docs" — pluralize a count against a singular noun. */
function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Page heading with a subtitle and a shortcut back to a fresh evaluation. */
function Header({ subtitle }: { subtitle: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div className="group flex items-center gap-5">
        <CalendarClock
          size={40}
          className="shrink-0 text-accent transition-transform duration-500 ease-out group-hover:-rotate-12 group-hover:scale-110 motion-reduce:transform-none dark:text-white"
        />
        <div>
          <h1 className="font-display text-4xl font-bold tracking-tight text-slate-900 dark:text-white">
            History
          </h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
        </div>
      </div>
      <Link
        to="/"
        className="group inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-accent/20 transition duration-200 hover:-translate-y-0.5 hover:bg-accent-fg hover:shadow-lg hover:shadow-accent/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900"
      >
        <Plus
          size={16}
          className="transition-transform duration-200 group-hover:rotate-90"
        />
        New evaluation
      </Link>
    </div>
  );
}

/** A single metadata stat: icon + value, styled as a subtle inline pill. */
function MetaItem({
  Icon,
  children,
  title,
}: {
  Icon: typeof CalendarClock;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1.5 rounded-md bg-slate-100/70 px-2 py-0.5 font-mono text-[11px] tabular-nums text-slate-500 dark:bg-slate-800/60 dark:text-slate-400"
    >
      <Icon size={12} className="shrink-0 text-slate-400 dark:text-slate-500" />
      {children}
    </span>
  );
}

/** A single source-document chip. */
function DocChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border border-slate-200/70 bg-slate-50 px-1.5 py-0.5 font-mono text-[11px] text-slate-500 transition group-hover:border-slate-300 dark:border-slate-700/60 dark:bg-slate-800/60 dark:text-slate-400 dark:group-hover:border-slate-600">
      {children}
    </span>
  );
}

interface MenuState {
  run: RunSummary;
  x: number;
  y: number;
}

/** Floating right-click menu: rename or delete the run under the cursor. */
function ContextMenu({
  state,
  onRename,
  onDelete,
  onClose,
}: {
  state: MenuState;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handlePointer = () => onClose();
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", handlePointer);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handlePointer);
      window.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      role="menu"
      style={{ top: state.y, left: state.x }}
      className="fixed z-50 w-44 animate-pop-in overflow-hidden rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-xl dark:border-slate-700 dark:bg-slate-800"
      onMouseDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        onClick={onRename}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-slate-600 transition hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-700/60"
      >
        <Pencil size={14} /> Rename
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={onDelete}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-rose-600 transition hover:bg-rose-50 dark:text-rose-400 dark:hover:bg-rose-500/10"
      >
        <Trash2 size={14} /> Delete
      </button>
    </div>
  );
}

/** One run as a clickable log entry. History lists only completed runs, so
 * every row opens its report — unless it's mid-rename or mid-delete, in
 * which case navigation is suspended. */
function RunRow({
  run,
  editing,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onContextMenu,
  deleting,
}: {
  run: RunSummary;
  editing: boolean;
  renameValue: string;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onContextMenu: (event: ReactMouseEvent, run: RunSummary) => void;
  deleting: boolean;
}) {
  const created = new Date(run.created_at);
  const validDate = !Number.isNaN(created.getTime());
  const target = `/runs/${run.id}/report`;
  const shownDocs = run.document_names.slice(0, 3);
  const extraDocs = run.document_names.length - shownDocs.length;

  const handleRenameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onRenameSubmit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onRenameCancel();
    }
  };

  const body = (
    <>
      {/* soft glow, fading in from the left edge, breathing gently */}
      <span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1/2 origin-left animate-glow-pulse bg-gradient-to-r from-emerald-400 to-transparent transition-[width] duration-300 group-hover:w-2/3 motion-reduce:animate-none motion-reduce:opacity-[0.07] dark:from-emerald-500"
      />

      <div className="relative mt-0.5 shrink-0">
        <div className="flex h-11 w-11 items-center justify-center text-emerald-500 transition-transform duration-200 group-hover:scale-105 dark:text-emerald-400">
          <CheckCircle2
            size={28}
            className="transition-transform duration-200 group-hover:-rotate-6 motion-reduce:transform-none"
          />
        </div>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          {editing ? (
            <input
              autoFocus
              value={renameValue}
              onChange={(event) => onRenameChange(event.target.value)}
              onKeyDown={handleRenameKeyDown}
              onBlur={onRenameSubmit}
              onClick={(event) => event.preventDefault()}
              className="w-full min-w-0 rounded-md border border-accent/40 bg-white px-2 py-0.5 font-display text-lg font-semibold tracking-tight text-slate-900 outline-none ring-2 ring-accent/20 dark:border-accent/50 dark:bg-slate-800 dark:text-white sm:text-xl"
            />
          ) : (
            <p className="truncate font-display text-lg font-semibold tracking-tight text-slate-900 dark:text-white sm:text-xl">
              {run.title}
            </p>
          )}
          {!editing && (
            <ChevronRight
              size={18}
              className="mt-0.5 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-accent dark:text-slate-600"
            />
          )}
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <MetaItem Icon={HelpCircle}>
            {plural(run.n_questions, "question")}
          </MetaItem>
          <MetaItem Icon={Layers}>{plural(run.n_configs, "config")}</MetaItem>
          {validDate && (
            <MetaItem Icon={CalendarClock} title={formatDateTime(created)}>
              {formatAge(created)}
            </MetaItem>
          )}
          {run.demo_mode && (
            <span
              title="Demo mode"
              className="inline-flex items-center rounded-md bg-accent-soft px-1.5 py-0.5 text-accent"
            >
              <FlaskConical size={12} />
            </span>
          )}
        </div>

        {run.document_names.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {shownDocs.map((name, i) => (
              <DocChip key={`${i}-${name}`}>
                <FileText size={11} className="shrink-0 text-slate-400" />
                <span className="truncate">{name}</span>
              </DocChip>
            ))}
            {extraDocs > 0 && <DocChip>+{extraDocs} more</DocChip>}
          </div>
        )}
      </div>
    </>
  );

  if (editing) {
    return (
      <li>
        <div className="card relative flex items-start gap-4 overflow-hidden py-4 pl-6 pr-5">
          {body}
        </div>
      </li>
    );
  }

  return (
    <li>
      <Link
        to={target}
        onContextMenu={(event) => onContextMenu(event, run)}
        className={`card group relative flex items-start gap-4 overflow-hidden py-4 pl-6 pr-5 transition duration-200 hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-xl hover:shadow-accent/5 ${
          deleting ? "pointer-events-none opacity-50" : ""
        }`}
      >
        {body}
      </Link>
    </li>
  );
}

/** Empty state: no runs recorded yet. */
function EmptyState() {
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
          No runs yet
        </p>
        <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
          Every evaluation you run shows up here. Start one from the upload
          screen and it will be one click away afterwards.
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

/** History screen: a run log linking each evaluation to its report (§8). */
export function HistoryPage() {
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listRuns()
      .then((rows) => {
        if (!active) return;
        setRuns(rows);
        setError(null);
      })
      .catch((cause) => {
        if (!active) return;
        setError(
          cause instanceof ApiRequestError
            ? cause.message
            : "Could not load run history.",
        );
      })
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, []);

  const openMenu = (event: ReactMouseEvent, run: RunSummary) => {
    event.preventDefault();
    setMenu({
      run,
      x: Math.min(event.clientX, window.innerWidth - MENU_WIDTH - 8),
      y: Math.min(event.clientY, window.innerHeight - MENU_HEIGHT - 8),
    });
  };

  const startRename = (run: RunSummary) => {
    setMenu(null);
    setEditingId(run.id);
    setRenameValue(run.title);
  };

  const commitRename = (run: RunSummary) => {
    // Guards a trailing blur firing after Enter/Escape already closed editing.
    if (editingId !== run.id) return;
    setEditingId(null);
    const value = renameValue.trim();
    if (!value || value === run.title) return;
    setRuns(
      (prev) =>
        prev?.map((r) => (r.id === run.id ? { ...r, title: value } : r)) ??
        prev,
    );
    renameRun(run.id, value).catch(() => {
      setRuns(
        (prev) =>
          prev?.map((r) =>
            r.id === run.id ? { ...r, title: run.title } : r,
          ) ?? prev,
      );
      setError("Could not rename the run.");
    });
  };

  const handleDelete = (run: RunSummary) => {
    setMenu(null);
    if (!window.confirm(`Delete "${run.title}"? This can't be undone.`)) return;
    setDeletingId(run.id);
    deleteRun(run.id)
      .then(() =>
        setRuns((prev) => prev?.filter((r) => r.id !== run.id) ?? prev),
      )
      .catch(() => setError("Could not delete the run."))
      .finally(() => setDeletingId(null));
  };

  if (loading) {
    return (
      <div className="animate-fade-in">
        <Header subtitle="Past evaluations, newest first." />
        <div className="card mt-8 flex items-center justify-center p-16 text-sm text-slate-400">
          Loading run history…
        </div>
      </div>
    );
  }

  if (error || !runs) {
    return (
      <div className="animate-fade-in">
        <Header subtitle="Past evaluations, newest first." />
        <div className="card mt-8 flex flex-col items-center gap-2 p-12 text-center">
          <p className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            Couldn't load run history
          </p>
          <p className="max-w-md text-sm text-slate-500 dark:text-slate-400">
            {error ?? "The run history is not available right now."}
          </p>
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return <EmptyState />;
  }

  const noun = runs.length === 1 ? "evaluation" : "evaluations";

  return (
    <div className="animate-fade-in">
      <Header subtitle={`${runs.length} ${noun}`} />
      <ul className="mt-8 space-y-3">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            editing={editingId === run.id}
            renameValue={renameValue}
            onRenameChange={setRenameValue}
            onRenameSubmit={() => commitRename(run)}
            onRenameCancel={() => setEditingId(null)}
            onContextMenu={openMenu}
            deleting={deletingId === run.id}
          />
        ))}
      </ul>
      {menu && (
        <ContextMenu
          state={menu}
          onRename={() => startRename(menu.run)}
          onDelete={() => handleDelete(menu.run)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
