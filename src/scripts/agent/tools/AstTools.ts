import { parse, type Node } from 'acorn';
import { ancestor, simple } from 'acorn-walk';
import { generate } from 'escodegen';

type AnyNode = Node & Record<string, any>;

/**
 * AST-aware tools for code manipulation.
 * These operate on code strings and return transformed code strings.
 */
export class AstTools {
    /**
     * IDE-style rename: renames all references to an identifier, skipping
     * non-computed property keys and object keys (only renames variable
     * bindings, references, function names, params, etc).
     */
    static renameIdentifier(code: string, oldName: string, newName: string): string {
        let ast: AnyNode;
        try {
            ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as AnyNode;
        } catch {
            try {
                ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as AnyNode;
            } catch {
                return code;
            }
        }

        ancestor(ast, {
            Identifier(node: AnyNode, _state: unknown, ancestors: AnyNode[]) {
                if (node.name !== oldName) return;
                if (isPropertyKey(node, ancestors)) return;
                node.name = newName;
            }
        });

        return generate(ast);
    }

    /**
     * Insert a comment (// or block) before the given 1-based line number.
     */
    static insertComment(code: string, line: number, comment: string): string {
        const lines = code.split('\n');
        const idx = Math.max(0, Math.min(line - 1, lines.length));
        // Detect indentation of the target line
        const indent = lines[idx]?.match(/^(\s*)/)?.[1] ?? '';
        const formatted = comment.startsWith('/*')
            ? `${indent}${comment}`
            : `${indent}// ${comment}`;
        lines.splice(idx, 0, formatted);
        return lines.join('\n');
    }

    /**
     * Replace the first exact match of `search` with `replace`.
     */
    static replaceBlock(code: string, search: string, replace: string): string {
        const idx = code.indexOf(search);
        if (idx === -1) return code;
        return code.slice(0, idx) + replace + code.slice(idx + search.length);
    }

    /**
     * Replace ALL occurrences of `search` with `replace`.
     */
    static replaceAll(code: string, search: string, replace: string): string {
        if (!search) return code;
        let result = code;
        let idx = result.indexOf(search);
        while (idx !== -1) {
            result = result.slice(0, idx) + replace + result.slice(idx + search.length);
            idx = result.indexOf(search, idx + replace.length);
        }
        return result;
    }

    /**
     * Rewrite an entire function declaration or variable-assigned function.
     * Finds the function by name in the AST and replaces it with newCode.
     */
    static rewriteFunction(code: string, functionName: string, newCode: string): string {
        let ast: AnyNode;
        try {
            ast = parse(code, { ecmaVersion: 'latest', sourceType: 'module' }) as AnyNode;
        } catch {
            try {
                ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' }) as AnyNode;
            } catch {
                return code;
            }
        }

        let start = -1, end = -1;

        // Find export function first (so we capture the full export range)
        simple(ast, {
            ExportNamedDeclaration(node: AnyNode) {
                if (node.declaration?.type === 'FunctionDeclaration' &&
                    node.declaration.id?.name === functionName && start === -1) {
                    start = node.start;
                    end = node.end;
                }
            }
        });

        // Find standalone FunctionDeclaration (not inside export)
        if (start === -1) {
            ancestor(ast, {
                FunctionDeclaration(node: AnyNode, _state: unknown, ancestors: AnyNode[]) {
                    if (node.id?.name === functionName && start === -1) {
                        const parent = ancestors[ancestors.length - 2];
                        // Skip if parent is ExportNamedDeclaration (handled above)
                        if (parent?.type === 'ExportNamedDeclaration') return;
                        start = node.start;
                        end = node.end;
                    }
                }
            });
        }

        // Find variable-assigned function: const foo = function() {...}
        if (start === -1) {
            simple(ast, {
                VariableDeclaration(node: AnyNode) {
                    for (const decl of node.declarations) {
                        if (decl.id?.name === functionName &&
                            (decl.init?.type === 'FunctionExpression' || decl.init?.type === 'ArrowFunctionExpression') &&
                            start === -1) {
                            start = node.start;
                            end = node.end;
                        }
                    }
                }
            });
        }

        if (start === -1 || end === -1) return code;

        return code.slice(0, start) + newCode + code.slice(end);
    }
}

/**
 * Determines whether an Identifier node is being used as a non-computed
 * property key (obj.prop or { key: val }) — which should NOT be renamed.
 */
function isPropertyKey(node: AnyNode, ancestors: AnyNode[]): boolean {
    if (ancestors.length < 2) return false;
    const parent = ancestors[ancestors.length - 2];

    // obj.prop — skip "prop" (but not obj)
    if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node) {
        return true;
    }

    // { key: val } — skip "key" (unless shorthand like { key } which is both key and value)
    if (parent.type === 'Property' && parent.key === node && !parent.shorthand && !parent.computed) {
        return true;
    }

    // { method() {} } — method name in MethodDefinition
    if (parent.type === 'MethodDefinition' && parent.key === node && !parent.computed) {
        return true;
    }

    return false;
}
