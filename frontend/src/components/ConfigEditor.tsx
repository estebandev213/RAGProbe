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
import { strategyLabel, useI18n } from "../lib/i18n";
import type { ConfigSpec, Strategy } from "../types";

const STRATEGY_VALUES: Strategy[] = ["vector", "bm25", "hybrid"];
const CHUNK_PRESETS = [256, 400, 512, 800, 1024];

interface NumberFieldProps {
  id: string;
  value: number;
  min: number;
  max: number;
  step: number;
  listId?: string;
  suffix?: string;
  onCommit: (value: number) => void;
}

function NumberField({
  id,
  value,
  min,
  max,
  step,
  listId,
  suffix,
  onCommit,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const displayValue = draft ?? String(value);

  function commit(raw: string) {
    onCommit(clampConfigValue(Number(raw), min, max));
    setDraft(null);
  }

  return (
    <div className="relative">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        list={listId}
        min={min}
        max={max}
        step={step}
        value={displayValue}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (next.trim() === "") return;

          const parsed = Number(next);
          if (Number.isFinite(parsed)) onCommit(Math.round(parsed));
        }}
        onBlur={(e) => commit(e.target.value)}
        className={`w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-mono text-sm tabular-nums text-slate-800 shadow-sm outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/30 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100 ${
          suffix ? "pr-14" : ""
        }`}
      />
      {suffix && (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center font-mono text-[11px] text-slate-400">
          {suffix}
        </span>
      )}
    </div>
  );
}

/** Pick a fresh config that doesn't collide with the existing set, if possible. */
function nextConfig(configs: ConfigSpec[]): ConfigSpec {
  const taken = new Set(configs.map(keyOf));
  for (const chunk_size of [400, 800, 512, 256, 1024]) {
    for (const strategy of STRATEGY_VALUES) {
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
  const { language, t } = useI18n();
  const [open, setOpen] = useState(true);
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
            {t("config.title")}
          </span>
          <span className="mt-0.5 block text-sm text-slate-500 dark:text-slate-400">
            {t("config.subtitle")}
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
              {demoMode ? t("config.demoCap") : t("config.fullCap")}
            </p>
            <button
              type="button"
              onClick={add}
              disabled={atCap}
              className="inline-flex items-center gap-1.5 rounded-lg border border-accent/30 bg-accent-soft px-3 py-1.5 text-sm font-medium text-accent transition hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-accent/10"
            >
              <Plus size={15} /> {t("config.add")}
            </button>
          </div>

          <datalist id={presetsId}>
            {CHUNK_PRESETS.map((size) => (
              <option key={size} value={size} />
            ))}
          </datalist>

          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
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
                      {t("config.item")} {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      disabled={configs.length <= 1}
                      aria-label={`${t("config.remove")} ${index + 1}`}
                      className="text-slate-400 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:text-slate-400"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                    {t("config.strategy")}
                  </label>
                  <div className="mb-4 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1 dark:bg-slate-800">
                    {STRATEGY_VALUES.map((strategy) => {
                      const active = config.strategy === strategy;
                      return (
                        <button
                          key={strategy}
                          type="button"
                          title={t(`strategy.${strategy}.hint`)}
                          aria-pressed={active}
                          onClick={() => patch(index, { strategy })}
                          className={`rounded-md px-2 py-1.5 text-xs font-medium transition ${
                            active
                              ? "bg-white text-accent shadow-sm dark:bg-slate-900 dark:text-accent"
                              : "text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
                          }`}
                        >
                          {strategyLabel(language, strategy)}
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
                        {t("config.chunk")}
                      </label>
                      <div className="relative">
                        <NumberField
                          id={`chunk-${index}`}
                          listId={presetsId}
                          min={MIN_CHUNK_SIZE}
                          max={MAX_CHUNK_SIZE}
                          step={16}
                          value={config.chunk_size}
                          suffix="tok"
                          onCommit={(chunk_size) =>
                            patch(index, { chunk_size })
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <label
                        htmlFor={`topk-${index}`}
                        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-400"
                      >
                        Top-K
                      </label>
                      <NumberField
                        id={`topk-${index}`}
                        min={MIN_TOP_K}
                        max={MAX_TOP_K}
                        step={1}
                        value={config.top_k}
                        onCommit={(top_k) => patch(index, { top_k })}
                      />
                    </div>
                  </div>

                  {isDupe && (
                    <p className="mt-3 text-xs font-medium text-red-500">
                      {t("config.duplicate")}
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
