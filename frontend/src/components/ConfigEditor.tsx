import { ChevronDown, Layers, Plus, SlidersHorizontal, X } from "lucide-react";
import { useId, useState } from "react";
import {
  clampConfigValue,
  duplicateIndices,
  keyOf,
  MAX_CHUNK_SIZE,
  MAX_TOP_K,
  MIN_CHUNK_SIZE,
  MIN_TOP_K,
} from "../lib/configs";
import type { ConfigSpec, Strategy } from "../types";

const STRATEGIES: { value: Strategy; label: string; hint: string }[] = [
  { value: "vector", label: "Vector", hint: "Dense embedding similarity" },
  { value: "bm25", label: "BM25", hint: "Sparse keyword matching" },
  { value: "hybrid", label: "Hybrid", hint: "RRF fusion of both" },
];

const CHUNK_PRESETS = [256, 400, 512, 800, 1024];

/** Pick a fresh config that doesn't collide with the existing set, if possible. */
function nextConfig(configs: ConfigSpec[]): ConfigSpec {
  const taken = new Set(configs.map(keyOf));
  for (const chunk_size of [400, 800, 512, 256, 1024]) {
    for (const { value: strategy } of STRATEGIES) {
      const candidate: ConfigSpec = { chunk_size, strategy, top_k: 5 };
      if (!taken.has(keyOf(candidate))) return candidate;
    }
  }
  return { chunk_size: 400, strategy: "hybrid", top_k: 5 };
}

interface ConfigEditorProps {
  configs: ConfigSpec[];
  onChange: (configs: ConfigSpec[]) => void;
  maxConfigs: number;
  demoMode: boolean;
}

export function ConfigEditor({
  configs,
  onChange,
  maxConfigs,
  demoMode,
}: ConfigEditorProps) {
  const [open, setOpen] = useState(false);
  const presetsId = useId();
  const dupes = duplicateIndices(configs);
  const atCap = configs.length >= maxConfigs;

  function patch(index: number, next: Partial<ConfigSpec>) {
    onChange(
      configs.map((config, i) =>
        i === index ? { ...config, ...next } : config,
      ),
    );
  }

  function add() {
    if (atCap) return;
    onChange([...configs, nextConfig(configs)]);
  }

  function remove(index: number) {
    if (configs.length <= 1) return;
    onChange(configs.filter((_, i) => i !== index));
  }

  return (
    <div className="card overflow-hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-slate-50/70 dark:hover:bg-slate-800/40"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent dark:bg-accent/10">
          <SlidersHorizontal size={18} />
        </span>
        <span className="flex-1">
          <span className="block font-display font-semibold text-slate-800 dark:text-slate-100">
            Configuration
          </span>
          <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
            Tune the RAG configurations to evaluate: chunk size, strategy,
            depth.
          </span>
        </span>
        <span className="hidden items-center gap-2 font-mono text-xs text-slate-400 sm:flex">
          <Layers size={13} />
          {configs.length}/{maxConfigs}
        </span>
        <ChevronDown
          size={20}
          className={`shrink-0 text-slate-400 transition-transform duration-200 ${
            open ? "rotate-180" : ""
          }`}
        />
      </button>

      {open && (
        <div className="border-t border-slate-200/70 px-5 pb-5 pt-4 dark:border-slate-700/60">
          <div className="mb-4 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {demoMode
                ? "Demo mode allows up to 2 configurations."
                : "Full mode allows up to 4 configurations."}
            </p>
            <button
              type="button"
              onClick={add}
              disabled={atCap}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent/10"
            >
              <Plus size={15} /> Add configuration
            </button>
          </div>

          <datalist id={presetsId}>
            {CHUNK_PRESETS.map((size) => (
              <option key={size} value={size} />
            ))}
          </datalist>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {configs.map((config, index) => {
              const isDupe = dupes.has(index);
              return (
                <div
                  key={index}
                  className={`relative rounded-xl border bg-white/60 p-4 transition dark:bg-slate-900/40 ${
                    isDupe
                      ? "border-red-400/70 ring-1 ring-red-400/40"
                      : "border-slate-200/80 dark:border-slate-700/60"
                  }`}
                >
                  <div className="mb-3 flex items-center justify-between">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-accent">
                      Config {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={configs.length <= 1}
                      aria-label={`Remove configuration ${index + 1}`}
                      className="text-slate-400 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-400"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  {/* Strategy — segmented control, reads like an instrument selector. */}
                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    Strategy
                  </label>
                  <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                    {STRATEGIES.map((strategy) => {
                      const active = config.strategy === strategy.value;
                      return (
                        <button
                          key={strategy.value}
                          type="button"
                          title={strategy.hint}
                          aria-pressed={active}
                          onClick={() =>
                            patch(index, { strategy: strategy.value })
                          }
                          className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                            active
                              ? "bg-white text-accent shadow-sm dark:bg-slate-900 dark:text-accent"
                              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          {strategy.label}
                        </button>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label
                        htmlFor={`chunk-${index}`}
                        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                      >
                        Chunk size
                      </label>
                      <div className="relative">
                        <input
                          id={`chunk-${index}`}
                          type="number"
                          inputMode="numeric"
                          list={presetsId}
                          min={MIN_CHUNK_SIZE}
                          max={MAX_CHUNK_SIZE}
                          step={16}
                          value={config.chunk_size}
                          onChange={(e) =>
                            patch(index, { chunk_size: e.target.valueAsNumber })
                          }
                          onBlur={(e) =>
                            patch(index, {
                              chunk_size: clampConfigValue(
                                e.target.valueAsNumber,
                                MIN_CHUNK_SIZE,
                                MAX_CHUNK_SIZE,
                              ),
                            })
                          }
                          className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 pr-14 font-mono text-sm tabular-nums text-slate-800 shadow-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-[11px] text-slate-400">
                          tok
                        </span>
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor={`topk-${index}`}
                        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                      >
                        Top-K
                      </label>
                      <input
                        id={`topk-${index}`}
                        type="number"
                        inputMode="numeric"
                        min={MIN_TOP_K}
                        max={MAX_TOP_K}
                        step={1}
                        value={config.top_k}
                        onChange={(e) =>
                          patch(index, { top_k: e.target.valueAsNumber })
                        }
                        onBlur={(e) =>
                          patch(index, {
                            top_k: clampConfigValue(
                              e.target.valueAsNumber,
                              MIN_TOP_K,
                              MAX_TOP_K,
                            ),
                          })
                        }
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-800 shadow-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
                      />
                    </div>
                  </div>

                  {isDupe && (
                    <p className="mt-3 text-xs font-medium text-red-500">
                      Duplicate configuration — make it unique.
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
