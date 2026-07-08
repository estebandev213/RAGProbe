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
        "message-rise": {
          from: {
            opacity: "0",
            transform: "translate3d(0, 8px, 0)",
          },
          to: {
            opacity: "1",
            transform: "translate3d(0, 0, 0)",
          },
        },
        "message-pop-left": {
          from: {
            opacity: "0",
            transform: "translate3d(0, 8px, 0) scale(0.96)",
          },
          to: {
            opacity: "1",
            transform: "translate3d(0, 0, 0) scale(1)",
          },
        },
        "message-pop-right": {
          from: {
            opacity: "0",
            transform: "translate3d(0, 8px, 0) scale(0.96)",
          },
          to: {
            opacity: "1",
            transform: "translate3d(0, 0, 0) scale(1)",
          },
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
        "glow-pulse": {
          "0%, 100%": { opacity: "0.06", transform: "scaleX(1)" },
          "50%": { opacity: "0.16", transform: "scaleX(1.06)" },
        },
        "slide-in-right": {
          from: { opacity: "0", transform: "translateX(18px) scale(0.97)" },
          to: { opacity: "1", transform: "translateX(0) scale(1)" },
        },
        "slide-in-left": {
          from: { opacity: "0", transform: "translateX(-18px) scale(0.97)" },
          to: { opacity: "1", transform: "translateX(0) scale(1)" },
        },
        materialize: {
          "0%": { opacity: "0", transform: "translateY(4px) scale(0.94)" },
          "100%": { opacity: "1", transform: "translateY(0) scale(1)" },
        },
        sweep: {
          "0%": { transform: "translateX(-120%)" },
          "100%": { transform: "translateX(120%)" },
        },
        "verdict-stamp": {
          "0%": { opacity: "0", transform: "scale(1.12) rotate(-3deg)" },
          "55%": { opacity: "1", transform: "scale(0.96) rotate(1.2deg)" },
          "78%": { transform: "scale(1.015) rotate(-0.4deg)" },
          "100%": { opacity: "1", transform: "scale(1) rotate(0deg)" },
        },
      },
      animation: {
        "fade-in": "fade-in 160ms ease-out",
        "message-rise": "message-rise 520ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "message-pop-left": "message-pop-left 460ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "message-pop-right": "message-pop-right 460ms cubic-bezier(0.22, 1, 0.36, 1) both",
        "trophy-float": "trophy-float 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "float-soft": "float-soft 4.8s cubic-bezier(0.4, 0, 0.2, 1) infinite",
        "pop-in": "pop-in 520ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "line-grow": "line-grow 500ms ease-out both",
        "text-rise": "text-rise 420ms ease-out both",
        "glow-pulse": "glow-pulse 3.6s ease-in-out infinite",
        "slide-in-right": "slide-in-right 360ms cubic-bezier(0.16, 1, 0.3, 1) both",
        "slide-in-left": "slide-in-left 360ms cubic-bezier(0.16, 1, 0.3, 1) both",
        materialize: "materialize 280ms ease-out both",
        scan: "sweep 1.6s ease-in-out infinite",
        sheen: "sweep 900ms ease-out 1 both",
        "verdict-stamp": "verdict-stamp 520ms cubic-bezier(0.22, 1.5, 0.36, 1) both",
      },
    },
  },
  plugins: [],
};
