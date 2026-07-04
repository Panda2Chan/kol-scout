export default {
  content: ["./src/popup/**/*.{html,js}", "./preview.html"],
  theme: {
    extend: {
      colors: {
        ink: "#1F2937",
        muted: "#6B7280",
        line: "rgba(0,0,0,0.06)",
        brand: "#6366F1",
        brandHover: "#5B5BD6",
        warm: "#FFB84D",
        soft: "#F5F5F3",
        teal: "#6D5DD3",
        amber: "#F59E0B"
      }
    }
  },
  corePlugins: {
    preflight: true
  }
};
