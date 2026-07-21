import { useI18n } from "../lib/i18n";

/** Minimal attribution footer shown at the bottom of every page. */
export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="mt-10 py-4 text-center text-xs text-slate-400 dark:text-slate-600">
      {t("footer.developedBy")}{" "}
      <a
        href="https://github.com/estebandev213"
        target="_blank"
        rel="noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-slate-600 dark:hover:text-slate-400"
      >
        estebandev213
      </a>
    </footer>
  );
}
