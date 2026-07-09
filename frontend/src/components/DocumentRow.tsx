import { Trash2 } from "lucide-react";
import { formatBytes, formatNumber } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { DocumentSummary } from "../types";

interface DocumentRowProps {
  doc: DocumentSummary;
  sizeBytes: number;
  onRemove: (id: string) => void;
}

interface Badge {
  label: string;
  className: string;
}

function badgeFor(name: string): Badge {
  const ext = name.split(".").pop()?.toLowerCase();
  if (ext === "pdf")
    return { label: "PDF", className: "bg-red-50 text-red-600" };
  if (ext === "md")
    return { label: "MD", className: "bg-emerald-50 text-emerald-600" };
  return { label: "TXT", className: "bg-slate-100 text-slate-500" };
}

/** One uploaded document in the upload list, with type badge, meta, and delete. */
export function DocumentRow({ doc, sizeBytes, onRemove }: DocumentRowProps) {
  const { t } = useI18n();
  const badge = badgeFor(doc.name);
  return (
    <div className="flex items-center gap-4 rounded-xl border border-slate-200/80 bg-white/70 px-4 py-3 dark:border-slate-700/60 dark:bg-slate-900/40">
      <div
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg font-mono text-xs font-semibold ${badge.className}`}
      >
        {badge.label}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-slate-800 dark:text-slate-100">
          {doc.name}
        </p>
        <p className="mt-0.5 text-sm text-slate-400">
          {formatBytes(sizeBytes)} · {formatNumber(doc.char_count)}{" "}
          {t("docs.characters")} · {t("docs.uploadedNow")}
        </p>
      </div>
      <button
        type="button"
        aria-label={`${t("docs.remove")} ${doc.name}`}
        onClick={() => onRemove(doc.id)}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-red-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
      >
        <Trash2 size={18} />
      </button>
    </div>
  );
}
