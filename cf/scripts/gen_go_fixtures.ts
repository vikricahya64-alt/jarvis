/**
 * Generate cf/gomod/testdata/fixtures.json FROM THE LIVE IMPLEMENTATIONS.
 *
 * Both functions are imported from src/, not copied. Copying them would let the
 * fixtures drift away from the code that actually runs in production, and the
 * whole point of the Go port is that it is held to this exact behaviour - so
 * the fixtures have to be derived from it, never retyped.
 *
 * Run: npm run test:go:fixtures
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { normalize } from "../src/lib/moderation";
import { normalizeLinkForCompare } from "../src/lib/verifier";

const NORMALIZE_CASES = [
  "", " ", "HALO DUNIA", "  Halo   DUNIA   transient  ",
  "göyáng", "GÖYÁNG", "ÀÉÎÕÜ", "ñ", "ǹ",
  "Кот", "Привет мир", "日本語 テキスト", "한국어 텍스트",
  "مرحبا بالعالم", "עברית", "ĄĆĘŁŃÓŚŹŻ", "ĹŔĀĂĄ",
  "é vs é", "Ångström", "ß vs ss", "İstanbul",
  "mixed CASE with   irregular\t\tspacing\nand\nnewlines",
  "user_id=1234 token=abc", "https://example.com/x",
  "‌‍ zero width", "🎉🎊 emoji test 🔥",
  "à́̂̃ stacked marks",
  "ｱｲｳ fullwidth", "Ⅻ roman numeral",
  "combining after NFD only: ẛ̣",
  "turkisye ğ Ğ ı İ", "ǰ", "Ω ohm Ω",
  "combining class edge \u036f\u0370", "a\u0300b\u036fc",
];

const LINK_CASES = [
  "", "   ", "https://example.com", "http://example.com",
  "HTTPS://EXAMPLE.COM/Path", "www.example.com/x",
  "https://www.example.com/x/", "https://www.example.com///",
  "https://example.com/p?q=1&r=2", "https://example.com/p#frag",
  "https://example.com/p#frag?q=1", "ftp://example.com/x",
  "  https://example.com/spaced  ", "WWW.EXAMPLE.COM",
  "https://user:pw@example.com/auth", "https://example.com:8080/p",
  "https://example.com/Ünïcödé", "https://例え.jp/パス",
  "//example.com/proto-relative", "example.com/no-scheme",
  "https://", "https://.", "a?b#c",
];

const out = {
  note: "Generated from cf/src/lib by scripts/gen_go_fixtures.ts. Do not hand-edit.",
  normalize: NORMALIZE_CASES.map((i) => ({ in: i, out: normalize(i) })),
  normalizeLink: LINK_CASES.map((i) => ({ in: i, out: normalizeLinkForCompare(i) })),
};

const target = resolve(dirname(new URL(import.meta.url).pathname), "../gomod/testdata/fixtures.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(out, null, 2));
console.log(`fixtures: ${out.normalize.length} normalize + ${out.normalizeLink.length} normalizeLink -> gomod/testdata/fixtures.json`);