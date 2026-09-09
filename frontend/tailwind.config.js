/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Matches the shared "Foundations" design-system reference: a deep
        // teal-green as the single dominant accent (buttons, switches,
        // tabs, badges, progress), on a warm cream page background below.
        brand: {
          50: "#eef5f2",
          100: "#d7e8e2",
          200: "#b0d1c5",
          300: "#82b5a5",
          400: "#559685",
          500: "#3d7d6d",
          600: "#2b6357",
          700: "#234f46",
          800: "#1c3f38",
          900: "#16332d",
        },
        // The reference's warm cream page background (cards stay white on
        // top of it, same as this app's existing bg-white card pattern).
        cream: {
          DEFAULT: "#f2ece1",
          100: "#f7f2ea",
          200: "#ece3d4",
        },
      },
    },
  },
  plugins: [],
};
