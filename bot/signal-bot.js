// bot/signal-bot.js
// Run this on any computer or free server (Railway, Render, etc.)
// It checks markets every 30 minutes and pings you on Telegram if it finds edge

import Anthropic from "@anthropic-ai/sdk";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  // Paste your keys here (or use environment variables - safer!)
  ANTHROPIC_API_KEY:  process.env.ANTHROPIC_API_KEY  ?? "YOUR_ANTHROPIC_KEY",
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN ?? "YOUR_TELEGRAM_BOT_TOKEN",
  TELEGRAM_CHAT_ID:   process.env.TELEGRAM_CHAT_ID   ?? "YOUR_CHAT_ID",

  // Your Vercel proxy URL (after you deploy it)
  PROXY_URL: process.env.PROXY_URL ?? "https://your-app.vercel.app",

  // Only alert me if AI confidence is above this %
  EDGE_THRESHOLD: 70,

  // How many markets to analyze per category per run
  MARKETS_PER_CATEGORY: 5,

  // Run every X minutes
  INTERVAL_MINUTES: 30,

  // Which categories to scan
  CATEGORIES: ["crypto", "basketball", "weather"],
};
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: CONFIG.ANTHROPIC_API_KEY });

// ── STEP 1: Fetch live markets from your Vercel proxy ────────────────────────
async function fetchMarkets(category) {
  const url = `${CONFIG.PROXY_URL}/api/markets?category=${category}&limit=${CONFIG.MARKETS_PER_CATEGORY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${category} markets`);
  const data = await res.json();
  return Array.isArray(data) ? data : data.markets ?? [];
}

// ── STEP 2: Ask Claude to analyze a market using web search ──────────────────
async function analyzeMarket(market) {
  const prob = Math.round((market.outcomePrices?.[0] ?? 0.5) * 100);

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 800,
    tools: [{ type: "web_search_20250305", name: "web_search" }],
    system: `You are a prediction market analyst finding edges.
Return ONLY valid JSON — no markdown, no backticks, no extra text.
JSON fields:
- confidence: integer 0-100 (your confidence YES wins based on real evidence)
- verdict: "YES" | "NO" | "SKIP" (your call on the bet direction)
- summary: 1 sentence of key evidence
- edge: 1 sentence on why this is mispriced vs the market
- category: the type of market (crypto/sports/weather/politics/other)`,
    messages: [{
      role: "user",
      content: `Analyze this Polymarket prediction:
"${market.question}"
Market price: YES = ${prob}% probability
Search for current information and give me your analysis as JSON.`,
    }],
  });

  // Extract text from response (Claude may use web search first)
  const text = response.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const clean = text.replace(/```json|```/g, "").trim();

  try {
    return JSON.parse(clean);
  } catch {
    return { confidence: 0, verdict: "SKIP", summary: "Parse error", edge: "", category: "other" };
  }
}

// ── STEP 3: Send a Telegram message ──────────────────────────────────────────
async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CONFIG.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: "HTML",  // lets us use bold, italic in messages
    }),
  });
  if (!res.ok) console.error("Telegram send failed:", await res.text());
}

// ── Format a signal alert message ────────────────────────────────────────────
function formatAlert(market, analysis, category) {
  const prob    = Math.round((market.outcomePrices?.[0] ?? 0.5) * 100);
  const emoji   = { crypto: "₿", basketball: "🏀", weather: "🌦", sports: "⚽" }[category] ?? "📊";
  const confBar = "█".repeat(Math.floor(analysis.confidence / 10)) + "░".repeat(10 - Math.floor(analysis.confidence / 10));
  const verdictEmoji = analysis.verdict === "YES" ? "🟢" : analysis.verdict === "NO" ? "🔴" : "⚪";

  return `
🚨 <b>HIGH EDGE SIGNAL DETECTED</b>

${emoji} <b>${category.toUpperCase()}</b>
📋 <i>${market.question}</i>

${verdictEmoji} <b>Verdict: ${analysis.verdict}</b>
📈 Market says: YES = ${prob}%
🧠 AI confidence: ${analysis.confidence}%
${confBar}

💡 <b>Evidence:</b> ${analysis.summary}
⚡ <b>Edge:</b> ${analysis.edge}

${market.url ? `🔗 <a href="${market.url}">View on Polymarket</a>` : "🔗 polymarket.com"}
──────────────────────
`.trim();
}

// ── MAIN SCAN LOOP ────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`\n[${new Date().toISOString()}] Starting market scan...`);

  const signals = [];

  for (const category of CONFIG.CATEGORIES) {
    console.log(`  Fetching ${category} markets...`);

    let markets = [];
    try {
      markets = await fetchMarkets(category);
    } catch (err) {
      console.error(`  ❌ Failed to fetch ${category}:`, err.message);
      continue;
    }

    console.log(`  Found ${markets.length} markets. Analyzing...`);

    for (const market of markets) {
      try {
        const analysis = await analyzeMarket(market);
        console.log(`    "${market.question?.slice(0, 50)}..." → ${analysis.confidence}% (${analysis.verdict})`);

        if (analysis.confidence >= CONFIG.EDGE_THRESHOLD && analysis.verdict !== "SKIP") {
          signals.push({ market, analysis, category });
        }

        // Small delay between API calls to avoid rate limits
        await sleep(2000);
      } catch (err) {
        console.error(`    ❌ Analysis failed:`, err.message);
      }
    }
  }

  // Send results to Telegram
  if (signals.length === 0) {
    console.log("  No high-edge signals found this run.");
    // Optional: send a "no signals" ping so you know the bot is alive
    // await sendTelegram("🤖 Scan complete — no high-edge signals found.");
  } else {
    console.log(`  ✅ Found ${signals.length} high-edge signal(s)! Sending to Telegram...`);

    // Send header
    await sendTelegram(
      `🤖 <b>Polymarket Signal Bot</b>\n📡 Scan complete — <b>${signals.length} high-edge signal${signals.length > 1 ? "s" : ""}</b> found!\n⏰ ${new Date().toUTCString()}`
    );

    // Send each signal
    for (const { market, analysis, category } of signals) {
      await sendTelegram(formatAlert(market, analysis, category));
      await sleep(500);
    }
  }

  console.log(`  Done. Next scan in ${CONFIG.INTERVAL_MINUTES} minutes.`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── STARTUP ───────────────────────────────────────────────────────────────────
async function start() {
  console.log("🤖 Polymarket Signal Bot starting...");
  console.log(`   Categories: ${CONFIG.CATEGORIES.join(", ")}`);
  console.log(`   Edge threshold: ${CONFIG.EDGE_THRESHOLD}%`);
  console.log(`   Scan interval: every ${CONFIG.INTERVAL_MINUTES} minutes\n`);

  // Send startup message to Telegram
  await sendTelegram("🤖 <b>Polymarket Signal Bot is online!</b>\n📡 Scanning markets every 30 minutes...");

  // Run immediately on start, then on interval
  await runScan();
  setInterval(runScan, CONFIG.INTERVAL_MINUTES * 60 * 1000);
}

start().catch(console.error);
