import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { ACTIONS } from "./Actions";

const Operation = z.object({
    tool: z.enum(["rename_identifier", "replace_block", "replace_all", "rewrite_function", "insert_comment"]),
    oldName: z.string().nullable(),
    newName: z.string().nullable(),
    search: z.string().nullable(),
    replace: z.string().nullable(),
    functionName: z.string().nullable(),
    functionCode: z.string().nullable(),
    line: z.number().nullable(),
    comment: z.string().nullable()
});

export const AgentResponseFormat = z.object({
    action: z.enum(Object.values(ACTIONS)),
    reason: z.string(),
    operations: z.array(Operation)
});

export type AgentResponse = z.infer<typeof AgentResponseFormat>;
export type AgentOperation = z.infer<typeof Operation>;

export class Editor {
    static async planAndEdit(outputFile: string, rewrittenFunctions: string[] = []): Promise<AgentResponse> {
        const rewrittenNotice = rewrittenFunctions.length > 0
            ? `\n\nALREADY REWRITTEN FUNCTIONS (do NOT rewrite these again — they are already clean):\n${rewrittenFunctions.map(f => `- ${f}`).join('\n')}\nFocus your efforts on functions NOT in this list. If all obfuscated functions have been rewritten, move on to rename_variables, replace_all, or other cleanup tasks.\n`
            : '';

        const prompt = `You are a JavaScript deobfuscation expert. Your mission: transform obfuscated code into clean, production-quality code that a human developer would write.

Deterministic transforms have already resolved hex/unicode literals and simple constant folding. What remains requires semantic understanding.

COMMON REMAINING PATTERNS (handle in priority order):
1. **Decoder function calls**: Functions like \`decode(613)\`, \`_0x323b(441)\` or local aliases like \`const _0x58c7a0 = decode\` followed by \`_0x58c7a0(636)\`. These resolve strings from an encoded array at the bottom of the file. Study the string array and the decoder's offset to figure out the resolved values, then use rewrite_function or replace_all to inline them.
2. **Proxy objects**: Objects like \`_0x2d12ea = { 'LoFbn': function(a,b){return a-b}, 'pjFRk': "some_string", ...}\` that wrap trivial operations. Their properties are then called via \`_0x2d12ea.LoFbn(x,y)\` or \`_0x2d12ea[_0x58c7a0(564)](x,y)\`. Inline these: replace the call with the direct operation.
3. **Obfuscated function bodies**: Functions whose purpose is clear from their name/comments but whose bodies are unreadable messes of proxy calls and decoder invocations. REWRITE THE ENTIRE FUNCTION using rewrite_function. You can understand what the function does from context — write the clean version.
4. **Obfuscated identifiers**: Variables like \`_0x30716d\`, \`_0x3a608f\`. Rename them to meaningful names.
5. **Dead code branches**: Obfuscators insert \`if("stringA" !== "stringB")\` or \`if("abc" === "def")\` branches where one path is dead code. Remove the dead branch entirely.

STRATEGY:
- Prefer rewrite_function for any function that has obfuscated internals. Write the clean version directly — do NOT try to fix it piece by piece.
- Use replace_all to bulk-replace decoder calls across the file (e.g. replace all \`decode(613)\` with \`"Creeper"\`).
- Use replace_block to remove dead code sections or inline proxy objects.
- Use rename_identifier for remaining obfuscated variable names.
- Focus on one function per iteration for rewrite_function. Start with the most obfuscated ones.

Available actions (in priority order):
1. rename_variables: Rename obfuscated identifiers to meaningful names using rename_identifier.
2. decode_custom_encoding: Resolve decoder calls, proxy objects, or custom encodings using replace_all/replace_block.
3. clean_function: Rewrite an obfuscated function with a clean implementation using rewrite_function.
4. reconstruct_control_flow: Remove dead branches, flatten dispatchers using replace_block.
5. add_comments: Add explanatory comments using insert_comment.
6. stop: ONLY when ALL functions are clean, ALL identifiers are meaningful, and NO obfuscation artifacts remain. If ANY _0x patterns, decode() calls, or proxy objects remain, do NOT stop.

Available tools:
1. rewrite_function — Replace an entire function with a clean rewrite. Finds the function by name and replaces it completely.${rewrittenNotice}
   {"tool": "rewrite_function", "functionName": "getEntityName", "functionCode": "function getEntityName(entity) {\\n  if (!entity) return null;\\n  ...\\n}"}
   For exported functions, include the export keyword: "export function foo() {...}"
   This is your most powerful tool. Use it aggressively on any function with obfuscated internals.
2. replace_all — Replace ALL occurrences of a string throughout the entire file.
   {"tool": "replace_all", "search": "decode(613)", "replace": "\\"Creeper\\""}
   Perfect for inlining decoder calls that appear many times.
3. rename_identifier — AST-aware rename of all references to a variable/function/param.
   {"tool": "rename_identifier", "oldName": "_0x3a2f", "newName": "userToken"}
4. replace_block — Replace the first exact match of a code block.
   {"tool": "replace_block", "search": "exact code to find", "replace": "replacement code"}
5. insert_comment — Insert a comment before a specific line.
   {"tool": "insert_comment", "line": 5, "comment": "Fetches user data from the API"}

Rules:
- You MUST produce operations. An empty operations array is only acceptable with action "stop".
- When using rewrite_function, the functionCode must be syntactically valid JavaScript.
- CRITICAL: Preserve ALL code paths, switch cases, if/else branches, and logic. Do NOT simplify or reduce the number of cases — only make them readable. A switch with 20 cases must still have 20 cases. Every string message, every return value, every branch must be preserved.
- Do NOT invent API calls or property names. If the original code accesses world.afterEvents.entityHurt, your rewrite must use the exact same API path. If you are uncertain about an API, keep the original access pattern.
- Parameter names in your rewrite must match how they are used in the function body. Do not introduce a parameter named one thing but reference a different name in the body.
- Be bold. Output is validated and reverted if broken.
- Batch multiple operations in one pass when possible.
- Set unused tool fields to null.
- The reason field will be shown to the user. Keep it concise but informative so they can follow along.

Code:
${outputFile}`;

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
                format: zodTextFormat(AgentResponseFormat, "agent_response")
            }
        });
        if (response.output_parsed == null)
            throw new Error("Failed to parse response from LLM");
        console.log("LLM response:", JSON.stringify(response.output_parsed));
        return response.output_parsed;
    }
}