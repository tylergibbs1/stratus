import { z } from "zod";
import { Agent, InterruptedRunResult, resumeRun, run, tool } from "../../src";
import {
	type AISDKUIMessage,
	approvalsFromAISDKMessages,
	toAISDKToolApprovalRequests,
} from "../../src/ai-sdk";
import { createRealSmokeModel, describeRealSmokeProvider } from "./openai-responses-smoke-model";
import { assertIncludes, logStep } from "./support";

export async function main(): Promise<void> {
	const model = createRealSmokeModel();
	const deleteFile = tool({
		name: "delete_file",
		description: "Pretend to delete a file from a workspace after user approval.",
		parameters: z.object({
			path: z.string().describe("Absolute file path to delete."),
			reason: z.string().describe("Why the file should be deleted."),
		}),
		needsApproval: true,
		execute: async (_context, { path }) => `approved-delete:${path}`,
	});
	const agent = new Agent({
		name: "approval_smoke_agent",
		instructions:
			"Use delete_file when the user asks to delete a file. After the tool result, reply with exactly approval-flow-ok.",
		model,
		tools: [deleteFile],
		modelSettings: {
			maxTokens: 256,
			reasoningEffort: "minimal",
			toolChoice: { type: "function", function: { name: "delete_file" } },
		},
	});

	const first = await run(
		agent,
		"Delete /tmp/stratus-demo.txt because this is a live approval smoke test.",
		{ maxTurns: 2 },
	);
	if (!(first instanceof InterruptedRunResult)) {
		throw new Error(`Expected an interrupted run, got output: ${first.output}`);
	}

	const approvalChunks = toAISDKToolApprovalRequests(first);
	const approvalMessage: AISDKUIMessage = {
		id: "approval-1",
		role: "assistant",
		parts: first.pendingToolCalls.map((pending) => ({
			type: `tool-${pending.toolName}`,
			toolCallId: pending.toolCallId,
			state: "approval-responded",
			input: pending.parsedArguments,
			approval: { approved: true },
		})),
	};
	const approvals = approvalsFromAISDKMessages([approvalMessage], first.pendingToolCalls);
	const resumed = await resumeRun(first, approvals, {
		maxTurns: 2,
		callModelInputFilter: ({ request }) => ({
			...request,
			modelSettings: { ...request.modelSettings, toolChoice: "auto" },
		}),
	});
	if (resumed.interrupted) {
		throw new Error("Expected approved run to finish after resume");
	}

	assertIncludes(resumed.output, "approval-flow-ok", "approval resume");
	logStep("provider", describeRealSmokeProvider());
	logStep("approval_chunks", approvalChunks);
	logStep("pending_tools", first.pendingToolCalls);
	logStep("resumed_output", resumed.output);
}

if (import.meta.main) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
