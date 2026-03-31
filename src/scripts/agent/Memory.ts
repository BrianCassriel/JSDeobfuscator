export class Memory {
    attemptedActions: Set<string> = new Set();

    add(action: string): void {
        this.attemptedActions.add(action);
    }

    has(action: string): boolean {
        return this.attemptedActions.has(action);
    }
}