import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod";
import { Memory } from "./Memory";
import { AgentStatusUpdater } from "../AgentStatusUpdater";

export const PlanFormat = z.object({
    action: z.string(),
    reason: z.string()
});

export type Plan = z.infer<typeof PlanFormat>;

export class Planner {
    static async plan(outputFile: string, memory: Memory): Promise<Plan> {
        // const cheapPlan = this.cheapPlan(outputFile, memory);
        // if (cheapPlan !== null)
        //     return cheapPlan;
        const llmPlan = await this.llmPlan(outputFile);
        return llmPlan;
    }

    static cheapPlan(outputFile: string, memory: Memory): Plan | null {
        const stringTableMatch = outputFile.match(/var\s+(_0x[a-f0-9]+)\s*=\s*\[(.*?)\];/s);

        if (stringTableMatch && !memory.has(stringTableMatch[1])) {
            return {
                action: "decode_string_table",
                reason: `Found string table variable ${stringTableMatch[1]} that has not been decoded yet.`
            };
        }

        const hexLiteralMatch = outputFile.match(/\b0x[a-f0-9]+\b/i);
        if (hexLiteralMatch && !memory.has("decode_hex_literals")) {
            return {
                action: "decode_hex_literals",
                reason: "Found hex literal that has not been decoded yet."
            };
        }

        const identifierMatch = outputFile.match(/\b_0x[a-f0-9]{4,}\b/);
        if (identifierMatch && !memory.has(identifierMatch[0])) {
            return {
                action: "rename_identifier",
                reason: `Found obfuscated identifier ${identifierMatch[0]} that has not been renamed yet.`
            };
        }

        const iifeMatch = outputFile.match(/\(\s*function\s*\([^)]*\)\s*\{/);
        if (iifeMatch && !memory.has("unwrap_iife")) {
            return {
                action: "unwrap_iife",
                reason: "Found IIFE wrapper that has not been unwrapped yet."
            };
        }

        const unusedVarMatch = outputFile.match(/var\s+([a-zA-Z_$][\w$]*)\s*=.*?;/)
        if (unusedVarMatch && !memory.has("remove_dead_code")) {
            return {
                action: "remove_dead_code",
                reason: "Found unused variable that has not been removed yet."
            };
        }

        const redundantExprMatch = outputFile.match(/\+\s*0|\*\s*1/)
        if (redundantExprMatch && !memory.has("simplify_expression")) {
            return {
                action: "simplify_expression",
                reason: "Found redundant expression that can be simplified."
            };
        }

        if (!memory.has("format_code")) {
            return {
                action: "format_code",
                reason: "Code formatting can be improved."
            };
        }
        return null;
    }

    static async llmPlan(outputFile: string): Promise<Plan> {
        const prompt = `
        You are a JavaScript code deobfuscation planner. Given the working file:
        ${outputFile}
        Your task is to create a plan for a single next step in further deobfuscating the JavaScript code from the source file into the output file.
        Available actions:
        rename_identifier
        decode_hex_literals
        decode_string_table
        simplify_expression
        remove_dead_code
        unwrap_iife
        format_code
        stop
        `;
        const apiKey = import.meta.env.PUBLIC_OPENAI_API_KEY;
        if (!apiKey)
            throw new Error("PUBLIC_OPENAI_API_KEY is not set in .env");
        const openAI = new OpenAI({ apiKey, dangerouslyAllowBrowser: true }); // DON'T USE THIS IN PROD
        let response;
        try {
            response = await openAI.responses.parse({
                model: "gpt-5.4-nano",
                input: [
                    { role: "system", content: prompt }
                ],
                text: {
                    format: zodTextFormat(PlanFormat, "plan")
                }
            });
        } catch (error) {
            AgentStatusUpdater.error(`Failed to parse plan from LLM response: ${error}`);
            throw new Error("Failed to parse plan from LLM response");
        }
        if (response.output_parsed == null)
            throw new Error("Failed to parse plan from LLM response");
        console.log("LLM plan response:", JSON.stringify(response.output_parsed));
        return response.output_parsed;
    }
}