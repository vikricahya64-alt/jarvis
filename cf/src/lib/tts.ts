//=====================================================================
// tts.ts — free speech synthesis (TTS) for the voice loop.
// Uses Google Translate's unofficial TTS endpoint (no API key, free tier,
// mp3 out, Indonesian `id`). Bounded: one request per short utterance,
// cap length at ~180 chars (endpoint limit). Fail-closed → null.
//=====================================================================

/** Synthesize Indonesian speech from plain text. Returns mp3 bytes + mime,
 *  or null on any failure/unreachable/failed response. Never throws. */
export async function synthesizeSpeech(text: string): Promise<{ bytes: Uint8Array; mime: string } | null> {
  try {
    const clean = (text || "").replace(/\s+/g, " ").trim().slice(0, 180);
    if (clean.length < 2) return null;
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=id&q=${encodeURIComponent(clean)}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Linux; Android 10) JARVIS/1.0" },
    });
    if (!res.ok) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 100) return null;
    return { bytes: buf, mime: res.headers.get("Content-Type") ?? "audio/mpeg" };
  } catch {
    return null;
  }
}