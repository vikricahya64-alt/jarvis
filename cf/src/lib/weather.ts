//=====================================================================
// weather.ts — city weather for the /kota command (owner convenience).
// Uses Open-Meteo (free, keyless): geocoding + 1-day forecast. Fail-closed:
// any network/parse error yields a graceful Indonesian message, never a throw.
// Mirrors the Python briefing's weather line format ("🌤 Cuaca ... hujan %").
//=====================================================================

const WMO_ID: Record<number, string> = {
  0: "Cerah",
  1: "Cerah berawan",
  2: "Berawan sebagian",
  3: "Berawan",
  45: "Kabut",
  48: "Kabut embun beku",
  51: "Gerimis ringan",
  53: "Gerimis",
  55: "Gerimis deras",
  56: "Gerimis beku ringan",
  57: "Gerimis beku deras",
  61: "Hujan ringan",
  63: "Hujan",
  65: "Hujan deras",
  66: "Hujan beku ringan",
  67: "Hujan beku",
  71: "Salju ringan",
  73: "Salju",
  75: "Salju lebat",
  77: "Butiran salju",
  80: "Hujan gerimis",
  81: "Hujan deras",
  82: "Hujan sangat deras",
  85: "Salju rintik",
  86: "Salju lebat",
  95: "Badai petir",
  96: "Badai petir + hujan es",
  99: "Badai petir + hujan es lebat",
};

/** Weather line for a city, in the same compact format as the morning briefing.
 *  Returns a graceful message (never throws) on any failure. */
export async function getWeatherText(city: string): Promise<string> {
  const clean = (city || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return "Tulis nama kota: /kota <nama>. Contoh: /kota Jakarta";
  }
  try {
    const geo = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(clean)}&count=1&language=id&format=json`,
    );
    if (!geo.ok) throw new Error("geocode-http");
    const geoJson = (await geo.json()) as {
      results?: { name: string; country?: string; latitude: number; longitude: number }[];
    };
    const hit = geoJson.results?.[0];
    if (!hit) {
      return `Lokasi "${clean}" tidak ditemukan. Coba ejaan lain, mis. "Jakarta".`;
    }
    const place = hit.country ? `${hit.name}, ${hit.country}` : hit.name;
    const f = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}` +
        `&current=temperature_2m,weather_code&daily=precipitation_probability_max,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`,
    );
    if (!f.ok) throw new Error("forecast-http");
    const fj = (await f.json()) as {
      current?: { temperature_2m: number; weather_code: number };
      daily?: { temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: number[] };
    };
    const cur = fj.current;
    const d = fj.daily;
    const desc = WMO_ID[cur?.weather_code ?? -1] ?? "Berawan";
    const t = cur ? Math.round(cur.temperature_2m) : 0;
    const tMin = d?.temperature_2m_min?.[0];
    const tMax = d?.temperature_2m_max?.[0];
    const rain = Math.round(d?.precipitation_probability_max?.[0] ?? 0);
    const range =
      tMin != null && tMax != null
        ? ` (min ${Math.round(tMin)}°C, max ${Math.round(tMax)}°C, hujan ${rain}%)`
        : "";
    return `🌤 Cuaca ${place}: ${desc}, ${t}°C${range}.`;
  } catch {
    return `Cuaca untuk "${clean}" tidak bisa diambil sekarang. Coba lagi sebentar.`;
  }
}