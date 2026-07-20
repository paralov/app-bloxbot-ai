(function () {
  try {
    var stored = localStorage.getItem("bloxbot-config");
    var theme = stored ? JSON.parse(stored).theme : "system";
    if (theme !== "light" && theme !== "dark" && theme !== "system") theme = "system";
    var prefersDark =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches;
    var dark = theme === "dark" || (theme === "system" && prefersDark);
    if (dark) document.documentElement.classList.add("dark");
  } catch (_) {}
})();
