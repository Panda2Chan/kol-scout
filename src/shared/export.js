const CSV_HEADERS = [
  "name",
  "platform",
  "handle",
  "profileUrl",
  "email",
  "followers",
  "score",
  "status",
  "tags",
  "notes",
  "bio",
  "sourcePage",
  "capturedAt"
];

export function downloadJson(filename, data) {
  downloadBlob(filename, JSON.stringify(data.map(toExportKol), null, 2), "application/json");
}

export function downloadCsv(filename, kols) {
  const rows = [
    CSV_HEADERS,
    ...kols.map((kol) => {
      const exportKol = toExportKol(kol);
      return [
        exportKol.name,
        exportKol.platform,
        exportKol.handle,
        exportKol.profileUrl,
        exportKol.email,
        exportKol.followers,
        exportKol.score,
        exportKol.status,
        (exportKol.tags || []).join("|"),
        exportKol.notes,
        exportKol.bio,
        exportKol.sourcePage,
        exportKol.capturedAt
      ];
    })
  ];

  downloadBlob(filename || `kol-lite-${new Date().toISOString().slice(0, 10)}.csv`, toCsv(rows), "text/csv");
}

function toExportKol(kol) {
  return {
    name: kol.name || "",
    platform: kol.platform || "",
    handle: kol.handle || "",
    profileUrl: kol.profileUrl || "",
    email: kol.contact?.email || extractEmail(`${kol.bio || ""} ${kol.discovery?.evidenceText || ""}`),
    followers: kol.metrics?.followers ?? "",
    score: kol.score ?? "",
    status: kol.status || "",
    tags: kol.tags || [],
    notes: kol.notes || "",
    bio: kol.bio || "",
    sourcePage: kol.source?.pageUrl || "",
    capturedAt: kol.source?.capturedAt ? new Date(kol.source.capturedAt).toISOString() : ""
  };
}

function extractEmail(text) {
  const match = String(text || "")
    .replace(/\s*(?:\[at]|\(at\)| at )\s*/gi, "@")
    .replace(/\s*(?:\[dot]|\(dot\)| dot )\s*/gi, ".")
    .match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match?.[0] || "";
}

function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
}

function downloadBlob(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
