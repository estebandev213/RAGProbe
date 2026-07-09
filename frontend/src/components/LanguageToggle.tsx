import { Languages } from "lucide-react";
import { useI18n } from "../lib/i18n";

/** English/Spanish switch; persists through the shared i18n provider. */
export function LanguageToggle() {
  const { language, setLanguage, t } = useI18n();
  const nextLanguage = language === "en" ? "es" : "en";

  return (
    <button
      type="button"
      onClick={() => setLanguage(nextLanguage)}
      aria-label={t("language.switch")}
      title={t("language.name")}
      className="flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg px-2 text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      <Languages size={17} />
      <span className="font-mono text-[11px] font-semibold">
        {t("language.short")}
      </span>
    </button>
  );
}
