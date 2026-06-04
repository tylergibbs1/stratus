import { main as chatResponse } from "./01-chat-response";
import { main as toolApproval } from "./02-tool-approval";
import { main as modelAdapterAndAgentsEvents } from "./03-model-adapter-and-agents-events";

async function runStep(name: string, fn: () => Promise<void>): Promise<void> {
	console.log(`\n== ${name} ==`);
	await fn();
}

export async function main(): Promise<void> {
	await runStep("chat response", chatResponse);
	await runStep("tool approval", toolApproval);
	await runStep("model adapter and OpenAI Agents-style events", modelAdapterAndAgentsEvents);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
