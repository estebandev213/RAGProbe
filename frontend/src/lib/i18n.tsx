import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { QType, Strategy } from "../types";

export type Language = "en" | "es";

const STORAGE_KEY = "ragprobe:language";

const TRANSLATIONS = {
  en: {
    "nav.upload": "Upload",
    "nav.progress": "Progress",
    "nav.report": "Report",
    "nav.history": "History",
    "sidebar.show": "Show sidebar",
    "sidebar.hide": "Hide sidebar",
    "nav.github": "View source on GitHub",
    "footer.developedBy": "Developed by",
    "language.switch": "Switch language",
    "language.name": "English",
    "language.short": "EN",
    "theme.light": "Switch to light mode",
    "theme.dark": "Switch to dark mode",
    "upload.eyebrow": "Evaluate your RAG pipelines",
    "upload.title1": "Upload documents",
    "upload.title2": "and run an evaluation",
    "upload.body":
      "RAGProbe will generate an exam from your documents, run it against multiple RAG configurations, and deliver a detailed report card.",
    "upload.run": "Run evaluation",
    "upload.duplicateContinue": "Resolve duplicate configurations to continue",
    "upload.mode.demo": "demo",
    "upload.mode.full": "full",
    "upload.step": "Step",
    "upload.step.docs": "Upload your docs",
    "upload.step.exam": "Generate an exam from your docs",
    "upload.step.configs": "Run against multiple RAG configs",
    "upload.step.grade": "Grade every answer with an LLM judge",
    "upload.step.report": "Get a report with recommendations",
    "upload.card.title": "Upload",
    "upload.card.subtitle": "You can upload up to 5 files. Max 2MB each.",
    "upload.demo.on": "Demo mode is ON",
    "upload.demo.off": "Demo mode is OFF",
    "upload.demo.onBody":
      "Runs a reduced exam and caps you at 2 configurations so the evaluation fits free-tier rate limits.",
    "upload.demo.offBody":
      "Runs the full exam and lets you compare up to 4 configurations. Heavier on LLM calls, mind free-tier rate limits.",
    "upload.demo.toggle": "Toggle demo mode",
    "upload.scoring": "Scoring methodology",
    "upload.composite": "Composite score",
    "upload.taxonomy": "Question taxonomy",
    "metric.correctness": "Correctness",
    "metric.correctness.detail":
      "Model answer vs. gold answer, scored by an LLM judge.",
    "metric.faithfulness": "Faithfulness",
    "metric.faithfulness.detail":
      "Every claim in the answer supported by the retrieved context.",
    "metric.retrieval": "Retrieval hit",
    "metric.retrieval.detail":
      "Gold span >=50% overlapped by a retrieved chunk. Pure math, no LLM.",
    "dropzone.addMore": "Add more files",
    "dropzone.drag": "Drag & drop files here",
    "dropzone.types": "PDF, Markdown (.md) or Text (.txt)",
    "dropzone.browse": "Browse files",
    "dropzone.samples": "Use sample documents",
    "docs.characters": "characters",
    "docs.uploadedNow": "Uploaded just now",
    "docs.remove": "Remove",
    "config.title": "Configuration",
    "config.subtitle":
      "Tune the RAG configurations to evaluate: chunk size, strategy, depth.",
    "config.demoCap": "Demo mode allows up to 2 configurations.",
    "config.fullCap": "Full mode allows up to 4 configurations.",
    "config.add": "Add configuration",
    "config.item": "Config",
    "config.remove": "Remove configuration",
    "config.strategy": "Strategy",
    "config.chunk": "Chunk size",
    "config.duplicate": "Duplicate configuration - make it unique.",
    "strategy.vector": "Vector",
    "strategy.vector.hint": "Dense embedding similarity",
    "strategy.bm25": "BM25",
    "strategy.bm25.hint": "Sparse keyword matching",
    "strategy.hybrid": "Hybrid",
    "strategy.hybrid.hint": "RRF fusion of both",
    "run.title": "Run progress",
    "run.id": "Run ID:",
    "run.copy": "Copy run id",
    "run.demoMode": "Demo mode",
    "run.cancel": "Cancel run",
    "run.discard": "Discard this run?",
    "run.confirm": "Confirm",
    "run.keep": "Keep running",
    "run.elapsed": "Elapsed time",
    "run.started": "Started",
    "run.failed": "Run failed",
    "run.stalledTitle": "This run appears stalled.",
    "run.stalledBody":
      "No progress has arrived in a while, it may be throttled by the free tier, or the worker may have stopped. It will auto-cancel if this continues, or you can cancel it now and start over.",
    "run.connection.disconnected": "Disconnected",
    "run.connection.completed": "Completed",
    "run.connection.finished": "Run finished",
    "run.connection.active": "SSE Active",
    "run.connection.updates": "Receiving live updates",
    "run.connection.connecting": "Connecting...",
    "run.connection.opening": "Opening the event stream",
    "run.stat.documents": "Documents",
    "run.stat.exam": "Exam",
    "run.stat.configurations": "Configurations",
    "run.files": "files",
    "run.questions": "questions",
    "run.types": "types",
    "phase.generating_exam": "Generating exam",
    "phase.indexing": "Indexing",
    "phase.answering": "Answering",
    "phase.judging": "Judging",
    "phase.done": "Done",
    "phase.completed": "Completed",
    "phase.inProgress": "In progress",
    "phase.pending": "Pending",
    "log.created": "Run created",
    "log.demo": "Demo mode:",
    "log.demo.on": "ON (limits enabled)",
    "log.demo.off": "OFF",
    "log.generating": "Generating exam with LLM...",
    "log.indexing": "Indexing documents...",
    "log.answering": "Starting answering phase",
    "log.judging": "Judging answers...",
    "log.answeringQuestion": "Answering question",
    "log.judgingAnswer": "Judging answer",
    "log.completed": "Completed",
    "log.complete": "Run complete",
    "progress.title": "Configurations progress",
    "progress.matrix": "matrix",
    "progress.waiting": "Waiting for the answering phase to begin...",
    "event.title": "Live event log",
    "event.received": "received",
    "event.auto": "Auto-scroll",
    "event.toggle": "Toggle auto-scroll",
    "event.clear": "Clear",
    "event.empty": "No events yet.",
    "live.title": "Run evaluation",
    "live.live": "Live transcript",
    "live.complete": "Transcript complete",
    "live.events": "events",
    "live.waiting": "Waiting for the run to begin...",
    "live.question": "Question",
    "live.answer": "Model answer",
    "live.abstained": "abstained",
    "live.chunk": "chunk",
    "live.chunks": "chunks",
    "live.verdict": "Judge verdict",
    "live.confidence": "confidence",
    "live.score.correct": "correct",
    "live.score.faithful": "faithful",
    "live.score.retrieval": "retrieval",
    "report.new": "New evaluation",
    "report.failed.start": "Start a new evaluation",
    "report.failed.history": "View history",
    "report.loading": "Loading the report card...",
    "report.loadError": "Couldn't load this report",
    "report.notAvailable": "The report is not available yet.",
    "report.noGrades": "No graded answers yet",
    "report.noGradesBody":
      "This run produced no grades, so there's nothing to rank. Start a new evaluation from the upload screen.",
    "report.title": "Evaluation report",
    "report.completed": "Completed",
    "report.runId": "Run ID",
    "report.date": "Date",
    "report.highestCorrectness": "Highest correctness",
    "report.bestRetrieval": "Best retrieval",
    "report.lowestLatency": "Lowest latency",
    "report.inspectFailures": "Inspect failures",
    "report.inspectBody":
      "Explore where each configuration succeeded and failed.",
    "report.footer":
      "Scores are LLM-judged and may vary. Review failures for details.",
    "recommend.title": "Recommended configuration",
    "recommend.composite": "composite",
    "recommend.chunk": "Chunk size",
    "recommend.strategy": "Strategy",
    "leaderboard.title": "Leaderboard",
    "leaderboard.rank": "Rank",
    "leaderboard.config": "Configuration",
    "leaderboard.composite": "Composite",
    "leaderboard.correctness": "Correctness",
    "leaderboard.faithfulness": "Faithfulness",
    "leaderboard.retrieval": "Retrieval",
    "leaderboard.avgLatency": "Avg Latency",
    "leaderboard.higher": "higher is better",
    "leaderboard.lower": "lower is better",
    "breakdown.title": "Score by question type",
    "breakdown.struggle": "All configurations struggle most with",
    "failure.title": "Failure explorer",
    "failure.allConfigs": "All configurations",
    "failure.allTypes": "All question types",
    "failure.only": "Only failures",
    "failure.loading": "Loading graded answers...",
    "failure.noneFailures":
      "No failures match these filters - every answer scored a perfect composite.",
    "failure.noneAnswers": "No graded answers match these filters.",
    "failure.overridden": "Overridden",
    "failure.goldAnswer": "Gold answer",
    "failure.modelAnswer": "Model answer",
    "failure.goldSpans": "Gold spans",
    "failure.retrievedChunks": "Retrieved chunks",
    "failure.judgeRationale": "Judge rationale",
    "failure.override": "Override grade",
    "failure.overrideHelp":
      "Overriding a metric re-aggregates the leaderboard.",
    "history.title": "History",
    "history.new": "New evaluation",
    "history.rename": "Rename",
    "history.delete": "Delete",
    "history.noRuns": "No runs yet",
    "history.noRunsBody":
      "Every evaluation you run shows up here. Start one from the upload screen and it will be one click away afterwards.",
    "history.loading": "Loading run history...",
    "history.loadError": "Couldn't load run history",
    "history.notAvailable": "The run history is not available right now.",
    "history.subtitle": "Past evaluations, newest first.",
    "history.demoMode": "Demo mode",
    "history.more": "more",
    "history.confirmDelete": "Delete",
    "history.confirmDeleteTail": "This can't be undone.",
  },
  es: {
    "nav.upload": "Subir",
    "nav.progress": "Progreso",
    "nav.report": "Reporte",
    "nav.history": "Historial",
    "sidebar.show": "Mostrar barra lateral",
    "sidebar.hide": "Ocultar barra lateral",
    "nav.github": "Ver código fuente en GitHub",
    "footer.developedBy": "Desarrollado por",
    "language.switch": "Cambiar idioma",
    "language.name": "Español",
    "language.short": "ES",
    "theme.light": "Cambiar a modo claro",
    "theme.dark": "Cambiar a modo oscuro",
    "upload.eyebrow": "Evalua tus pipelines RAG",
    "upload.title1": "Sube documentos",
    "upload.title2": "y ejecuta una evaluacion",
    "upload.body":
      "RAGProbe generara un examen desde tus documentos, lo ejecutara contra varias configuraciones RAG y entregara un reporte detallado.",
    "upload.run": "Ejecutar evaluacion",
    "upload.duplicateContinue":
      "Resuelve las configuraciones duplicadas para continuar",
    "upload.mode.demo": "demo",
    "upload.mode.full": "completo",
    "upload.step": "Paso",
    "upload.step.docs": "Sube tus documentos",
    "upload.step.exam": "Genera un examen desde tus documentos",
    "upload.step.configs": "Prueba varias configuraciones RAG",
    "upload.step.grade": "Califica cada respuesta con un juez LLM",
    "upload.step.report": "Obtén un reporte con recomendaciones",
    "upload.card.title": "Subida",
    "upload.card.subtitle":
      "Puedes subir hasta 5 archivos. Maximo 2MB cada uno.",
    "upload.demo.on": "Modo demo ACTIVADO",
    "upload.demo.off": "Modo demo DESACTIVADO",
    "upload.demo.onBody":
      "Ejecuta un examen reducido y limita a 2 configuraciones para ajustarse a limites de planes gratuitos.",
    "upload.demo.offBody":
      "Ejecuta el examen completo y permite comparar hasta 4 configuraciones. Usa mas llamadas LLM; ten en cuenta los limites gratuitos.",
    "upload.demo.toggle": "Alternar modo demo",
    "upload.scoring": "Metodologia de calificacion",
    "upload.composite": "Puntaje compuesto",
    "upload.taxonomy": "Taxonomia de preguntas",
    "metric.correctness": "Correccion",
    "metric.correctness.detail":
      "Respuesta del modelo contra respuesta esperada, calificada por un juez LLM.",
    "metric.faithfulness": "Fidelidad",
    "metric.faithfulness.detail":
      "Cada afirmacion de la respuesta respaldada por el contexto recuperado.",
    "metric.retrieval": "Acierto de recuperacion",
    "metric.retrieval.detail":
      "Tramo esperado con >=50% de solapamiento con un chunk recuperado. Matematica pura, sin LLM.",
    "dropzone.addMore": "Agregar mas archivos",
    "dropzone.drag": "Arrastra y suelta archivos aqui",
    "dropzone.types": "PDF, Markdown (.md) o Texto (.txt)",
    "dropzone.browse": "Buscar archivos",
    "dropzone.samples": "Usar documentos de muestra",
    "docs.characters": "caracteres",
    "docs.uploadedNow": "Subido ahora",
    "docs.remove": "Quitar",
    "config.title": "Configuracion",
    "config.subtitle":
      "Ajusta las configuraciones RAG a evaluar: tamano de chunk, estrategia y profundidad.",
    "config.demoCap": "El modo demo permite hasta 2 configuraciones.",
    "config.fullCap": "El modo completo permite hasta 4 configuraciones.",
    "config.add": "Agregar configuracion",
    "config.item": "Config",
    "config.remove": "Quitar configuracion",
    "config.strategy": "Estrategia",
    "config.chunk": "Tamano de chunk",
    "config.duplicate": "Configuracion duplicada - hazla unica.",
    "strategy.vector": "Vector",
    "strategy.vector.hint": "Similitud de embeddings densos",
    "strategy.bm25": "BM25",
    "strategy.bm25.hint": "Coincidencia dispersa por palabras clave",
    "strategy.hybrid": "Hibrida",
    "strategy.hybrid.hint": "Fusion RRF de ambas",
    "run.title": "Progreso de ejecucion",
    "run.id": "ID de ejecucion:",
    "run.copy": "Copiar ID de ejecucion",
    "run.demoMode": "Modo demo",
    "run.cancel": "Cancelar ejecucion",
    "run.discard": "Descartar esta ejecucion?",
    "run.confirm": "Confirmar",
    "run.keep": "Mantener ejecucion",
    "run.elapsed": "Tiempo transcurrido",
    "run.started": "Iniciada",
    "run.failed": "La ejecucion fallo",
    "run.stalledTitle": "Esta ejecucion parece detenida.",
    "run.stalledBody":
      "No ha llegado progreso en un tiempo; puede estar limitada por el plan gratuito o el worker pudo haberse detenido. Se cancelara automaticamente si continua asi, o puedes cancelarla ahora y empezar de nuevo.",
    "run.connection.disconnected": "Desconectado",
    "run.connection.completed": "Completado",
    "run.connection.finished": "Ejecucion finalizada",
    "run.connection.active": "SSE activo",
    "run.connection.updates": "Recibiendo actualizaciones en vivo",
    "run.connection.connecting": "Conectando...",
    "run.connection.opening": "Abriendo el stream de eventos",
    "run.stat.documents": "Documentos",
    "run.stat.exam": "Examen",
    "run.stat.configurations": "Configuraciones",
    "run.files": "archivos",
    "run.questions": "preguntas",
    "run.types": "tipos",
    "phase.generating_exam": "Generando examen",
    "phase.indexing": "Indexando",
    "phase.answering": "Respondiendo",
    "phase.judging": "Evaluando",
    "phase.done": "Listo",
    "phase.completed": "Completado",
    "phase.inProgress": "En progreso",
    "phase.pending": "Pendiente",
    "log.created": "Ejecucion creada",
    "log.demo": "Modo demo:",
    "log.demo.on": "ACTIVADO (limites activos)",
    "log.demo.off": "DESACTIVADO",
    "log.generating": "Generando examen con LLM...",
    "log.indexing": "Indexando documentos...",
    "log.answering": "Iniciando fase de respuestas",
    "log.judging": "Evaluando respuestas...",
    "log.answeringQuestion": "Respondiendo pregunta",
    "log.judgingAnswer": "Evaluando respuesta",
    "log.completed": "Completado",
    "log.complete": "Ejecucion completa",
    "progress.title": "Progreso de configuraciones",
    "progress.matrix": "matriz",
    "progress.waiting": "Esperando que empiece la fase de respuestas...",
    "event.title": "Registro de eventos en vivo",
    "event.received": "recibidos",
    "event.auto": "Auto-scroll",
    "event.toggle": "Alternar auto-scroll",
    "event.clear": "Limpiar",
    "event.empty": "Aun no hay eventos.",
    "live.title": "Ejecutar evaluacion",
    "live.live": "Transcripcion en vivo",
    "live.complete": "Transcripcion completa",
    "live.events": "eventos",
    "live.waiting": "Esperando que la ejecucion empiece...",
    "live.question": "Pregunta",
    "live.answer": "Respuesta del modelo",
    "live.abstained": "se abstuvo",
    "live.chunk": "chunk",
    "live.chunks": "chunks",
    "live.verdict": "Veredicto del juez",
    "live.confidence": "confianza",
    "live.score.correct": "correcta",
    "live.score.faithful": "fiel",
    "live.score.retrieval": "recuperacion",
    "report.new": "Nueva evaluacion",
    "report.failed.start": "Iniciar nueva evaluacion",
    "report.failed.history": "Ver historial",
    "report.loading": "Cargando reporte...",
    "report.loadError": "No se pudo cargar este reporte",
    "report.notAvailable": "El reporte aun no esta disponible.",
    "report.noGrades": "Aun no hay respuestas calificadas",
    "report.noGradesBody":
      "Esta ejecucion no produjo calificaciones, asi que no hay nada que ordenar. Inicia una nueva evaluacion desde la pantalla de subida.",
    "report.title": "Reporte de evaluacion",
    "report.completed": "Completado",
    "report.runId": "ID de ejecucion",
    "report.date": "Fecha",
    "report.highestCorrectness": "Mayor correccion",
    "report.bestRetrieval": "Mejor recuperacion",
    "report.lowestLatency": "Menor latencia",
    "report.inspectFailures": "Inspeccionar fallos",
    "report.inspectBody": "Explora donde cada configuracion acerto y fallo.",
    "report.footer":
      "Los puntajes son juzgados por LLM y pueden variar. Revisa los fallos para ver detalles.",
    "recommend.title": "Configuracion recomendada",
    "recommend.composite": "compuesto",
    "recommend.chunk": "Tamano de chunk",
    "recommend.strategy": "Estrategia",
    "leaderboard.title": "Tabla de posiciones",
    "leaderboard.rank": "Rango",
    "leaderboard.config": "Configuracion",
    "leaderboard.composite": "Compuesto",
    "leaderboard.correctness": "Correccion",
    "leaderboard.faithfulness": "Fidelidad",
    "leaderboard.retrieval": "Recuperacion",
    "leaderboard.avgLatency": "Latencia prom.",
    "leaderboard.higher": "mayor es mejor",
    "leaderboard.lower": "menor es mejor",
    "breakdown.title": "Puntaje por tipo de pregunta",
    "breakdown.struggle": "Todas las configuraciones tienen mas dificultad con",
    "failure.title": "Explorador de fallos",
    "failure.allConfigs": "Todas las configuraciones",
    "failure.allTypes": "Todos los tipos de pregunta",
    "failure.only": "Solo fallos",
    "failure.loading": "Cargando respuestas calificadas...",
    "failure.noneFailures":
      "Ningun fallo coincide con estos filtros - todas las respuestas tuvieron compuesto perfecto.",
    "failure.noneAnswers":
      "Ninguna respuesta calificada coincide con estos filtros.",
    "failure.overridden": "Sobrescrito",
    "failure.goldAnswer": "Respuesta esperada",
    "failure.modelAnswer": "Respuesta del modelo",
    "failure.goldSpans": "Tramos esperados",
    "failure.retrievedChunks": "Chunks recuperados",
    "failure.judgeRationale": "Razonamiento del juez",
    "failure.override": "Sobrescribir calificacion",
    "failure.overrideHelp":
      "Sobrescribir una metrica recalcula la tabla de posiciones.",
    "history.title": "Historial",
    "history.new": "Nueva evaluacion",
    "history.rename": "Renombrar",
    "history.delete": "Eliminar",
    "history.noRuns": "Aun no hay ejecuciones",
    "history.noRunsBody":
      "Cada evaluacion que ejecutes aparecera aqui. Inicia una desde la pantalla de subida y luego quedara a un clic.",
    "history.loading": "Cargando historial...",
    "history.loadError": "No se pudo cargar el historial",
    "history.notAvailable": "El historial no esta disponible ahora.",
    "history.subtitle": "Evaluaciones pasadas, primero las mas recientes.",
    "history.demoMode": "Modo demo",
    "history.more": "mas",
    "history.confirmDelete": "Eliminar",
    "history.confirmDeleteTail": "Esto no se puede deshacer.",
  },
} as const;

