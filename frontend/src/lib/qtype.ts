/** Display order and labels for the four question types of the exam (§6.3). */

import type { QType } from "../types";

/** The taxonomy order used on the breakdown chart and failure filters. */
export const QTYPE_ORDER: QType[] = [
  "factual",
  "multihop",
  "paraphrase",
  "unanswerable",
];

/** Human-readable label per question type. */
export const QTYPE_LABEL: Record<QType, string> = {
  factual: "Factual",
  multihop: "Multi-hop",
  paraphrase: "Paraphrase",
  unanswerable: "Unanswerable",
};
