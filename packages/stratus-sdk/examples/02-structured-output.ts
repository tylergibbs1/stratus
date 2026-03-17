import { z } from "zod";
import { Agent, AzureChatCompletionsModel, run } from "../src";

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

const PersonSchema = z.object({
	name: z.string().describe("The person's full name"),
	age: z.number().describe("The person's age"),
	occupation: z.string().describe("The person's occupation"),
});

const agent = new Agent({
	name: "person-extractor",
	instructions:
		"Extract person information from the user's message. Return structured data about the person described.",
	model,
	outputType: PersonSchema,
});

async function main() {
	const result = await run(
		agent,
		"Tell me about Marie Curie. She was 66 when she died and worked as a physicist and chemist.",
	);

	console.log("Raw output:", result.output);
	console.log("Parsed output:", result.finalOutput);
	console.log("Name:", result.finalOutput?.name);
	console.log("Age:", result.finalOutput?.age);
	console.log("Occupation:", result.finalOutput?.occupation);
}

main().catch(console.error);
