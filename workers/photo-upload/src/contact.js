/** Optional nickname / email. Both may be blank. No account is created. */

function fieldText(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

export function clipText(value, max) {
  const limit = Math.max(0, max);
  return fieldText(value).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, limit);
}

export function normalizeContact(nickname, email) {
  const name = clipText(nickname, 41);
  const mail = clipText(email, 121);
  if (name.length > 40 || mail.length > 120) return { error: "bad_contact" };
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) return { error: "bad_contact" };
  return { nickname: name, email: mail };
}
