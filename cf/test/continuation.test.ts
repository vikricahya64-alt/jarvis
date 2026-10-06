import { splitForTelegram, isContinuationWord } from "../src/lib/telegram_gate";

const CAP = 700;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

const short = "Bitcoin adalah mata uang digital.";
const long = Array.from({ length: 12 }, (_, i) =>
  `Kalimat nomor ${i + 1} menjelaskan blockchain dengan cukup panjang agar memakan karakter. `).join("");

const parts = splitForTelegram(long);
const checks: [string, boolean][] = [
  ["jawaban pendek tidak dipecah", splitForTelegram(short).length === 1 && splitForTelegram(short)[0] === short],
  ["jawaban panjang jadi >1 bagian", parts.length > 1],
  ["semua bagian <= batas kirim", parts.every((p) => p.length <= CAP)],
  ["tidak ada satu karakter pun hilang", norm(parts.join(" ")) === norm(long)],
  ["potongannya jatuh di batas kalimat", parts.every((p) => /[.!?:;]"?\s*$/.test(p))],
  ["teks kosong aman", splitForTelegram("").length === 0],
  ["tanpa tanda baca tetap terpecah", splitForTelegram("a".repeat(1500)).length > 1],
];
let bad = 0;
for (const [label, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "✓" : "✗"} ${label}`); }

const ctrl: [string, boolean][] = [
  ["lanjut", true], ["Lanjut", true], ["lanjut.", true], ["lanjut dong", true],
  ["terus", true], ["next", true],
  ["lanjutin ya bang", false], ["lanjut ya, PasarVDX 9 di 2026 berapa?", false],
  ["apa itu bitcoin", false], ["lanjutkan penjelasan itu", false],
];
for (const [label, want] of ctrl) {
  const got = isContinuationWord(label);
  if (got !== want) bad++;
  console.log(`  ${got === want ? "✓" : "✗"} ${got === want ? "" : "( salah) "}"${label}" -> ${got}, harap ${want}`);
}
console.log(bad === 0 ? "\nCONTINUATION TESTS PASSED" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
