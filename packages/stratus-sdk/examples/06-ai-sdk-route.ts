import { z } from "zod";
import { Agent, createModel, tool } from "../src";
import { type AISDKUIMessage, createStratusChatResponse } from "../src/ai-sdk";

const model = createModel();

const getWeather = tool({
	name: "get_weather",
	description: "Get the current weather for a city",
	parameters: z.object({ city: z.string() }),
	execute: async (_context, { city }) => `72F and sunny in ${city}`,
});

const agent = new Agent({
	name: "weather_assistant",
	instructions: "You are a concise weather assistant.",
	model,
	tools: [getWeather],
});

// Next.js App Router example:
// export async function POST(req: Request) { ... }
export async function POST(req: Request): Promise<Response> {
	const { messages }: { messages: AISDKUIMessage[] } = await req.json();

	return createStratusChatResponse({
		agent,
		messages,
	});
}
