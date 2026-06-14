import { FilePlus2 } from "lucide-react";
import { useRef, useState } from "react";

interface DropzoneProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

/** Drag-and-drop target plus a Browse button for picking pdf/md/txt files. */
export function Dropzone({ onFiles, disabled = false }: DropzoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function emit(list: FileList | null) {
    if (list && list.length > 0) onFiles(Array.from(list));
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        if (!disabled) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (!disabled) emit(event.dataTransfer.files);
      }}
      className={`flex flex-col items-center rounded-2xl border-2 border-dashed px-6 py-12 text-center transition ${
        dragging
          ? "border-accent bg-accent-soft/60"
          : "border-slate-300 dark:border-slate-600"
      } ${disabled ? "opacity-60" : ""}`}
    >
      <FilePlus2 className="text-accent" size={34} strokeWidth={1.6} />
      <p className="mt-4 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
        Drag &amp; drop more files here
      </p>
      <p className="mt-1 text-sm text-slate-400">
        PDF, Markdown (.md) or Text (.txt)
      </p>

      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        className="mt-5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-200"
      >
        Browse files
      </button>

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
    </div>
  );
}
