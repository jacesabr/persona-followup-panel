/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        serif: ['"EB Garamond"', "Georgia", "serif"],
      },
    },
  },
  plugins: [],
};
