(function () {
  try {
    var stored = localStorage.getItem("bloxbot-config");
    var theme = stored ? JSON.parse(stored).theme : "system";
    if (theme !== "light" && theme !== "dark" && theme !== "system") theme = "system";
    var dark =
      theme === "dark" ||
      (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    if (dark) document.documentElement.classList.add("dark");
  } catch (_) {}
})();
