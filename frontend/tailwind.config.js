/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        display: ['"Space Grotesk"', "system-ui", "sans-serif"],
        sans: ['"Inter"', "system-ui", "sans-serif"],
        mono: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      colors: {
        // One calibrated accent, used only for scores, verdicts, and primary actions.
        accent: {
          DEFAULT: "#2563eb",
          fg: "#1d4ed8",
          soft: "#eef2ff",
        },
      },
      keyframes: {
        "fade-in": {
          from: { opacity: "0", transform: "translateY(2px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        "trophy-float": {
          "0%, 100%": {
            transform: "translateY(0) rotate(-3deg)",
            filter: "drop-shadow(0 4px 10px rgba(37,99,235,0.25))",
          },
          "50%": {
            transform: "translateY(-6px) rotate(3deg)",
            filter: "drop-shadow(0 10px 18px rgba(37,99,235,0.45))",
          },
        },
        "float-soft": {
          "0%, 100%": {
            transform: "translateY(0)",
            filter: "drop-shadow(0 3px 6px rgba(37,99,235,0.18))",
          },
          "50%": {
            transform: "translateY(-5px)",
            filter: "drop-shadow(0 9px 14px rgba(37,99,235,0.34))",
          },
        },
        "pop-in": {
          from: { opacity: "0", transform: "scale(0.5) translateY(8px)" },
          to: { opacity: "1", transform: "scale(1) translateY(0)" },
        },
        "line-grow": {
          from: { transform: "scaleX(0)" },
          to: { transform: "scaleX(1)" },
        },
        "text-rise": {
          from: { opacity: "0", transform: "translateY(4px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "trophy-float": "trophy-float 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "float-soft": "float-soft 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "pop-in": "pop-in 520ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "line-grow": "line-grow 500ms ease-out both",
        "text-rise": "text-rise 420ms ease-out both",
      },
    },
  },
  plugins: [],
};
