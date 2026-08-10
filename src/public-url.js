export function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL;
  if (!raw) throw new Error("PUBLIC_BASE_URL is required");
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error("PUBLIC_BASE_URL must use HTTPS");
  return url.toString().replace(/\/$/, "");
}
