import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        primary: {
          DEFAULT: "#0F766E",
          50: "#F0FDFA",
          100: "#CCFBF1",
          500: "#14B8A6",
          600: "#0F766E",
          700: "#115E59",
        },
        secondary: {
          DEFAULT: "#1E293B",
          100: "#F1F5F9",
          500: "#475569",
          700: "#1E293B",
          900: "#0F172A",
        },
        accent: {
          DEFAULT: "#F59E0B",
          500: "#F59E0B",
          600: "#D97706",
        },
        surface: "#FFFFFF",
        background: "#F8FAFC",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Menlo", "monospace"],
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};

export default config;
