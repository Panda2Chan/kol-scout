export default {
  content: ["./src/popup/**/*.{html,js}", "./preview.html"],
  theme: {
    extend: {
      colors: {
        ink: "#172033",
        muted: "#667085",
        line: "#d9e0ea",
        brand: "#276ef1",
        teal: "#16837a",
        amber: "#b76e00"
      }
    }
  },
  corePlugins: {
    preflight: true
  }
};
