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
import { useI18n } from "../lib/i18n";
import { getActiveRunId } from "../lib/session";
import { LanguageToggle } from "./LanguageToggle";
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
  const { t } = useI18n();
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
    {
      label: t("nav.upload"),
      icon: UploadIcon,
      to: "/",
      active: pathname === "/",
    },
    {
      // Progress is a destination only while a run is actively processing.
      label: t("nav.progress"),
      icon: Clock,
      to: activeRunId ? `/runs/${activeRunId}` : null,
      active: onRun && !onReport,
    },
    {
      // Report is reachable only via a progress-completion or history redirect;
      // the rail merely indicates when one is open, never offers a shortcut.
      label: t("nav.report"),
      icon: BarChart3,
      to: null,
      active: onReport,
    },
    {
      label: t("nav.history"),
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
          aria-label={t("sidebar.show")}
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
        <div className="flex items-center gap-1">
          <a
            href="https://github.com/estebandev213/RAGProbe"
            target="_blank"
            rel="noreferrer"
            aria-label={t("nav.github")}
            title={t("nav.github")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12 .5C5.73.5.75 5.48.75 11.75c0 5.02 3.26 9.27 7.77 10.77.57.1.78-.25.78-.55 0-.27-.01-1.16-.02-2.11-3.16.69-3.83-1.34-3.83-1.34-.52-1.31-1.26-1.66-1.26-1.66-1.03-.7.08-.69.08-.69 1.14.08 1.74 1.17 1.74 1.17 1.01 1.73 2.65 1.23 3.3.94.1-.73.4-1.23.72-1.51-2.52-.29-5.17-1.26-5.17-5.6 0-1.24.44-2.25 1.17-3.04-.12-.29-.51-1.45.11-3.02 0 0 .96-.31 3.14 1.16a10.9 10.9 0 0 1 5.72 0c2.18-1.47 3.14-1.16 3.14-1.16.62 1.57.23 2.73.11 3.02.73.79 1.17 1.8 1.17 3.04 0 4.35-2.65 5.31-5.18 5.59.41.35.77 1.05.77 2.11 0 1.53-.01 2.75-.01 3.13 0 .3.2.66.79.55A11.26 11.26 0 0 0 23.25 11.75C23.25 5.48 18.27.5 12 .5Z" />
            </svg>
          </a>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label={t("sidebar.hide")}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <PanelLeftClose size={16} />
          </button>
        </div>
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
        <div className="flex items-center gap-1">
          <LanguageToggle />
          <ThemeToggle />
        </div>
        <span className="font-mono text-xs text-slate-400">
          v{__APP_VERSION__}
        </span>
      </div>
    </aside>
  );
}
