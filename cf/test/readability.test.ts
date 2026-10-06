import { stripResearchApparatus } from "../src/lib/telegram_gate";

const cases: [string, string, string][] = [
  ["sitasi+TID", "Otoritas adalah istilah【1†https://kbbi.co.id/arti-kata/otoritas】.", "Otoritas adalah istilah."],
  ["sitasi url polos", "Definisi itu【https://pintu.co.id/a】 jelas.", "Definisi itu jelas."],
  ["daftar URL", "Blockchain itu 【https://id.wikipedia.org/wiki/Bitcoin】.", "Blockchain itu."],
  ["kolom sumber", "Bitcoin decentralized.\nSumber: https://a.com, https://b.com", "Bitcoin decentralized."],
  ["URL di dalam kalimat", "Lihat https://a.com untuk detail.", "Lihat untuk detail."],
  ["tanpa sitasi -> tak berubah", "Otoritas itu hak untuk menyuruh orang lain ikut aturan.", "Otoritas itu hak untuk menyuruh orang lain ikut aturan."],
  ["tag confident", "Hasilnya 【high】 begini.", "Hasilnya begini."],
];
let bad = 0;
for (const [label, input, want] of cases) {
  const got = stripResearchApparatus(input);
  const ok = got === want;
  if (!ok) bad++;
  console.log(`  ${ok ? "✓" : "✗"} ${label}${ok ? "" : `\n      dapat: ${JSON.stringify(got)}\n      harap: ${JSON.stringify(want)}`}`);
}
console.log(bad === 0 ? "\nREADABILITY TESTS PASSED" : `\n${bad} FAILED`);
process.exit(bad === 0 ? 0 : 1);
