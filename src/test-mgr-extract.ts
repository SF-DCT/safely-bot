import {
  extractWeeklyMgrIdeas,
  formatExtractResultForSlack,
} from "./data-sources/mgr-idea-extract.js";

/**
 * MGR Weekly idea extraction の手動実行用スクリプト
 * Railway 上で `node dist/test-mgr-extract.js` で叩く想定
 */
async function main() {
  console.log("[Test] Starting MGR weekly idea extraction (manual run)...");
  try {
    const result = await extractWeeklyMgrIdeas();
    console.log(formatExtractResultForSlack(result));
    console.log("\n--- raw result ---");
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error("[Test] Extraction failed:", e);
    process.exit(1);
  }
}

main();
