import { Agent } from "../../src";
import { type AISDKUIMessage, createStratusChatResponse } from "../../src/ai-sdk";
import { createRealSmokeModel, describeRealSmokeProvider } from "./openai-responses-smoke-model";
import {
	assertHasChunk,
	assertIncludes,
	logStep,
	readUIMessageChunks,
	textFromChunks,
} from "./support";

export async function main(): Promise<void> {
	const model = createRealSmokeModel();
	const agent = new Agent({
		name: "real_chat_route_smoke",
		instructions: "Return only the exact requested smoke marker. No punctuation.",
		model,
		modelSettings: { maxTokens: 256, reasoningEffort: "minimal" },
	});
	const messages: AISDKUIMessage[] = [
		{
			id: "user-1",
			role: "user",
			parts: [{ type: "text", text: "Reply with exactly: stratus-live-ok" }],
		},
	];

	const response = createStratusChatResponse({
		agent,
		messages,
		messageId: "real-chat-response",
	});
	const chunks = await readUIMessageChunks(response);
	const text = textFromChunks(chunks);

	assertHasChunk(chunks, "start");
	assertHasChunk(chunks, "finish");
	assertIncludes(text, "stratus-live-ok", "chat response");
	logStep("provider", describeRealSmokeProvider());
	logStep("chat_text", text);
	logStep(
		"chat_chunks",
		chunks.map((chunk) => chunk.type),
	);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
