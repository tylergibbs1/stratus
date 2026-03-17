import { Agent, AzureChatCompletionsModel, run } from "../src";
import configs from "./test-models.json";

const prompt = process.argv[2] || "What model are you? Reply in one sentence.";

for (const config of configs) {
	console.log(`\n--- ${config.name} ---`);
	const model = new AzureChatCompletionsModel({
		endpoint: config.endpoint,
		apiKey: config.apiKey,
		deployment: config.deployment,
	});

	const agent = new Agent({
		name: "test",
		instructions: "You are a helpful assistant. Be concise.",
		model,
	});

	try {
		const result = await run(agent, prompt);
		console.log("Output:", result.output);
		console.log("Usage:", result.usage);
	} catch (err) {
		console.error("Error:", err instanceof Error ? err.message : err);
	}
}
