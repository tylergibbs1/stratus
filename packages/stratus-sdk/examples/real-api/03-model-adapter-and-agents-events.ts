import { Agent, stream } from "../../src";
import { toAISDKLanguageModel, toOpenAIAgentsStyleStreamEvents } from "../../src/ai-sdk";
import { createRealSmokeModel, describeRealSmokeProvider } from "./openai-responses-smoke-model";
import { assertIncludes, logStep } from "./support";

function contentText(
	content: Awaited<ReturnType<ReturnType<typeof toAISDKLanguageModel>["doGenerate"]>>["content"],
): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

export async function main(): Promise<void> {
	const model = createRealSmokeModel();
	const languageModel = toAISDKLanguageModel(model, {
		provider: "stratus-openai-smoke",
		modelId: describeRealSmokeProvider(),
	});
	const generated = await languageModel.doGenerate({
		messages: [{ role: "user", content: "Reply with exactly: ai-sdk-model-ok" }],
		maxOutputTokens: 256,
		reasoningEffort: "minimal",
	});
	const generatedText = contentText(generated.content);
	assertIncludes(generatedText, "ai-sdk-model-ok", "AI SDK language model adapter");

	const agent = new Agent({
		name: "agents_event_projection_smoke",
		instructions: "Return only the exact requested smoke marker. No punctuation.",
		model,
		modelSettings: { maxTokens: 256, reasoningEffort: "minimal" },
	});
	const streamed = stream(agent, "Reply with exactly: agents-event-ok", { maxTurns: 1 });
	const projectedEventTypes: string[] = [];
	const projectedItemNames: string[] = [];
	for await (const event of toOpenAIAgentsStyleStreamEvents(streamed.stream)) {
		projectedEventTypes.push(event.type);
		if (event.type === "run_item_stream_event") projectedItemNames.push(event.name);
	}
	const result = await streamed.result;
	assertIncludes(result.output, "agents-event-ok", "OpenAI Agents-style event projection");

	logStep("provider", describeRealSmokeProvider());
	logStep("adapter_text", generatedText);
	logStep("agents_events", projectedEventTypes);
	logStep("agents_items", projectedItemNames);
	logStep("agents_output", result.output);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
