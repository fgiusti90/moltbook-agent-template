import dotenv from "dotenv";
dotenv.config();

/**
 * One-time registration script for your Moltbook agent.
 *
 * Usage:
 *   1. Fill in AGENT_NAME and AGENT_DESCRIPTION in .env
 *   2. Run: npm run register
 *   3. Save the API key to .env as MOLTBOOK_API_KEY
 *   4. Open the claim URL and tweet to verify
 */

const AGENT_NAME = process.env.AGENT_NAME;
const AGENT_DESCRIPTION = process.env.AGENT_DESCRIPTION || "An AI agent on Moltbook";

if (!AGENT_NAME) {
  console.error("❌ Set AGENT_NAME in your .env file first!");
  process.exit(1);
}

async function register() {
  console.log(`\n🦞 Registering agent "${AGENT_NAME}" on Moltbook...\n`);

  try {
    const response = await fetch("https://www.moltbook.com/api/v1/agents/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: AGENT_NAME,
        description: AGENT_DESCRIPTION,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("❌ Registration failed:", data);
      process.exit(1);
    }

    console.log("✅ Agent registered successfully!\n");
    console.log("═══════════════════════════════════════════");
    console.log("  SAVE THESE CREDENTIALS IMMEDIATELY:");
    console.log("═══════════════════════════════════════════");
    console.log(`  API Key:           ${data.agent?.api_key || "N/A"}`);
    console.log(`  Claim URL:         ${data.agent?.claim_url || "N/A"}`);
    console.log(`  Verification Code: ${data.agent?.verification_code || "N/A"}`);
    console.log("═══════════════════════════════════════════\n");

    console.log("📋 Next steps:");
    console.log("   1. Copy the API key to your .env file as MOLTBOOK_API_KEY");
    console.log("   2. Open the Claim URL in your browser");
    console.log("   3. Post the verification tweet from your X/Twitter account");
    console.log("   4. Once claimed, run: npm run dev  (to test)");
    console.log("   5. Then: npm start  (to run with cron scheduling)\n");

    // Also output in a format easy to copy
    console.log("─── Copy to .env ───");
    console.log(`MOLTBOOK_API_KEY=${data.agent?.api_key || "FILL_THIS"}`);
    console.log("────────────────────\n");
  } catch (err) {
    console.error("❌ Registration request failed:", err);
    process.exit(1);
  }
}

register();
