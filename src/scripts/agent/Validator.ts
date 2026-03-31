export class Validator {
    static validate(code: string): boolean {
        try {
            new Function(code);
        } catch (error) {
            console.error("Validation error:", error);
            return false;
        }
        return true;
    }
}