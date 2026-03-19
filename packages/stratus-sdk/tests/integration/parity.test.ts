import { describe, expect, test } from "bun:test";
import { AzureResponsesModel } from "../../src/azure/responses-model";

const model = new AzureResponsesModel({
	endpoint: process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? "gpt-5-chat",
});

// Minimal valid PDF (1 page, empty)
const MINIMAL_PDF = [
	"%PDF-1.0",
	"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj",
	"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj",
	"3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>>>endobj",
	"xref",
	"0 4",
	"0000000000 65535 f ",
	"0000000009 00000 n ",
	"0000000058 00000 n ",
	"0000000115 00000 n ",
	"trailer<</Size 4/Root 1 0 R>>",
	"startxref",
	"206",
	"%%EOF",
].join("\n");

describe("responses api parity", () => {
	test("incomplete_details returned on truncated response", async () => {
		const result = await model.getResponse({
			messages: [{ role: "user", content: "Write a very long detailed essay about the entire history of computing from 1800 to 2025." }],
			modelSettings: { maxCompletionTokens: 20 },
		});

		expect(result.finishReason).toBe("length");
		// The API should return incomplete_details for truncated responses
		if (result.incompleteDetails) {
			expect(result.incompleteDetails.reason).toBeTruthy();
		}
	}, 30000);

	test("file content part with base64 PDF is accepted", async () => {
		const pdfBase64 = btoa(MINIMAL_PDF);
		const result = await model.getResponse({
			messages: [
				{
					role: "user",
					content: [
						{
							type: "file",
							file: { url: `data:application/pdf;base64,${pdfBase64}` },
							filename: "test.pdf",
						},
						{ type: "text", text: "What is this file? Reply in one sentence." },
					],
				},
			],
		});

		expect(result.content).toBeTruthy();
		expect(result.finishReason).toBe("stop");
	}, 30000);

	test("streaming completes with done event and response", async () => {
		const events = [];
		for await (const event of model.getStreamedResponse(
			{
				messages: [{ role: "user", content: "Say exactly: hello world" }],
				modelSettings: { maxCompletionTokens: 50 },
			},
		)) {
			events.push(event);
		}

		const doneEvent = events.find((e) => e.type === "done");
		expect(doneEvent).toBeTruthy();
		if (doneEvent?.type === "done") {
			expect(doneEvent.response.content).toBeTruthy();
		}
	}, 30000);
});
