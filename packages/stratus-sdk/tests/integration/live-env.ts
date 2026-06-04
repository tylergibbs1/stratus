import { describe } from "bun:test";
import { AzureChatCompletionsModel } from "../../src/azure/chat-completions-model";
import { AzureResponsesModel } from "../../src/azure/responses-model";

const dummyEndpoint = "https://example.openai.azure.com";
const dummyApiKey = "test-key";

export const hasAzureChatEnv = Boolean(
	process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY,
);

export const hasAzureResponsesEnv = Boolean(
	(process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT) &&
		(process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY),
);

export const hasAzureChatAndResponsesEnv = hasAzureChatEnv && hasAzureResponsesEnv;

export const describeIfAzureChat = hasAzureChatEnv ? describe : describe.skip;
export const describeIfAzureResponses = hasAzureResponsesEnv ? describe : describe.skip;
export const describeIfAzureChatAndResponses = hasAzureChatAndResponsesEnv
	? describe
	: describe.skip;

export const azureChatEndpoint = process.env.AZURE_OPENAI_ENDPOINT ?? dummyEndpoint;
export const azureChatApiKey = process.env.AZURE_OPENAI_API_KEY ?? dummyApiKey;
export const azureChatDeployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat";
export const azureChatApiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";

export const azureResponsesEndpoint =
	process.env.AZURE_OPENAI_RESPONSES_ENDPOINT ?? process.env.AZURE_OPENAI_ENDPOINT ?? dummyEndpoint;
export const azureResponsesApiKey =
	process.env.AZURE_OPENAI_RESPONSES_API_KEY ?? process.env.AZURE_OPENAI_API_KEY ?? dummyApiKey;
export const azureResponsesDeployment =
	process.env.AZURE_OPENAI_RESPONSES_DEPLOYMENT ?? azureChatDeployment;

export function createLiveChatModel(): AzureChatCompletionsModel {
	return new AzureChatCompletionsModel({
		endpoint: azureChatEndpoint,
		apiKey: azureChatApiKey,
		deployment: azureChatDeployment,
		apiVersion: azureChatApiVersion,
	});
}

export function createLiveResponsesModel(options?: {
	deployment?: string;
	apiVersion?: string;
	store?: boolean;
}): AzureResponsesModel {
	return new AzureResponsesModel({
		endpoint: azureResponsesEndpoint,
		apiKey: azureResponsesApiKey,
		deployment: options?.deployment ?? azureResponsesDeployment,
		...(options?.apiVersion !== undefined ? { apiVersion: options.apiVersion } : {}),
		...(options?.store !== undefined ? { store: options.store } : {}),
	});
}
