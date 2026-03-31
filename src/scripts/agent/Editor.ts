import OpenAI from "openai";
import type { Plan } from "./Planner";
import { zodTextFormat } from "openai/helpers/zod"
import { z } from "zod";
import { Memory } from "./Memory";

export const PatchFormat = z.object({
    startLine: z.number(),
    replacement: z.string(),
    reason: z.string()
});

export type Patch = z.infer<typeof PatchFormat>;

export class Editor {
    static async applyPlan(sourceFile: string, outputFile: string, plan: Plan): Promise<Patch> {
        const prompt = `
        You are deobfuscating JavaScript code.
        Perform the following action: ${plan.action}
        Preserve behavior. Do not change the functionality of the code. DO NOT rewrite the whole file at once.
        Source file:
        ${sourceFile}
        Output file:
        ${outputFile}
        `;
        const apiKey = import.meta.env.PUBLIC_OPENAI_API_KEY;
        if (!apiKey)
            throw new Error("PUBLIC_OPENAI_API_KEY is not set in .env");
        const openAI = new OpenAI({ apiKey, dangerouslyAllowBrowser: true }); // DON'T USE THIS IN PROD
        const response = await openAI.responses.parse({
            model: "gpt-5-nano",
            input: [
                { role: "system", content: prompt }
            ],
            text: {
                format: zodTextFormat(PatchFormat, "patch")
            }
        });
        if (response.output_parsed == null)
            throw new Error("Failed to parse patch from LLM response");
        console.log("LLM patch response:", JSON.stringify(response.output_parsed));
        return response.output_parsed;
    }
}