export type TranslationKey = keyof (typeof TRANSLATIONS)["en"];

interface I18nContextValue {
  language: Language;
  setLanguage: (language: Language) => void;
  t: (key: TranslationKey) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function readInitialLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "es") return stored;
  } catch {
    // ignore unavailable storage
  }
  return navigator.language.toLowerCase().startsWith("es") ? "es" : "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(readInitialLanguage);

  useEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // ignore unavailable storage
    }
  }, [language]);

  const value = useMemo<I18nContextValue>(
    () => ({
      language,
      setLanguage,
      t: (key) => TRANSLATIONS[language][key],
    }),
    [language],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside I18nProvider");
  return context;
}

export function pluralize(
  language: Language,
  count: number,
  singular: string,
  plural: string,
): string {
  void language;
  return `${count} ${count === 1 ? singular : plural}`;
}

export function qtypeLabel(language: Language, qtype: QType): string {
  const labels: Record<Language, Record<QType, string>> = {
    en: {
      factual: "Factual",
      multihop: "Multi-hop",
      paraphrase: "Paraphrase",
      unanswerable: "Unanswerable",
    },
    es: {
      factual: "Factual",
      multihop: "Multi-salto",
      paraphrase: "Parafrasis",
      unanswerable: "Sin respuesta",
    },
  };
  return labels[language][qtype];
}

export function strategyLabel(language: Language, strategy: Strategy): string {
  const labels: Record<Language, Record<Strategy, string>> = {
    en: { vector: "Vector", bm25: "BM25", hybrid: "Hybrid" },
    es: { vector: "Vector", bm25: "BM25", hybrid: "Hibrida" },
  };
  return labels[language][strategy];
}
