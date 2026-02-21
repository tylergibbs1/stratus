import { z } from "zod";
import { Agent, AzureChatCompletionsModel, handoff, run, tool } from "../src";

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

const lookupOrder = tool({
	name: "lookup_order",
	description: "Look up an order by ID",
	parameters: z.object({ orderId: z.string().describe("The order ID") }),
	execute: async (_ctx, { orderId }) =>
		JSON.stringify({ orderId, status: "shipped", eta: "2 days" }),
});

const refundOrder = tool({
	name: "refund_order",
	description: "Process a refund for an order",
	parameters: z.object({ orderId: z.string().describe("The order ID to refund") }),
	execute: async (_ctx, { orderId }) =>
		JSON.stringify({ orderId, refundStatus: "processed", amount: "$49.99" }),
});

const orderAgent = new Agent({
	name: "order_specialist",
	instructions:
		"You are an order specialist. Help users with order status inquiries using the lookup_order tool.",
	model,
	tools: [lookupOrder],
	handoffDescription: "Transfer to order specialist for order status and tracking questions",
});

const refundAgent = new Agent({
	name: "refund_specialist",
	instructions:
		"You are a refund specialist. Help users process refunds using the refund_order tool.",
	model,
	tools: [refundOrder],
	handoffDescription: "Transfer to refund specialist for refund and return requests",
});

const triageAgent = new Agent({
	name: "triage",
	instructions: `You are a customer service triage agent. Route customers to the right specialist:
- For order status/tracking questions, transfer to the order specialist
- For refund/return requests, transfer to the refund specialist
Do NOT try to answer questions yourself. Always transfer to the right specialist.`,
	model,
	handoffs: [
		handoff({
			agent: orderAgent,
			onHandoff: () => console.log("[Handoff] Transferring to order specialist..."),
		}),
		handoff({
			agent: refundAgent,
			onHandoff: () => console.log("[Handoff] Transferring to refund specialist..."),
		}),
	],
});

async function main() {
	console.log("=== Order Inquiry ===\n");
	const result1 = await run(triageAgent, "Where is my order #12345?");
	console.log("Output:", result1.output);
	console.log("Handled by:", result1.lastAgent.name);

	console.log("\n=== Refund Request ===\n");
	const result2 = await run(triageAgent, "I want a refund for order #67890");
	console.log("Output:", result2.output);
	console.log("Handled by:", result2.lastAgent.name);
}

main().catch(console.error);
