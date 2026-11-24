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
/// <reference types="node" />
import "dotenv/config";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createAgent, tool, HumanMessage } from "langchain";
import { ChatGroq } from "@langchain/groq";
import { z } from "zod";
/* ------------------------------------------------------------------ */
/* Fail fast if the key isn't loaded (prints only a masked preview)    */
/* ------------------------------------------------------------------ */
const key = process.env.GROQ_API_KEY;
if (!key) {
    throw new Error("GROQ_API_KEY is not set. Put it in backend/.env");
}
console.log(`Using Groq key ${key.slice(0, 4)}...${key.slice(-3)} (len ${key.length})\n`);
/* ------------------------------------------------------------------ */
/* One shared model                                                    */
/* ------------------------------------------------------------------ */
const model = new ChatGroq({
    model: "openai/gpt-oss-120b",
    temperature: 0,
});
/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */
const weatherData = {
    NYC: "Currently 72°F with clear skies",
    Tokyo: "Currently 68°F with light rain",
    Paris: "Currently 59°F with cloudy skies",
};
// Maps whatever the model sends to the exact keys above.
const cityAliases = {
    nyc: "NYC",
    "new york": "NYC",
    "new york city": "NYC",
    "new york, ny": "NYC",
    tokyo: "Tokyo",
    paris: "Paris",
};
const weatherTool = tool(({ location }) => {
    const key = cityAliases[location.trim().toLowerCase()] ?? location;
    return weatherData[key] ?? `Weather data not available for ${location}`;
}, {
    name: "get_weather",
    description: "Get current weather for a city. Supported: NYC, Tokyo, Paris.",
    schema: z.object({
        location: z.string().describe("City name, e.g. NYC, Tokyo, or Paris"),
    }),
});
const calculateTool = tool(({ a, b, operation }) => {
    const operations = {
        add: (a, b) => a + b,
        subtract: (a, b) => a - b,
        multiply: (a, b) => a * b,
        divide: (a, b) => a / b,
    };
    const op = operations[operation];
    if (!op)
        return `Unknown operation: ${operation}`;
    if (operation === "divide" && b === 0)
        return "Cannot divide by zero";
    return `${a} ${operation} ${b} = ${op(a, b)}`;
}, {
    name: "calculator",
    description: "Perform basic math operations",
    schema: z.object({
        a: z.number().describe("First number"),
        b: z.number().describe("Second number"),
        operation: z
            .enum(["add", "subtract", "multiply", "divide"])
            .describe("Math operation"),
    }),
});
/* ------------------------------------------------------------------ */
/* Agent (no systemPrompt, no responseFormat: the config that works)   */
/* ------------------------------------------------------------------ */
const agent = createAgent({
    model,
    tools: [weatherTool, calculateTool],
});
/* ------------------------------------------------------------------ */
/* Example 1: stream full state after each step ("values")             */
/* ------------------------------------------------------------------ */
console.log("=== Example 1: Basic Streaming ===\n");
const stream = await agent.stream({ messages: [new HumanMessage("What's the weather in NYC?")] }, { streamMode: "values" });
for await (const chunk of stream) {
    const lastMessage = chunk.messages.at(-1);
    if (lastMessage?.getType() === "human") {
        console.log(`👤 Human: ${lastMessage.content}`);
    }
    else if (lastMessage?.getType() === "ai") {
        if (lastMessage.content) {
            console.log(`🤖 Assistant: ${lastMessage.content}`);
        }
        if ("tool_calls" in lastMessage &&
            Array.isArray(lastMessage.tool_calls) &&
            lastMessage.tool_calls.length > 0) {
            for (const toolCall of lastMessage.tool_calls) {
                console.log(`🔧 Calling tool: ${toolCall.name}`);
                console.log(`   Arguments:`, toolCall.args);
            }
        }
    }
    else if (lastMessage?.getType() === "tool") {
        console.log(`📊 Tool result: ${lastMessage.content}`);
    }
}
/* ------------------------------------------------------------------ */
/* Example 2: stream only the per-node updates ("updates")             */
/* ------------------------------------------------------------------ */
console.log("\n=== Example 2: Streaming Updates Only ===\n");
const updateStream = await agent.stream({ messages: [new HumanMessage("Calculate 42 multiply by 10")] }, { streamMode: "updates" });
for await (const chunk of updateStream) {
    const entry = Object.entries(chunk)[0];
    if (!entry)
        continue;
    const [nodeId, update] = entry;
    if (update && typeof update === "object" && "messages" in update) {
        const { messages } = update;
        for (const message of messages) {
            console.log(`Update from ${nodeId}:`, {
                type: message.getType(),
                content: message.content || "(tool call)",
                toolCalls: "tool_calls" in message ? message.tool_calls : undefined,
            });
        }
    }
}
/* ------------------------------------------------------------------ */
/* Example 3: multi-tool query                                         */
/* ------------------------------------------------------------------ */
console.log("\n=== Example 3: Streaming with Multiple Tools ===\n");
const multiToolStream = await agent.stream({
    messages: [
        new HumanMessage("What's the weather in NYC? If it's above 70°F, calculate how much warmer it is than 70."),
    ],
}, { streamMode: "values" });
let stepCount = 0;
for await (const chunk of multiToolStream) {
    stepCount += 1;
    const lastMessage = chunk.messages.at(-1);
    if (!lastMessage)
        continue;
    console.log(`Step ${stepCount}: ${lastMessage.getType()} message`);
    if (lastMessage.content) {
        console.log(`  Content: ${lastMessage.content.toString().substring(0, 100)}...`);
    }
    if ("tool_calls" in lastMessage &&
        Array.isArray(lastMessage.tool_calls) &&
        lastMessage.tool_calls.length > 0) {
        console.log(`  Tools called:`, lastMessage.tool_calls.map((tc) => tc.name));
    }
}
/* ------------------------------------------------------------------ */
/* Example 4: structured output, the Groq-safe two-step way            */
/*   Step A: agent does the tool work (no responseFormat)              */
/*   Step B: model.withStructuredOutput() turns the answer into JSON   */
/* ------------------------------------------------------------------ */
console.log("\n=== Example 4: Structured Output (two-step) ===\n");
const WeatherReport = z.object({
    location: z.string(),
    temperature: z.number().describe("Temperature in Fahrenheit"),
    conditions: z.string(),
});
const weatherAgent = createAgent({ model, tools: [weatherTool] });
const weatherStream = await weatherAgent.stream({ messages: [new HumanMessage("Get the weather for Tokyo")] }, { streamMode: "values" });
let finalState;
for await (const chunk of weatherStream) {
    console.log(`Processing step ${chunk.messages.length}...`);
    finalState = chunk;
}
// Message content can be a string or an array of content blocks.
const contentToText = (content) => typeof content === "string"
    ? content
    : Array.isArray(content)
        ? content
            .map((c) => (typeof c === "string" ? c : (c?.text ?? "")))
            .join("")
        : String(content ?? "");
const answerText = contentToText(finalState?.messages.at(-1)?.content);
const report = await model
    .withStructuredOutput(WeatherReport)
    .invoke(`Extract the weather report from this text:\n\n${answerText}`);
console.log("📋 Structured Response:", report);
/* ------------------------------------------------------------------ */
/* Save the graph diagram (Windows-safe path; non-fatal if it fails)   */
/* ------------------------------------------------------------------ */
try {
    const currentFile = fileURLToPath(import.meta.url);
    const outputPath = currentFile.replace(/\.[jt]s$/, ".png");
    console.log(`\nSaving visualization to: ${outputPath}`);
    const graph = await agent.drawMermaidPng();
    await writeFile(outputPath, Buffer.from(graph));
}
catch (err) {
    console.log("\n(Skipped diagram: drawMermaidPng needs internet access)", err.message);
}
//# sourceMappingURL=index.js.map