/** Same host allowlist idea as the existing cloud-OCR page: workers.dev or loopback only. */

export function isWorkerUrlAllowed(url) {
  let parsed;
  try {
    parsed = new URL(String(url || "").trim());
  } catch (e) {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname;
  if (parsed.protocol === "http:") {
    return host === "localhost" || host === "127.0.0.1";
  }
  if (parsed.protocol !== "https:") return false;
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  const parts = host.split(".");
  if (parts.length < 3) return false;
  if (parts.slice(-2).join(".") !== "workers.dev") return false;
  return parts.slice(0, -2).every(function (part) { return part.length > 0; });
}

/** POST target on the existing checker-vision-ocr worker. */
export function ocrEndpoint(raw) {
  const value = String(raw || "").trim();
  if (!isWorkerUrlAllowed(value)) return "";
  return new URL("/ocr", value).toString();
}
