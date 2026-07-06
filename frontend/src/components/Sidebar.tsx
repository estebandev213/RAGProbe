import {
  BarChart3,
  Clock,
  FileText,
  PanelLeftClose,
  PanelLeftOpen,
  Upload as UploadIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getActiveRunId } from "../lib/session";
import { ThemeToggle } from "./ThemeToggle";

const STORAGE_KEY = "ragprobe:sidebar-open";

function readStoredOpen(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

type IconType = typeof UploadIcon;

interface NavEntry {
  label: string;
  icon: IconType;
  to: string | null;
  active: boolean;
}

/** Persistent left rail: brand, navigation, live-status, and the theme toggle. */
export function Sidebar() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Re-read on every navigation (pathname change re-renders this rail); each
  // session write in the app is paired with a navigation, so the links stay fresh.
  const activeRunId = getActiveRunId();
  const [open, setOpen] = useState(readStoredOpen);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(open));
    } catch {
      // ignore unavailable storage
    }
  }, [open]);

  const onRun = pathname.startsWith("/runs/");
  const onReport = pathname.endsWith("/report");

  const entries: NavEntry[] = [
    { label: "Upload", icon: UploadIcon, to: "/", active: pathname === "/" },
    {
      // Progress is a destination only while a run is actively processing.
      label: "Progress",
      icon: Clock,
      to: activeRunId ? `/runs/${activeRunId}` : null,
      active: onRun && !onReport,
    },
    {
      // Report is reachable only via a progress-completion or history redirect;
      // the rail merely indicates when one is open, never offers a shortcut.
      label: "Report",
      icon: BarChart3,
      to: null,
      active: onReport,
    },
    {
      label: "History",
      icon: FileText,
      to: "/history",
      active: pathname === "/history",
    },
  ];

  if (!open) {
    return (
      <div className="sticky top-0 hidden h-screen shrink-0 items-start py-6 pl-5 md:flex">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Show sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 shadow-sm transition hover:bg-slate-100 hover:text-slate-800 dark:border-slate-700/50 dark:bg-slate-950 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <PanelLeftOpen size={18} />
        </button>
      </div>
    );
  }

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-slate-200 bg-white px-5 py-6 md:flex dark:border-slate-700/50 dark:bg-slate-950">
      <div className="flex items-center justify-between px-2">
        <div className="font-display text-2xl tracking-tight text-slate-900 dark:text-white">
          <span className="font-bold">RAG</span>
          <span className="font-medium text-slate-500 dark:text-slate-400">
            Probe
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label="Hide sidebar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
        >
          <PanelLeftClose size={16} />
        </button>
      </div>

      <nav className="mt-8 flex flex-col gap-1">
        {entries.map((entry) => {
          const Icon = entry.icon;
          const locked = entry.to === null;
          return (
            <button
              key={entry.label}
              type="button"
              onClick={() => entry.to && navigate(entry.to)}
              className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                entry.active
                  ? "bg-accent-soft text-accent-fg dark:bg-accent/15 dark:text-accent"
                  : locked
                    ? "cursor-default text-slate-400/60 dark:text-slate-600"
                    : "text-slate-500 hover:bg-slate-100/70 hover:text-slate-800 dark:text-slate-400 dark:hover:bg-slate-800/60"
              }`}
            >
              <Icon size={18} />
              {entry.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto flex items-center justify-between px-1">
        <ThemeToggle />
        <span className="font-mono text-xs text-slate-400">
          v{__APP_VERSION__}
        </span>
      </div>
    </aside>
  );
}
