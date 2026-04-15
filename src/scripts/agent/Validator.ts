import { parse } from "acorn";

export class Validator {
    static validate(code: string): boolean {
        try {
            parse(code, { ecmaVersion: "latest", sourceType: "module" });
        } catch (error) {
            try {
                parse(code, { ecmaVersion: "latest", sourceType: "script" });
            } catch (fallbackError) {
                console.error("Validation error:", fallbackError);
                return false;
            }
        }
        return true;
    }
}