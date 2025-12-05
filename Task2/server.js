import express from "express";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ES module path helpers
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────
// OpenAI Init (LLM for responses, summary, actions)
// ─────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("ERROR: OPENAI_API_KEY is not set in .env");
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Cheap, good model
const MODEL_NAME = "gpt-4o-mini";

// ─────────────────────────────────────────────
// Admin Auth (Basic Auth for internal dashboard)
// ─────────────────────────────────────────────

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "password123";

function adminAuth(req, res, next) {
  const authHeader = req.headers["authorization"] || "";
  const [type, value] = authHeader.split(" ");

  if (type === "Basic" && value) {
    const [user, pass] = Buffer.from(value, "base64").toString().split(":");
    if (user === ADMIN_USER && pass === ADMIN_PASS) {
      return next();
    }
  }

  res.set("WWW-Authenticate", 'Basic realm="Admin Area"');
  return res.status(401).send("Authentication required.");
}

// ─────────────────────────────────────────────
// JSON File Storage (shared by both dashboards)
// ─────────────────────────────────────────────

const DATA_FILE = path.join(__dirname, "feedback.json");

// Ensure feedback.json exists
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify([]));
}

function readFeedback() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8") || "[]";
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Storage] Error reading feedback file:", err);
    return [];
  }
}

function writeFeedback(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error("[Storage] Error writing feedback file:", err);
  }
}

// ─────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────

app.use(express.json());

// ─────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────

// Public root → user dashboard (public-facing)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "user.html"));
});

// Admin dashboard (internal-facing, requires auth)
app.get("/admin.html", adminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Admin API: get all feedback (internal-facing, requires auth)
app.get("/api/feedback", adminAuth, (req, res) => {
  const data = readFeedback();
  res.json(data);
});

// Public API: user submits feedback (LLM is used here, no auth)
app.post("/api/feedback", async (req, res) => {
  try {
    const { rating, review } = req.body;

    if (!rating || !review) {
      return res
        .status(400)
        .json({ error: "Both rating and review are required." });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({
        error: "OpenAI API key not configured on server.",
      });
    }

    const prompt = `
You are an AI assistant helping a product team.

User rating: ${rating} stars
User review: "${review}"

1. Write a short, friendly response back to the user (2–3 sentences).
2. Summarize the review in one sentence.
3. Suggest 2–4 concrete recommended next actions for the product/support team.

Return a strict JSON object with the following shape and nothing else:

{
  "userResponse": "...",
  "summary": "...",
  "recommendedActions": ["...", "..."]
}
`;

    const completion = await openai.chat.completions.create({
      model: MODEL_NAME,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
    });

    let rawText = completion.choices[0]?.message?.content?.trim() || "";

    // Clean possible ```json ... ``` wrapping
    rawText = rawText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    let aiResult;
    try {
      aiResult = JSON.parse(rawText);
    } catch (e) {
      console.error("[OpenAI] JSON parse error:", e, "Raw text:", rawText);
      aiResult = {
        userResponse:
          "Thank you for your feedback! Our team will review your comments.",
        summary: "AI summary unavailable (parse error).",
        recommendedActions: [
          "Manually review this feedback and decide appropriate follow-up.",
        ],
      };
    }

    const feedbackItem = {
      id: Date.now(),
      timestamp: new Date().toISOString(),
      rating,
      review,
      aiSummary: aiResult.summary,
      aiActions: aiResult.recommendedActions,
      aiUserResponse: aiResult.userResponse,
    };

    const data = readFeedback();
    data.push(feedbackItem);
    writeFeedback(data);

    return res.json({
      success: true,
      feedback: feedbackItem,
    });
  } catch (err) {
    console.error("Error in /api/feedback:", err);
    return res
      .status(500)
      .json({ error: "Server error while processing feedback." });
  }
});

// Static files (user.html, admin.html, etc.)
app.use(express.static(path.join(__dirname, "public")));

// ─────────────────────────────────────────────
// Start HTTP server
// ─────────────────────────────────────────────

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
