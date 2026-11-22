import { defineConfig } from "@code-id-labs/plugin-vite";

export default defineConfig({
  prefix: "c",
  ui: {
    colors: {
      primary: "red",
      secondary: "stone",
      neutral: "zinc",
      danger: "red",
      success: "green",
      warning: "amber",
      info: "blue",
    },
    colorMode: "system",
  },
  icons: {
    collections: ["lucide"],
  },
  components: {},
});
