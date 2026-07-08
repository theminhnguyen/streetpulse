/**
 * Schlanker localStorage-Wrapper für StreetPulse.
 * Alles unter einem Schlüssel gebündelt; robust gegen deaktivierten Speicher
 * (z.B. privater Modus) – dann arbeitet die App einfach ohne Persistenz weiter.
 */
const KEY = "streetpulse.v1";

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}

function writeAll(obj) {
  try {
    localStorage.setItem(KEY, JSON.stringify(obj));
    return true;
  } catch {
    return false; // Speicher voll oder gesperrt – nicht kritisch
  }
}

export const storage = {
  get(key, fallback) {
    const all = readAll();
    return key in all ? all[key] : fallback;
  },
  set(key, value) {
    const all = readAll();
    all[key] = value;
    return writeAll(all);
  },
  remove(key) {
    const all = readAll();
    delete all[key];
    writeAll(all);
  },
};
