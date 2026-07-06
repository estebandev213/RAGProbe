import { FilePlus2, FolderOpen, Plus, Sparkles } from "lucide-react";
import { useRef, useState } from "react";

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  /** Slim inline variant shown once documents are already listed. */
  compact?: boolean;
  /** Shown as a second action beside "Browse files", e.g. loading bundled samples. */
  onUseSamples?: () => void;
}

/** Drag-and-drop target plus a Browse button for picking pdf/md/txt files. */
export function Dropzone({
  onFiles,
  disabled = false,
  compact = false,
  onUseSamples,
}: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function emit(list: FileList | null) {
    if (list && list.length > 0) onFiles(Array.from(list));
  }

  const dragHandlers = {
    onDragOver: (event: React.DragEvent) => {
      event.preventDefault();
      if (!disabled) setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      setDragging(false);
      if (!disabled) emit(event.dataTransfer.files);
    },
  };

  const fileInput = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept=".pdf,.md,.txt,text/markdown,text/plain,application/pdf"
      className="hidden"
      onChange={(event) => {
        emit(event.target.files);
        event.target.value = "";
      }}
    />
  );

  if (compact) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        {...dragHandlers}
        className={`group flex w-full items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-3 text-sm font-medium transition ${
          dragging
            ? "border-accent bg-accent-soft/60"
            : "border-slate-300 text-slate-500 hover:border-accent hover:bg-accent-soft/30 hover:text-accent dark:border-slate-600 dark:text-slate-400"
        } ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      >
        <Plus
          size={16}
          className="text-accent transition group-hover:rotate-90"
        />
        Add more files
        <span className="text-xs font-normal text-slate-400">
          PDF · MD · TXT
        </span>
        {fileInput}
      </button>
    );
  }

  return (
    <div
      {...dragHandlers}
      className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition ${
        dragging
          ? "border-accent bg-accent-soft/60"
          : "border-slate-300 dark:border-slate-600"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <FilePlus2 className="text-accent" size={34} strokeWidth={1.6} />
      <p className="mt-4 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
        Drag &amp; drop files here
      </p>
      <p className="mt-1 text-sm text-slate-400">
        PDF, Markdown (.md) or Text (.txt)
      </p>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="group flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-accent hover:text-accent hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
        >
          <FolderOpen
            size={16}
            className="transition duration-300 group-hover:-translate-y-0.5 group-hover:text-accent motion-reduce:transform-none"
          />
          Browse files
        </button>

        {onUseSamples && (
          <button
            type="button"
            disabled={disabled}
            onClick={onUseSamples}
            className="group flex items-center gap-2 rounded-lg border border-accent/30 bg-accent-soft px-4 py-2 text-sm font-medium text-accent shadow-sm transition hover:-translate-y-0.5 hover:border-accent hover:bg-accent-soft/70 hover:shadow-md disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-y-0 dark:border-accent/40 dark:bg-accent/15"
          >
            <Sparkles
              size={16}
              className="transition duration-300 group-hover:rotate-12 group-hover:scale-110 motion-reduce:transform-none"
            />
            Use sample documents
          </button>
        )}
      </div>

      {fileInput}
    </div>
  );
}
