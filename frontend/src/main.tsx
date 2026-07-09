import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { I18nProvider } from "./lib/i18n";

// Apply the saved theme before first paint to avoid a flash of the wrong mode.
try {
  if (localStorage.getItem("ragprobe:theme") === "dark") {
    document.documentElement.classList.add("dark");
  }
} catch {
  // storage unavailable; default to light
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </I18nProvider>
  </StrictMode>,
);
