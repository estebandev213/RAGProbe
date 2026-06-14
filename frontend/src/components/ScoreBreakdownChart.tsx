import { Info } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { configColor } from "../lib/configColors";
import { QTYPE_LABEL, QTYPE_ORDER } from "../lib/qtype";
import type { ConfigBreakdown } from "../types";

/** Track the reduced-motion preference so we can disable chart animation. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

interface TickProps {
  x?: number;
  y?: number;
  payload?: { value: string };
}

// The axis category encodes "label␁count" so a single stateless, module-level
// tick can render both lines without capturing render-scope state.
const TICK_SEP = "";

function AxisTick({ x = 0, y = 0, payload }: TickProps) {
  const [label = "", countRaw = "0"] = (payload?.value ?? "").split(TICK_SEP);
  const count = Number(countRaw);
  return (
    <g transform={`translate(${x},${y})`}>
      <text
        x={0}
        y={0}
        dy={14}
        textAnchor="middle"
        className="fill-slate-600 text-xs font-medium dark:fill-slate-300"
      >
        {label}
      </text>
      <text
        x={0}
        y={0}
        dy={30}
        textAnchor="middle"
        className="fill-slate-400 text-[11px]"
      >
        ({count} {count === 1 ? "question" : "questions"})
      </text>
    </g>
  );
}

/**
 * Score by question type, grouped by config (§8). This is where a systemic
 * weakness — every config tanking on multi-hop — becomes visible at a glance.
 */
export function ScoreBreakdownChart({
  breakdown,
}: {
  breakdown: ConfigBreakdown[];
}) {
  const reducedMotion = usePrefersReducedMotion();

  // Pivot to one row per question type with a column per config label. The axis
  // category carries the shared question count (from the first config) so the
  // module-level tick can render it on a second line.
  const data = QTYPE_ORDER.map((qtype) => {
    const count =
      breakdown[0]?.by_qtype.find((entry) => entry.qtype === qtype)?.n ?? 0;
    const row: Record<string, number | string> = {
      qtype: `${QTYPE_LABEL[qtype]}${TICK_SEP}${count}`,
    };
    for (const config of breakdown) {
      const score = config.by_qtype.find((entry) => entry.qtype === qtype);
      if (score) row[config.label] = Number(score.composite.toFixed(3));
    }
    return row;
  });

  // The hardest type across all configs, for the takeaway caption.
  const hardest = QTYPE_ORDER.map((qtype) => {
    const scores = breakdown
      .map(
        (config) =>
          config.by_qtype.find((entry) => entry.qtype === qtype)?.composite,
      )
      .filter((value): value is number => value !== undefined);
    const mean = scores.length
      ? scores.reduce((sum, value) => sum + value, 0) / scores.length
      : 1;
    return { qtype, mean };
  }).sort((a, b) => a.mean - b.mean)[0];

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 font-display text-base font-semibold text-slate-800 dark:text-slate-100">
          Score by question type
          <Info size={14} className="text-slate-300" />
        </h2>
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {breakdown.map((config, index) => (
          <span
            key={config.config_id}
            className="flex items-center gap-1.5 text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            <span
              className={`h-2.5 w-2.5 rounded-full ${configColor(index).dot}`}
            />
            {config.label}
          </span>
        ))}
      </div>

      <div className="mt-4 h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 24, left: -16 }}
          >
            <CartesianGrid
              vertical={false}
              strokeDasharray="3 3"
              stroke="#e2e8f0"
            />
            <XAxis
              dataKey="qtype"
              tickLine={false}
              axisLine={false}
              interval={0}
              height={44}
              tick={<AxisTick />}
            />
            <YAxis
              domain={[0, 1]}
              ticks={[0, 0.25, 0.5, 0.75, 1]}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "#94a3b8" }}
            />
            <Tooltip
              cursor={{ fill: "rgba(148,163,184,0.12)" }}
              contentStyle={{
                borderRadius: 12,
                border: "1px solid #e2e8f0",
                fontSize: 12,
              }}
              formatter={(value) => Number(value).toFixed(2)}
              labelFormatter={(label) => String(label).split(TICK_SEP)[0]}
            />
            {breakdown.map((config, index) => (
              <Bar
                key={config.config_id}
                dataKey={config.label}
                fill={configColor(index).hex}
                radius={[3, 3, 0, 0]}
                maxBarSize={26}
                isAnimationActive={!reducedMotion}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-2 flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
        <Info size={13} className="shrink-0 text-slate-400" />
        All configurations struggle most with{" "}
        {QTYPE_LABEL[hardest.qtype].toLowerCase()} questions.
      </div>
    </div>
  );
}
