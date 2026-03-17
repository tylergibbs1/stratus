import { z } from "zod";
import { Agent, AzureChatCompletionsModel, run, stream, tool } from "../src";

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

const getWeather = tool({
	name: "get_weather",
	description: "Get the current weather for a city",
	parameters: z.object({
		city: z.string().describe("The city name"),
	}),
	execute: async (_ctx, { city }) => {
		// Simulated weather data
		const temps: Record<string, string> = {
			"New York": "72°F, sunny",
			London: "18°C, cloudy",
			Tokyo: "28°C, humid",
		};
		return temps[city] ?? `Weather data not available for ${city}`;
	},
});

const agent = new Agent({
	name: "weather-assistant",
	instructions: "You are a helpful weather assistant. Use the get_weather tool to answer weather questions.",
	model,
	tools: [getWeather],
});

async function main() {
	console.log("=== Non-streaming ===\n");

	const result = await run(agent, "What's the weather in New York and Tokyo?");
	console.log("Output:", result.output);
	console.log("Usage:", result.usage);

	console.log("\n=== Streaming ===\n");

	process.stdout.write("Output: ");
	for await (const event of stream(agent, "What's the weather in London?").stream) {
		if (event.type === "content_delta") {
			process.stdout.write(event.content);
		} else if (event.type === "tool_call_start") {
			console.log(`\n[Calling tool: ${event.toolCall.name}]`);
		} else if (event.type === "done") {
			console.log("\n\nUsage:", event.response.usage);
		}
	}
}

main().catch(console.error);
