import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { useI18n } from "../lib/i18n";

/** Light/dark switch; persists the choice and toggles the root `dark` class. */
export function ThemeToggle() {
  const { t } = useI18n();
  const [dark, setDark] = useState(() =>
    document.documentElement.classList.contains("dark"),
  );

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("ragprobe:theme", dark ? "dark" : "light");
    } catch {
      // ignore unavailable storage
    }
  }, [dark]);

  return (
    <button
      type="button"
      onClick={() => setDark((value) => !value)}
      aria-label={dark ? t("theme.light") : t("theme.dark")}
      className="flex h-9 w-9 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800 dark:hover:bg-slate-800 dark:hover:text-slate-200"
    >
      {dark ? <Moon size={18} /> : <Sun size={18} />}
    </button>
  );
}
