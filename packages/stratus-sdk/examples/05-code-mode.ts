/**
 * Code Mode example — the LLM writes code that orchestrates multiple API tools
 * in a single execution, instead of making individual tool calls with round-trips.
 *
 * Uses free public APIs (no keys needed):
 * - Open-Meteo for weather data
 * - RestCountries for country info
 * - IP-API for geolocation
 *
 * Run: bun examples/05-code-mode.ts
 */

import { z } from "zod";
import { Agent, AzureChatCompletionsModel, stream, tool } from "../src";
import { createCodeModeTool, WorkerExecutor } from "../src/core/codemode";

// ── Model ──────────────────────────────────────────────────────────

const model = new AzureChatCompletionsModel({
	endpoint: process.env.AZURE_OPENAI_ENDPOINT!,
	apiKey: process.env.AZURE_OPENAI_API_KEY!,
	deployment: process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-5-chat",
	apiVersion: process.env.AZURE_OPENAI_API_VERSION,
});

// ── Tools (real APIs) ──────────────────────────────────────────────

const getWeather = tool({
	name: "get_weather",
	description:
		"Get current weather for a location by latitude and longitude. Returns temperature (°C), wind speed, and weather description.",
	parameters: z.object({
		latitude: z.number().describe("Latitude of the location"),
		longitude: z.number().describe("Longitude of the location"),
	}),
	execute: async (_ctx, { latitude, longitude }) => {
		const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,wind_speed_10m,weather_code`;
		const res = await fetch(url);
		const data = await res.json();
		return JSON.stringify(data.current);
	},
});

const getCountryInfo = tool({
	name: "get_country_info",
	description:
		"Get information about a country by name. Returns capital, population, region, languages, and currencies.",
	parameters: z.object({
		country: z.string().describe("Country name (e.g. 'France', 'Japan')"),
	}),
	execute: async (_ctx, { country }) => {
		const url = `https://restcountries.com/v3.1/name/${encodeURIComponent(country)}?fields=name,capital,population,region,subregion,languages,currencies,latlng`;
		const res = await fetch(url);
		if (!res.ok) return JSON.stringify({ error: `Country "${country}" not found` });
		const data = await res.json();
		const c = data[0];
		return JSON.stringify({
			name: c.name.common,
			capital: c.capital?.[0],
			population: c.population,
			region: c.region,
			subregion: c.subregion,
			languages: c.languages,
			currencies: c.currencies,
			latlng: c.latlng,
		});
	},
});

const geocode = tool({
	name: "geocode",
	description: "Convert a city/place name to latitude and longitude coordinates.",
	parameters: z.object({
		query: z.string().describe("City or place name to geocode (e.g. 'Paris', 'Tokyo')"),
	}),
	execute: async (_ctx, { query }) => {
		const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1`;
		const res = await fetch(url);
		const data = await res.json();
		if (!data.results?.length) return JSON.stringify({ error: `Location "${query}" not found` });
		const r = data.results[0];
		return JSON.stringify({
			name: r.name,
			country: r.country,
			latitude: r.latitude,
			longitude: r.longitude,
		});
	},
});

// ── Code Mode setup ────────────────────────────────────────────────

const executor = new WorkerExecutor({ timeout: 30_000 });

const codemode = createCodeModeTool({
	tools: [getWeather, getCountryInfo, geocode],
	executor,
});

// ── Agent ──────────────────────────────────────────────────────────

const agent = new Agent({
	name: "travel-researcher",
	instructions: `You are a travel research assistant. When asked about destinations, use code mode to efficiently gather all the information in one go.

You have access to geocoding, weather, and country info APIs through the execute_code tool. Write code that calls multiple APIs in parallel using Promise.all when possible.

Always return structured, readable results.`,
	model,
	tools: [codemode],
});

// ── Run ────────────────────────────────────────────────────────────

async function main() {
	const prompt =
		"Compare Paris, Tokyo, and New York City as travel destinations right now. For each city, get the current weather and country info. Tell me which one has the nicest weather today.";

	console.log(`\n🔵 Prompt: ${prompt}\n`);
	console.log("─".repeat(60));
	console.log("Running with WorkerExecutor (isolated V8 context)...\n");

	const { stream: s, result } = stream(agent, prompt, {
		maxTurns: 5,
		runHooks: {
			onToolStart: ({ toolName }) => {
				console.log(`\n🔧 Tool call: ${toolName}`);
			},
			onToolEnd: ({ toolName, result: toolResult }) => {
				console.log(`✅ ${toolName} completed`);
				try {
					const parsed = JSON.parse(toolResult);
					if (parsed.code) {
						// Code mode result — show the generated code
						console.log("\n📜 Generated code:");
						console.log("┌" + "─".repeat(78) + "┐");
						for (const line of parsed.code.split("\n")) {
							console.log(`│ ${line.padEnd(77)}│`);
						}
						console.log("└" + "─".repeat(78) + "┘");
						// Show execution result
						console.log("\n📦 Execution result:");
						const pretty = JSON.stringify(parsed.result, null, 2);
						for (const line of pretty.split("\n")) {
							console.log(`   ${line}`);
						}
						if (parsed.logs?.length) {
							console.log("\n📋 Console logs:");
							for (const log of parsed.logs) {
								console.log(`   ${log}`);
							}
						}
					}
				} catch {
					// not JSON
				}
				console.log();
			},
		},
	});

	for await (const event of s) {
		if (event.type === "content_delta") {
			process.stdout.write(event.content);
		}
	}

	const final = await result;
	console.log("\n\n" + "─".repeat(60));
	console.log(`Turns: ${final.numTurns} | Tokens: ${final.usage.totalTokens}`);
}

main().catch(console.error);
