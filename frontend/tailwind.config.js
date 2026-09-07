/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eef7fd",
          100: "#d9edfa",
          400: "#5fb3e8",
          500: "#2f8fd6",
          600: "#1f6fb0",
          700: "#1a5a8f",
          900: "#123a5c",
        },
      },
    },
  },
  plugins: [],
};
