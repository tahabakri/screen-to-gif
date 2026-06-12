import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// base: "./" makes asset paths relative so it works on GitHub Pages subpaths.
export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss()],
});
