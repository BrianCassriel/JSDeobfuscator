import { parse } from "acorn";

export class Validator {
    static validate(code: string): boolean {
        try {
            parse(code, { ecmaVersion: "latest", sourceType: "module" });
            return true;
        } catch (moduleError) {
            try {
                parse(code, { ecmaVersion: "latest", sourceType: "script" });
                return true;
            } catch {
                console.error("Validation error:", moduleError);
                return false;
            }
        }
    }
}