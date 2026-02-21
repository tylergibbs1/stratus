import { Agent, AzureChatCompletionsModel, run } from "../src";
import configs from "./test-models.json";

const name = process.argv[2];
const prompt = process.argv[3] || "What model are you? Reply in one sentence.";
const config = configs.find((c) => c.name === name) ?? configs[configs.length - 1]!;

console.log(`--- ${config.name} ---`);
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

const result = await run(agent, prompt);
console.log("Output:", result.output);
console.log("Usage:", result.usage);
