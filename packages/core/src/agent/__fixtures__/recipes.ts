// A seed-like recipe for tests (the real ones are Plan T's os/recipes/*.json).
export const PYTHON = {
  id: "python-dev",
  title: { en: "Python development", ar: "تطوير بايثون" },
  description: { en: "Python 3 with pip and venv", ar: "بايثون 3 مع pip وvenv" },
  steps: [
    {
      tool: "pkg.install",
      input: {
        items: [
          { source: "apt", id: "python3" },
          { source: "apt", id: "python3-pip" },
        ],
      },
      title: { en: "Install Python", ar: "تثبيت بايثون" },
    },
    {
      tool: "pkg.install",
      input: { items: [{ source: "apt", id: "python3-venv" }] },
      title: { en: "Install venv", ar: "تثبيت venv" },
    },
    {
      tool: "svc.restart",
      input: { unit: "ssh" },
      title: { en: "Restart SSH", ar: "إعادة تشغيل SSH" },
    },
  ],
  requires: { os: "rafiq", minRamGB: 4 },
};
