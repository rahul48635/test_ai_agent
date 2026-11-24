/**
 * Streaming with createAgent + Groq (all fixes applied)
 *
 * Fixes vs. the original:
 *  1. dotenv is the very first import; NO hardcoded API keys anywhere.
 *     ChatGroq reads GROQ_API_KEY from .env.
 *  2. One shared model for every agent (no per-agent apiKey overrides).
 *  3. Weather tool accepts aliases ("New York City", "nyc", ...) so the
 *     model can't fail on a name mismatch.
 *  4. Structured output on Groq is done in two steps (agent does the tool
 *     work, then model.withStructuredOutput() formats the answer). This
 *     avoids Groq's "json mode cannot be combined with tool calling" and
 *     "tool choice is required" errors from responseFormat.
 *  5. Windows-safe path handling for the diagram PNG, and a try/catch
 *     because drawMermaidPng() may need internet access.
 *  6. No systemPrompt that references tools which don't exist.
 */
import "dotenv/config";
//# sourceMappingURL=index.d.ts.map