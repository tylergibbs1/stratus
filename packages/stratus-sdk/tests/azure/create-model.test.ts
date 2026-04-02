import { afterEach, describe, expect, test } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { createModel } from "../../src/azure/create-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";
import { StratusError } from "../../src/core/errors";

const savedEnv: Record<string, string | undefined> = {};

function setEnv(vars: Record<string, string>) {
	for (const [key, value] of Object.entries(vars)) {
		savedEnv[key] = process.env[key];
		process.env[key] = value;
	}
}

function clearEnv(...keys: string[]) {
	for (const key of keys) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
}

afterEach(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
});

describe("createModel with explicit options", () => {
	test("returns AzureResponsesModel by default", () => {
		const model = createModel({
			endpoint: "https://test.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
		});
		expect(model).toBeInstanceOf(AzureResponsesModel);
	});

	test("returns AzureChatCompletionsModel when specified", () => {
		const model = createModel("chat-completions", {
			endpoint: "https://test.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
		});
		expect(model).toBeInstanceOf(AzureChatCompletionsModel);
	});

	test("returns AzureResponsesModel when explicitly specified", () => {
		const model = createModel("responses", {
			endpoint: "https://test.openai.azure.com",
			apiKey: "key",
			deployment: "gpt-4o",
		});
		expect(model).toBeInstanceOf(AzureResponsesModel);
	});
});

describe("createModel with env vars", () => {
	test("reads from environment variables", () => {
		setEnv({
			AZURE_OPENAI_ENDPOINT: "https://env.openai.azure.com",
			AZURE_OPENAI_API_KEY: "env-key",
			AZURE_OPENAI_DEPLOYMENT: "env-deployment",
		});

		const model = createModel();
		expect(model).toBeInstanceOf(AzureResponsesModel);
	});

	test("explicit options override env vars", () => {
		setEnv({
			AZURE_OPENAI_ENDPOINT: "https://env.openai.azure.com",
			AZURE_OPENAI_API_KEY: "env-key",
			AZURE_OPENAI_DEPLOYMENT: "env-deployment",
		});

		const model = createModel({
			endpoint: "https://explicit.openai.azure.com",
			apiKey: "explicit-key",
			deployment: "explicit-deployment",
		});
		expect(model).toBeInstanceOf(AzureResponsesModel);
	});
});

describe("createModel error messages", () => {
	test("throws when endpoint is missing", () => {
		clearEnv("AZURE_OPENAI_ENDPOINT");
		expect(() => createModel({ apiKey: "key", deployment: "dep" })).toThrow(StratusError);
		expect(() => createModel({ apiKey: "key", deployment: "dep" })).toThrow(
			"AZURE_OPENAI_ENDPOINT",
		);
	});

	test("throws when deployment is missing", () => {
		clearEnv("AZURE_OPENAI_DEPLOYMENT");
		expect(() => createModel({ endpoint: "https://test.openai.azure.com", apiKey: "key" })).toThrow(
			"AZURE_OPENAI_DEPLOYMENT",
		);
	});

	test("throws when credentials are missing", () => {
		clearEnv("AZURE_OPENAI_API_KEY");
		expect(() =>
			createModel({
				endpoint: "https://test.openai.azure.com",
				deployment: "dep",
			}),
		).toThrow("AZURE_OPENAI_API_KEY");
	});
});
