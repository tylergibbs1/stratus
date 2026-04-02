import { StratusError } from "../core/errors";
import type { Model } from "../core/model";
import { AzureChatCompletionsModel } from "./chat-completions-model";
import { AzureResponsesModel } from "./responses-model";

export type ModelType = "responses" | "chat-completions";

export interface CreateModelOptions {
	endpoint?: string;
	apiKey?: string;
	azureAdTokenProvider?: () => Promise<string>;
	deployment?: string;
	apiVersion?: string;
	maxRetries?: number;
	/** Only for AzureResponsesModel */
	store?: boolean;
}

export function createModel(type?: ModelType, options?: CreateModelOptions): Model;
export function createModel(options?: CreateModelOptions): Model;
export function createModel(
	typeOrOptions?: ModelType | CreateModelOptions,
	maybeOptions?: CreateModelOptions,
): Model {
	let type: ModelType = "responses";
	let options: CreateModelOptions = {};

	if (typeof typeOrOptions === "string") {
		type = typeOrOptions;
		options = maybeOptions ?? {};
	} else if (typeOrOptions) {
		options = typeOrOptions;
	}

	const endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT;
	const apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY;
	const deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT;
	const apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION;
	const tokenProvider = options.azureAdTokenProvider;

	if (!endpoint) {
		throw new StratusError(
			"Missing Azure OpenAI endpoint. Set AZURE_OPENAI_ENDPOINT or pass options.endpoint.",
		);
	}
	if (!deployment) {
		throw new StratusError(
			"Missing Azure OpenAI deployment. Set AZURE_OPENAI_DEPLOYMENT or pass options.deployment.",
		);
	}
	if (!apiKey && !tokenProvider) {
		throw new StratusError(
			"Missing Azure OpenAI credentials. Set AZURE_OPENAI_API_KEY or pass options.apiKey / options.azureAdTokenProvider.",
		);
	}

	const baseConfig = {
		endpoint,
		deployment,
		...(apiKey ? { apiKey } : {}),
		...(tokenProvider ? { azureAdTokenProvider: tokenProvider } : {}),
		...(apiVersion ? { apiVersion } : {}),
		...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
	};

	if (type === "chat-completions") {
		return new AzureChatCompletionsModel(baseConfig);
	}
	return new AzureResponsesModel({
		...baseConfig,
		...(options.store !== undefined ? { store: options.store } : {}),
	});
}
