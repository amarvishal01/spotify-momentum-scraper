import fs from "fs/promises";
import path from "path";
import { chromium } from "playwright";

const PLAYLISTS_FILE = "playlists.json";
const OUTPUT_DIR = "output";
const MAKE_WEBHOOK_URL = "https://hook.us2.make.com/n5x7qcwd66ow72euk62kgt3zpqcwev6a";

function todayStr() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

function sanitizeText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function ensureOutputDir() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function loadPlaylists() {
  const raw = await fs.readFile(PLAYLISTS_FILE, "utf8");
  return JSON.parse(raw);
}

async function closeCookieOrConsent(page) {
  const candidates = [
    'button:has-text("Accept")',
    'button:has-text("I agree")',
    'button:has-text("Allow")',
    'button:has-text("Accept all")'
  ];

  for (const selector of candidates) {
    try {
      const el = page.locator(selector).first();
      if (await el.isVisible({ timeout: 1500 })) {
        await el.click({ timeout: 1500 });
        return;
      }
    } catch {}
  }
}

async function scrapePlaylist(page, playlist) {
  await page.goto(playlist.playlist_url, {
    waitUntil: "domcontentloaded",
    timeout: 120000
  });

  await closeCookieOrConsent(page);
  await page.waitForTimeout(3000);

  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, 3000);
    await page.waitForTimeout(1200);
  }

  const rows = await page.evaluate((playlistMeta) => {
    const chartDate = new Date().toISOString().slice(0, 10);

    const allText = (el) =>
      el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";

    const trackLinks = Array.from(document.querySelectorAll('a[href*="/track/"]'));
    const seen = new Set();
    const results = [];

    for (const link of trackLinks) {
      const href = link.href;
      if (!href || seen.has(href)) continue;

      const row =
        link.closest('[role="row"]') ||
        link.closest('div[draggable="true"]') ||
        link.parentElement;

      if (!row) continue;

      const trackTitle = allText(link);
      if (!trackTitle) continue;

      let artistName = "";
      const artistAnchors = Array.from(row.querySelectorAll('a[href*="/artist/"]'));

      if (artistAnchors.length > 0) {
        artistName = artistAnchors
          .map(a => allText(a))
          .filter(Boolean)
          .join(", ");
      }

      let rank = "";
      const rowText = allText(row);
      const rankMatch = rowText.match(/^(\d+)\s/);
      if (rankMatch) rank = rankMatch[1];

      seen.add(href);

      results.push({
        chart_date: chartDate,
        chart_key: playlistMeta.chart_key,
        chart_label: playlistMeta.chart_label,
        rank: rank || String(results.length + 1),
        track_title: trackTitle,
        artist_name: artistName,
        track_link: href
      });

      if (results.length >= playlistMeta.limit) break;
    }

    return results;
  }, playlist);

  return rows.slice(0, playlist.limit);
}

async function writeOutputs(allRows) {
  await ensureOutputDir();

  const date = todayStr();
  const jsonPath = path.join(OUTPUT_DIR, `raw_scrape_${date}.json`);
  const csvPath = path.join(OUTPUT_DIR, `raw_scrape_${date}.csv`);

  await fs.writeFile(jsonPath, JSON.stringify(allRows, null, 2), "utf8");

  const headers = [
    "chart_date",
    "chart_key",
    "chart_label",
    "rank",
    "track_title",
    "artist_name",
    "track_link"
  ];

 const csvLines = [
  headers.join("\t"),
  ...allRows.map(row =>
    headers
      .map(h =>
        String(row[h] ?? "")
          .replace(/\t/g, " ")
          .replace(/\n/g, " ")
          .replace(/\r/g, " ")
          .trim()
      )
      .join("\t")
  )
];
  
  await fs.writeFile(csvPath, csvLines.join("\n"), "utf8");

  console.log(`Saved ${jsonPath}`);
  console.log(`Saved ${csvPath}`);

  return { jsonPath, csvPath };
}

async function sendCsvToMake(csvPath) {
  const csvBuffer = await fs.readFile(csvPath);
  const filename = path.basename(csvPath);

  console.log(`Sending CSV to Make: ${filename}`);

  const response = await fetch(MAKE_WEBHOOK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/csv",
      "X-Filename": filename
    },
    body: csvBuffer
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Make webhook failed: ${response.status} ${text}`);
  }

  console.log("CSV sent to Make successfully");
}

async function main() {
  const playlists = await loadPlaylists();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const allRows = [];

  for (const playlist of playlists) {
    console.log(`Scraping ${playlist.chart_key} ...`);
    try {
      const rows = await scrapePlaylist(page, playlist);
      console.log(`  -> got ${rows.length} rows`);
      allRows.push(...rows);
    } catch (err) {
      console.error(`  -> failed: ${err.message}`);
    }
    await page.waitForTimeout(2000);
  }

  await browser.close();

  if (!allRows.length) {
    throw new Error("No rows scraped.");
  }

  const { csvPath } = await writeOutputs(allRows);
  await sendCsvToMake(csvPath);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
