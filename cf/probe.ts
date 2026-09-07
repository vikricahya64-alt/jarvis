import { extractTopic, isFollowUpQuery, isPureContinuation } from "./src/lib/ai";
async function main() {
  for (const m of ["Berikan detail bisnis kerajinan", "Lanjutkan", "Lanjut", "berikan rincian tentang bisnis kerajinan", "tentang bisnis kerajinan"]) {
    console.log(JSON.stringify(m), "| topic:", JSON.stringify(extractTopic(m)), "| followup:", isFollowUpQuery(m), "| pureCont:", isPureContinuation(m));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
